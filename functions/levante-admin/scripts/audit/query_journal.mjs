#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const DATASET = "levante_audit";
const TABLE = "writes_journal";
const DEFAULT_PROJECT = "hs-levante-admin-dev";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const usage = `
Usage:
  node functions/levante-admin/scripts/audit/query_journal.mjs [options]

Options:
  --project <id>              Firebase/GCP project. Default: ${DEFAULT_PROJECT}
  --hours <n>                 Look back this many hours. Default: 24
  --start <iso>               Inclusive start timestamp.
  --end <iso>                 Inclusive end timestamp. Default: now
  --resource <path>           Exact Firestore document path.
  --resource-prefix <prefix>  Firestore document path prefix.
  --operation <op>            create, update, or delete.
  --actor <actor>             _audit.actor value.
  --request-id <id>           _audit.request_id value.
  --truncated <bool>          true or false for payload_truncated.
  --include-payloads          Include before_json and after_json.
  --limit <n>                 Max rows, capped at ${MAX_LIMIT}. Default: ${DEFAULT_LIMIT}
  --page-token <token>        BigQuery page token from a previous run.
  --format <table|json>       Output format. Default: table
  --help                      Show this message.

Authentication:
  Uses GOOGLE_OAUTH_ACCESS_TOKEN when set, otherwise runs
  "gcloud auth print-access-token" with your active user credentials.
`;

const parseArgs = (argv) => {
  const options = {
    project: DEFAULT_PROJECT,
    format: "table",
    includePayloads: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--project":
        options.project = next();
        break;
      case "--hours":
        options.hours = Number(next());
        break;
      case "--start":
        options.start = next();
        break;
      case "--end":
        options.end = next();
        break;
      case "--resource":
        options.resource = next();
        break;
      case "--resource-prefix":
        options.resourcePrefix = next();
        break;
      case "--operation":
        options.operation = next();
        break;
      case "--actor":
        options.actor = next();
        break;
      case "--request-id":
        options.requestId = next();
        break;
      case "--truncated":
        options.truncated = parseBoolean(next(), "--truncated");
        break;
      case "--include-payloads":
        options.includePayloads = true;
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--page-token":
        options.pageToken = next();
        break;
      case "--format":
        options.format = next();
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
};

const parseBoolean = (value, flag) => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} must be true or false`);
};

const isoDate = (value, fallback, field) => {
  if (!value) return fallback.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid date`);
  }
  return date.toISOString();
};

const getAccessToken = () => {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  }

  return execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
};

const queryParameter = (name, type, value) => ({
  name,
  parameterType: { type },
  parameterValue: { value: String(value) },
});

const buildQuery = (options) => {
  const now = new Date();
  const hours =
    typeof options.hours === "number" && Number.isFinite(options.hours)
      ? options.hours
      : 24;
  const defaultStart = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const startTime = isoDate(options.start, defaultStart, "--start");
  const endTime = isoDate(options.end, now, "--end");
  const limit = Math.min(
    Math.max(
      Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT,
      1
    ),
    MAX_LIMIT
  );
  const payloadColumns = options.includePayloads
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
    queryParameter("startTime", "TIMESTAMP", startTime),
    queryParameter("endTime", "TIMESTAMP", endTime),
    queryParameter("limit", "INT64", limit),
  ];

  if (options.resource) {
    whereClauses.push("resource_path = @resourcePath");
    queryParameters.push(
      queryParameter("resourcePath", "STRING", options.resource)
    );
  }
  if (options.resourcePrefix) {
    whereClauses.push("STARTS_WITH(resource_path, @resourcePathPrefix)");
    queryParameters.push(
      queryParameter("resourcePathPrefix", "STRING", options.resourcePrefix)
    );
  }
  if (options.operation) {
    if (!["create", "update", "delete"].includes(options.operation)) {
      throw new Error("--operation must be create, update, or delete");
    }
    whereClauses.push("operation = @operation");
    queryParameters.push(
      queryParameter("operation", "STRING", options.operation)
    );
  }
  if (options.actor) {
    whereClauses.push("actor = @actor");
    queryParameters.push(queryParameter("actor", "STRING", options.actor));
  }
  if (options.requestId) {
    whereClauses.push("request_id = @requestId");
    queryParameters.push(
      queryParameter("requestId", "STRING", options.requestId)
    );
  }
  if (typeof options.truncated === "boolean") {
    whereClauses.push("payload_truncated = @payloadTruncated");
    queryParameters.push(
      queryParameter("payloadTruncated", "BOOL", options.truncated)
    );
  }

  return {
    maxResults: limit,
    parameterMode: "NAMED",
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
      FROM \`${options.project}.${DATASET}.${TABLE}\`
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY commit_timestamp DESC
      LIMIT @limit
    `,
    queryParameters,
    useLegacySql: false,
    ...(options.pageToken && { pageToken: options.pageToken }),
  };
};

const rowsFromResponse = (body) => {
  const fields = body.schema?.fields ?? [];
  return (body.rows ?? []).map((row) =>
    Object.fromEntries(
      row.f.map((field, index) => [fields[index]?.name, field.v])
    )
  );
};

const printRows = (rows, format, nextPageToken) => {
  if (format === "json") {
    console.log(JSON.stringify({ rows, nextPageToken }, null, 2));
    return;
  }
  if (format !== "table") {
    throw new Error("--format must be table or json");
  }

  console.table(
    rows.map((row) => ({
      commit_timestamp: row.commit_timestamp,
      operation: row.operation,
      resource_path: row.resource_path,
      actor: row.actor,
      request_id: row.request_id,
      payload_bytes: row.payload_bytes,
      payload_truncated: row.payload_truncated,
      event_id: row.event_id,
    }))
  );

  if (nextPageToken) {
    console.log(`Next page token: ${nextPageToken}`);
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const accessToken = getAccessToken();
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${options.project}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildQuery(options)),
    }
  );

  if (!response.ok) {
    throw new Error(
      `BigQuery query failed with ${response.status}: ${await response.text()}`
    );
  }

  const body = await response.json();
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

  printRows(rowsFromResponse(body), options.format, body.pageToken);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
