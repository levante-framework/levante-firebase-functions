import {
  AUDIT_DATASET,
  AUDIT_WRITES_TABLE,
  type JournalRow,
  type JournalWriter,
} from "./types.js";

type FetchLike = typeof fetch;
type TokenProvider = () => Promise<string>;

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
