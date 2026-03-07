import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { cellToLatLng, getResolution } from "h3-js";

const DEFAULT_COLLECTION = process.env.LOCATION_FIRESTORE_COLLECTION || "locations";
const H3_CENTER_EPSILON = 1e-6;

type LatLonSource = "gps" | "h3_center" | "approximate";
type PopulationSource = "kontur" | "worldpop" | "unknown";

interface LocationRecord {
  schemaVersion: "location_v1";
  latLon?: {
    lat: number;
    lon: number;
    source: LatLonSource;
    blurRadiusMeters?: number;
  };
  h3: {
    scheme: "h3_v1";
    baseline: {
      cellId: string;
      resolution: number;
    };
    effective: {
      cellId: string;
      resolution: number;
    };
    populationThreshold: number;
  };
  populationSource?: PopulationSource;
  computedAt?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpsError("invalid-argument", `${label} must be a positive integer`);
  }
  return value;
}

function asH3Resolution(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 15) {
    throw new HttpsError("invalid-argument", `${label} must be an integer between 0 and 15`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function sanitizeCollection(rawCollection: unknown): string {
  if (rawCollection == null) return DEFAULT_COLLECTION;
  if (typeof rawCollection !== "string" || rawCollection.trim().length === 0) {
    throw new HttpsError("invalid-argument", "collection must be a non-empty string");
  }
  const collection = rawCollection.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
    throw new HttpsError("invalid-argument", "collection may only include letters, numbers, underscores, and dashes");
  }
  return collection;
}

function validateIsoDatetime(value: unknown, label: string): string {
  const out = asString(value, label);
  if (Number.isNaN(Date.parse(out))) {
    throw new HttpsError("invalid-argument", `${label} must be an ISO datetime string`);
  }
  return out;
}

function validateLocationFallback(input: unknown): LocationRecord {
  if (!isObject(input)) {
    throw new HttpsError("invalid-argument", "location must be an object");
  }
  if (input.schemaVersion !== "location_v1") {
    throw new HttpsError("invalid-argument", "schemaVersion must be location_v1");
  }

  if (!isObject(input.h3)) {
    throw new HttpsError("invalid-argument", "h3 is required");
  }
  if (input.h3.scheme !== "h3_v1") {
    throw new HttpsError("invalid-argument", "h3.scheme must be h3_v1");
  }

  const baseline = input.h3.baseline;
  const effective = input.h3.effective;
  if (!isObject(baseline) || !isObject(effective)) {
    throw new HttpsError("invalid-argument", "h3.baseline and h3.effective are required");
  }

  const baselineCellId = asString(baseline.cellId, "h3.baseline.cellId");
  const baselineResolution = asH3Resolution(baseline.resolution, "h3.baseline.resolution");
  const effectiveCellId = asString(effective.cellId, "h3.effective.cellId");
  const effectiveResolution = asH3Resolution(effective.resolution, "h3.effective.resolution");
  const populationThreshold = asPositiveInt(input.h3.populationThreshold, "h3.populationThreshold");

  let baselineFromCell: number;
  let effectiveFromCell: number;
  try {
    baselineFromCell = getResolution(baselineCellId);
  } catch {
    throw new HttpsError("invalid-argument", "h3.baseline.cellId is not a valid H3 index");
  }
  try {
    effectiveFromCell = getResolution(effectiveCellId);
  } catch {
    throw new HttpsError("invalid-argument", "h3.effective.cellId is not a valid H3 index");
  }

  if (baselineFromCell !== baselineResolution) {
    throw new HttpsError("invalid-argument", "h3.baseline.resolution does not match cellId resolution");
  }
  if (effectiveFromCell !== effectiveResolution) {
    throw new HttpsError("invalid-argument", "h3.effective.resolution does not match cellId resolution");
  }
  if (effectiveResolution < baselineResolution) {
    throw new HttpsError("invalid-argument", "h3.effective.resolution must be >= h3.baseline.resolution");
  }

  const out: LocationRecord = {
    schemaVersion: "location_v1",
    h3: {
      scheme: "h3_v1",
      baseline: {
        cellId: baselineCellId,
        resolution: baselineResolution,
      },
      effective: {
        cellId: effectiveCellId,
        resolution: effectiveResolution,
      },
      populationThreshold,
    },
  };

  if (input.populationSource != null) {
    const source = asString(input.populationSource, "populationSource");
    if (source !== "kontur" && source !== "worldpop" && source !== "unknown") {
      throw new HttpsError("invalid-argument", "populationSource must be one of: kontur, worldpop, unknown");
    }
    out.populationSource = source;
  }

  if (input.computedAt != null) {
    out.computedAt = validateIsoDatetime(input.computedAt, "computedAt");
  }

  if (input.latLon != null) {
    if (!isObject(input.latLon)) {
      throw new HttpsError("invalid-argument", "latLon must be an object");
    }
    const lat = input.latLon.lat;
    const lon = input.latLon.lon;
    if (typeof lat !== "number" || lat < -90 || lat > 90) {
      throw new HttpsError("invalid-argument", "latLon.lat must be a number between -90 and 90");
    }
    if (typeof lon !== "number" || lon < -180 || lon > 180) {
      throw new HttpsError("invalid-argument", "latLon.lon must be a number between -180 and 180");
    }

    const source = asString(input.latLon.source, "latLon.source");
    if (source !== "gps" && source !== "h3_center" && source !== "approximate") {
      throw new HttpsError("invalid-argument", "latLon.source must be one of: gps, h3_center, approximate");
    }

    const latLon: LocationRecord["latLon"] = { lat, lon, source };
    if (source === "approximate") {
      if (
        typeof input.latLon.blurRadiusMeters !== "number" ||
        !Number.isFinite(input.latLon.blurRadiusMeters) ||
        input.latLon.blurRadiusMeters <= 0
      ) {
        throw new HttpsError("invalid-argument", "latLon.blurRadiusMeters is required when source is approximate");
      }
      latLon.blurRadiusMeters = input.latLon.blurRadiusMeters;
    }

    if (source === "h3_center") {
      const [centerLat, centerLon] = cellToLatLng(effectiveCellId);
      if (
        Math.abs(centerLat - lat) > H3_CENTER_EPSILON ||
        Math.abs(centerLon - lon) > H3_CENTER_EPSILON
      ) {
        throw new HttpsError(
          "invalid-argument",
          "latLon must match effective H3 center when source is h3_center"
        );
      }
    }
    out.latLon = latLon;
  }

  return out;
}

async function parseLocation(location: unknown): Promise<LocationRecord> {
  try {
    const sdk: any = await import("@levante-framework/levante-zod");
    if (sdk?.LocationSchema?.parse) {
      return sdk.LocationSchema.parse(location) as LocationRecord;
    }
    logger.warn("LocationSchema not found in @levante-framework/levante-zod, using fallback validator");
    return validateLocationFallback(location);
  } catch (error) {
    logger.warn("Could not import @levante-framework/levante-zod, using fallback validator", { error });
    return validateLocationFallback(location);
  }
}

async function buildLocationDocId(location: LocationRecord): Promise<string> {
  try {
    const sdk: any = await import("@levante-framework/levante-zod");
    if (typeof sdk?.locationDocId === "function") {
      return sdk.locationDocId(location);
    }
  } catch (_) {
    // Ignore and use fallback below.
  }
  return `h3:${location.h3.effective.cellId}:t:${location.h3.populationThreshold}:v1`;
}

export const upsertLocation = onCall(async (request) => {
  logger.info("upsertLocation called", {
    hasAuth: Boolean(request.auth?.uid),
    emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
  });
  try {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const requestData = isObject(request.data) ? request.data : {};
    const locationPayload = requestData.location ?? request.data;
    const collection = sanitizeCollection(requestData.collection);
    const parsedLocation = await parseLocation(locationPayload);
    const docId = await buildLocationDocId(parsedLocation);

    const db = getFirestore();
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      db.settings({ ignoreUndefinedProperties: true });
    }
    await db.collection(collection).doc(docId).set(parsedLocation, { merge: false });

    return {
      success: true,
      id: docId,
      path: `${collection}/${docId}`,
      location: parsedLocation,
    };
  } catch (error) {
    logger.error("upsertLocation error", { error });
    throw error;
  }
});

export const getLocation = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const requestData = isObject(request.data) ? request.data : {};
  const docId = asString(requestData.docId, "docId");
  const collection = sanitizeCollection(requestData.collection);

  const snap = await getFirestore()
    .collection(collection)
    .doc(docId)
    .get();

  if (!snap.exists) {
    throw new HttpsError("not-found", `Location ${docId} not found`);
  }

  const location = await parseLocation(snap.data());
  return {
    success: true,
    id: docId,
    path: `${collection}/${docId}`,
    location,
  };
});
