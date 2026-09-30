import { defineString } from "firebase-functions/params";
import { cellToBoundary, cellToParent } from "h3-js";
import { gunzipSync } from "node:zlib";

const WORLDPOP_STATS_URL = "https://api.worldpop.org/v1/services/stats";
const WORLDPOP_TASK_URL = "https://api.worldpop.org/v1/tasks";

const DEFAULT_SHARD_BASE_URL =
  "https://storage.googleapis.com/levante-assets-dev/maps/kontur-h3-r5";

const konturH3CacheUrl = defineString("KONTUR_H3_CACHE_URL", {
  default: DEFAULT_SHARD_BASE_URL,
});

const konturH3CacheMaxShards = defineString("KONTUR_H3_CACHE_MAX_SHARDS", {
  default: "64",
});

type KonturShard = {
  resolutions: Record<string, Record<string, number>>;
};

const konturShardCache = new Map<string, KonturShard>();
const konturShardInFlight = new Map<string, Promise<KonturShard | null>>();

export function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return fallback;
}

export function parseResolution(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 15) return null;
  return n;
}

export function buildCellPolygon(cellId: string) {
  const boundary = cellToBoundary(cellId);
  if (!Array.isArray(boundary) || !boundary.length) {
    throw new Error("Invalid H3 cell boundary");
  }
  const ring = boundary.map((pair) => [Number(pair[1]), Number(pair[0])]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return {
    type: "Polygon" as const,
    coordinates: [ring],
  };
}

function getShardCacheLimit(): number {
  const raw = Number(konturH3CacheMaxShards.value());
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 64;
}

function parseKonturShardJson(json: {
  resolutions?: unknown;
}): KonturShard | null {
  const resolutions = json?.resolutions;
  if (!resolutions || typeof resolutions !== "object") return null;
  return {
    resolutions: resolutions as Record<string, Record<string, number>>,
  };
}

async function loadKonturShardFromUrl(
  shardUrl: string
): Promise<KonturShard | null> {
  try {
    const response = await fetch(shardUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const jsonText = gunzipSync(buffer).toString("utf-8");
    const json = JSON.parse(jsonText) as { resolutions?: unknown };
    return parseKonturShardJson(json);
  } catch {
    return null;
  }
}

function getShardCacheKey(shardCellId: string): string {
  return `r5:${shardCellId}`;
}

function getShardBaseUrl(): string {
  const raw = String(konturH3CacheUrl.value() || "").trim();
  return raw || DEFAULT_SHARD_BASE_URL;
}

function resolveShardUrl(shardCellId: string): string {
  return `${getShardBaseUrl()}/${shardCellId}.json.gz`;
}

async function loadKonturShard(
  shardCellId: string
): Promise<KonturShard | null> {
  const cacheKey = getShardCacheKey(shardCellId);
  const existing = konturShardCache.get(cacheKey);
  if (existing) {
    konturShardCache.delete(cacheKey);
    konturShardCache.set(cacheKey, existing);
    return existing;
  }
  const inflight = konturShardInFlight.get(cacheKey);
  if (inflight) return inflight;

  const loader = loadKonturShardFromUrl(resolveShardUrl(shardCellId));

  konturShardInFlight.set(cacheKey, loader);
  try {
    const loaded = await loader;
    if (loaded) {
      konturShardCache.set(cacheKey, loaded);
      const limit = getShardCacheLimit();
      while (konturShardCache.size > limit) {
        const oldestKey = konturShardCache.keys().next().value;
        if (oldestKey === undefined) break;
        konturShardCache.delete(oldestKey);
      }
    }
    return loaded;
  } finally {
    konturShardInFlight.delete(cacheKey);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWorldPopSum(payload: Record<string, unknown>): number | null {
  const data = payload?.data as Record<string, unknown> | undefined;
  const stats = payload?.stats as Record<string, unknown> | undefined;
  const result = payload?.result as Record<string, unknown> | undefined;
  const dataStats = data?.stats as Record<string, unknown> | undefined;
  const resultStats = result?.stats as Record<string, unknown> | undefined;

  const candidates = [
    data?.total_population,
    stats?.sum,
    dataStats?.sum,
    resultStats?.sum,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = Number(candidates[i]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function parseWorldPopTaskId(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload?.taskid,
    payload?.taskId,
    payload?.task_id,
    payload?.id,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = String(candidates[i] || "").trim();
    if (value) return value;
  }
  return null;
}

export async function queryWorldPopForPolygon(
  polygon: ReturnType<typeof buildCellPolygon>,
  year: number
): Promise<number> {
  const url = new URL(WORLDPOP_STATS_URL);
  url.searchParams.set("dataset", "wpgppop");
  url.searchParams.set("year", String(year));
  url.searchParams.set("geojson", JSON.stringify(polygon));
  url.searchParams.set("runasync", "false");
  const firstResponse = await fetch(url.toString(), { method: "GET" });
  if (!firstResponse.ok) {
    throw new Error(`WorldPop stats request failed (${firstResponse.status})`);
  }
  const firstPayload = (await firstResponse.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const directSum = parseWorldPopSum(firstPayload);
  if (typeof directSum === "number") return directSum;

  const taskId = parseWorldPopTaskId(firstPayload);
  if (!taskId) {
    throw new Error("WorldPop response missing stats and task id");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const taskResponse = await fetch(
      `${WORLDPOP_TASK_URL}/${encodeURIComponent(taskId)}`
    );
    if (!taskResponse.ok) {
      throw new Error(`WorldPop task polling failed (${taskResponse.status})`);
    }
    const taskPayload = (await taskResponse.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const sum = parseWorldPopSum(taskPayload);
    if (typeof sum === "number") return sum;

    const status = String(
      taskPayload?.status || taskPayload?.state || ""
    ).toLowerCase();
    if (status.includes("failed") || status.includes("error")) {
      throw new Error(`WorldPop task ${taskId} failed`);
    }
    await wait(600);
  }

  throw new Error(`WorldPop task ${taskId} timed out`);
}

export async function resolveKonturPopulation(
  cellId: string,
  resolution: number
): Promise<number | null> {
  if (resolution < 5) return null; // cells with resolution <5 are not stored
  let shardCellId: string;
  try {
    shardCellId = cellToParent(cellId, 5);
  } catch {
    return null;
  }
  const shard = await loadKonturShard(shardCellId);
  const byRes = shard?.resolutions?.[String(resolution)];
  if (!byRes || typeof byRes !== "object") return null;
  const value = Number(byRes[cellId]);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export function resolveShardUrlForCell(cellId: string): string | null {
  try {
    return resolveShardUrl(cellToParent(cellId, 5));
  } catch {
    return null;
  }
}
