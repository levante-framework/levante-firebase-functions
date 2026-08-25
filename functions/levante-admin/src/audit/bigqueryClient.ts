import {
  AUDIT_DATASET,
  AUDIT_WRITES_TABLE,
  type AuditJournalQueryResult,
  type AuditJournalReader,
  type JournalRow,
  type JournalWriter,
  type RequiredAuditJournalQueryParams,
} from "./types.js";

type FetchLike = typeof fetch;
type TokenProvider = () => Promise<string>;
type BigQueryParameterType = "BOOL" | "INT64" | "STRING" | "TIMESTAMP";

type BigQueryQueryParameter = {
  name: string;
  parameterType: { type: BigQueryParameterType };
  parameterValue: { value: string };
};

type BigQueryQueryResponse = {
  jobComplete?: boolean;
  pageToken?: string;
  schema?: { fields?: Array<{ name: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  errors?: Array<{ message?: string }>;
};

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export const getProjectId = (): string => {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
  if (!projectId) {
    throw new Error("GCLOUD_PROJECT is required to write audit journal rows");
  }
  return projectId;
};

export const getMetadataAccessToken = async (
  fetchImpl: FetchLike = fetch
): Promise<string> => {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });

  if (!response.ok) {
    throw new Error(`Metadata token request failed with ${response.status}`);
  }

  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("Metadata token response did not include access_token");
  }

  return body.access_token;
};

export class BigQueryJournalWriter implements JournalWriter {
  private readonly fetchImpl: FetchLike;
  private readonly getAccessToken: TokenProvider;
  private readonly projectId?: string;

  constructor({
    fetchImpl = fetch,
    getAccessToken = () => getMetadataAccessToken(fetchImpl),
    projectId,
  }: {
    fetchImpl?: FetchLike;
    getAccessToken?: TokenProvider;
    projectId?: string;
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
    this.projectId = projectId;
  }

  async insert(row: JournalRow): Promise<void> {
    const accessToken = await this.getAccessToken();
    const projectId = this.projectId ?? getProjectId();
    const url = new URL(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${AUDIT_DATASET}/tables/${AUDIT_WRITES_TABLE}/insertAll`
    );

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rows: [{ insertId: row.event_id, json: row }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `BigQuery insertAll failed with ${
          response.status
        }: ${await response.text()}`
      );
    }
  }
}

const queryEndpoint = (projectId: string): URL =>
  new URL(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`
  );

const authHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

const queryParameter = (
  name: string,
  type: BigQueryParameterType,
  value: string | number | boolean
): BigQueryQueryParameter => ({
  name,
  parameterType: { type },
  parameterValue: { value: String(value) },
});

const rowValue = (
  row: Record<string, unknown>,
  key: keyof JournalRow
): string | null => {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const rowBool = (
  row: Record<string, unknown>,
  key: keyof JournalRow
): boolean => row[key] === true || row[key] === "true";

const rowNumber = (
  row: Record<string, unknown>,
  key: keyof JournalRow
): number => Number(row[key] ?? 0);

const mapQueryRows = (response: BigQueryQueryResponse): JournalRow[] => {
  const fields = response.schema?.fields ?? [];
  const rows = response.rows ?? [];

  return rows.map((row) => {
    const mapped = Object.fromEntries(
      row.f.map((field, index) => [fields[index]?.name, field.v])
    ) as Record<string, unknown>;

    return {
      event_id: rowValue(mapped, "event_id") ?? "",
      commit_timestamp: rowValue(mapped, "commit_timestamp") ?? "",
      ingest_timestamp: rowValue(mapped, "ingest_timestamp") ?? "",
      resource_path: rowValue(mapped, "resource_path") ?? "",
      operation: (rowValue(mapped, "operation") ??
        "update") as JournalRow["operation"],
      actor: rowValue(mapped, "actor"),
      request_id: rowValue(mapped, "request_id"),
      before_json: rowValue(mapped, "before_json"),
      after_json: rowValue(mapped, "after_json"),
      payload_bytes: rowNumber(mapped, "payload_bytes"),
      payload_truncated: rowBool(mapped, "payload_truncated"),
      payload_sha256: rowValue(mapped, "payload_sha256"),
    };
  });
};

export const buildAuditJournalQuery = (
  projectId: string,
  params: RequiredAuditJournalQueryParams
): { query: string; queryParameters: BigQueryQueryParameter[] } => {
  const payloadColumns = params.includePayloads
    ? [
        "TO_JSON_STRING(before_json) AS before_json",
        "TO_JSON_STRING(after_json) AS after_json",
      ]
    : [
        "CAST(NULL AS STRING) AS before_json",
        "CAST(NULL AS STRING) AS after_json",
      ];
  const whereClauses = [
    "commit_timestamp >= @startTime",
    "commit_timestamp <= @endTime",
  ];
  const queryParameters = [
    queryParameter("startTime", "TIMESTAMP", params.startTime),
    queryParameter("endTime", "TIMESTAMP", params.endTime),
    queryParameter("limit", "INT64", params.limit),
  ];

  if (params.resourcePath) {
    whereClauses.push("resource_path = @resourcePath");
    queryParameters.push(
      queryParameter("resourcePath", "STRING", params.resourcePath)
    );
  }
  if (params.resourcePathPrefix) {
    whereClauses.push("STARTS_WITH(resource_path, @resourcePathPrefix)");
    queryParameters.push(
      queryParameter("resourcePathPrefix", "STRING", params.resourcePathPrefix)
    );
  }
  if (params.operation) {
    whereClauses.push("operation = @operation");
    queryParameters.push(
      queryParameter("operation", "STRING", params.operation)
    );
  }
  if (params.actor) {
    whereClauses.push("actor = @actor");
    queryParameters.push(queryParameter("actor", "STRING", params.actor));
  }
  if (params.requestId) {
    whereClauses.push("request_id = @requestId");
    queryParameters.push(
      queryParameter("requestId", "STRING", params.requestId)
    );
  }
  if (params.payloadTruncated !== null) {
    whereClauses.push("payload_truncated = @payloadTruncated");
    queryParameters.push(
      queryParameter("payloadTruncated", "BOOL", params.payloadTruncated)
    );
  }

  return {
    query: `
      SELECT
        event_id,
        FORMAT_TIMESTAMP('%FT%T%Ez', commit_timestamp) AS commit_timestamp,
        FORMAT_TIMESTAMP('%FT%T%Ez', ingest_timestamp) AS ingest_timestamp,
        resource_path,
        operation,
        actor,
        request_id,
        ${payloadColumns.join(",\n        ")},
        payload_bytes,
        payload_truncated,
        payload_sha256
      FROM \`${projectId}.${AUDIT_DATASET}.${AUDIT_WRITES_TABLE}\`
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY commit_timestamp DESC
      LIMIT @limit
    `,
    queryParameters,
  };
};

export class BigQueryAuditJournalReader implements AuditJournalReader {
  private readonly fetchImpl: FetchLike;
  private readonly getAccessToken: TokenProvider;
  private readonly projectId?: string;

  constructor({
    fetchImpl = fetch,
    getAccessToken = () => getMetadataAccessToken(fetchImpl),
    projectId,
  }: {
    fetchImpl?: FetchLike;
    getAccessToken?: TokenProvider;
    projectId?: string;
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
    this.projectId = projectId;
  }

  async query(
    params: RequiredAuditJournalQueryParams
  ): Promise<AuditJournalQueryResult> {
    const accessToken = await this.getAccessToken();
    const projectId = this.projectId ?? getProjectId();
    const { query, queryParameters } = buildAuditJournalQuery(
      projectId,
      params
    );
    const response = await this.fetchImpl(queryEndpoint(projectId), {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        query,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters,
        maxResults: params.limit,
        ...(params.pageToken && { pageToken: params.pageToken }),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `BigQuery query failed with ${
          response.status
        }: ${await response.text()}`
      );
    }

    const body = (await response.json()) as BigQueryQueryResponse;
    if (body.jobComplete === false) {
      throw new Error("BigQuery query did not complete synchronously");
    }
    if (body.errors?.length) {
      throw new Error(
        `BigQuery query failed: ${body.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ")}`
      );
    }

    return {
      rows: mapQueryRows(body),
      ...(body.pageToken && { nextPageToken: body.pageToken }),
    };
  }
}
