import { onRequest, type HttpsOptions } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import {
  buildCellPolygon,
  parsePositiveInt,
  parseResolution,
  queryWorldPopForPolygon,
  resolveKonturPopulation,
  resolveShardUrlForCell,
} from "./helpers/population-h3-helpers.js";
import { requireFirebaseUser } from "./helpers/location-proxy-guards.js";
import { getResolution, isValidCell } from "h3-js";

const populationRequestOptions: HttpsOptions = {
  cors: true,
  invoker: "public",
  timeoutSeconds: 90,
  memory: "256MiB",
  maxInstances: 10,
  concurrency: 1,
};

function sendJson(res: Response, statusCode: number, payload: unknown): void {
  res
    .status(statusCode)
    .set("Content-Type", "application/json")
    .send(JSON.stringify(payload));
}

function rejectNonGet(req: Request, res: Response): boolean {
  if (req.method !== "GET") {
    res.set("Allow", "GET");
    res.status(405).send("Method Not Allowed");
    return true;
  }
  return false;
}

function validateCell(req: Request, res: Response): boolean {
  const cellId = String(req.query?.cellId || "").trim();
  const resolution = parseResolution(req.query?.resolution);
  if (!cellId || resolution == null || !isValidCell(cellId)) {
    sendJson(res, 400, { success: false, error: "Missing/invalid cellId or resolution" });
    return false;
  }
  if (getResolution(cellId) !== resolution) {
    sendJson(res, 400, { success: false, error: "resolution does not match cellId" });
    return false;
  }

  return true;
}

export const populationKonturH3 = onRequest(
  populationRequestOptions,
  async (req, res) => {
    if (rejectNonGet(req, res)) return;

    if (!(await requireFirebaseUser(req, res))) return;

    if (!validateCell) return;

    try {
      const cellId = String(req.query?.cellId || "").trim();
      const resolution = parseResolution(req.query?.resolution);
      const worldpopYear = parsePositiveInt(req.query?.year, 2020);
      if (!cellId || resolution == null) {
        sendJson(res, 400, {
          success: false,
          error: "Missing/invalid cellId or resolution",
        });
        return;
      }

      const konturPopulation = await resolveKonturPopulation(
        cellId,
        resolution
      );
      if (typeof konturPopulation === "number") {
        sendJson(res, 200, {
          success: true,
          source: "kontur",
          population: konturPopulation,
          resolution,
          cellId,
          cachePath: resolveShardUrlForCell(cellId),
        });
        return;
      }

      const polygon = buildCellPolygon(cellId);
      const worldpopPopulation = await queryWorldPopForPolygon(
        polygon,
        worldpopYear
      );
      sendJson(res, 200, {
        success: true,
        source: "worldpop",
        fallbackFrom: "kontur",
        population: Math.round(worldpopPopulation),
        resolution,
        cellId,
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export const populationWorldpopH3 = onRequest(
  populationRequestOptions,
  async (req, res) => {
    if (rejectNonGet(req, res)) return;

    if (!(await requireFirebaseUser(req, res))) return;

    if (!validateCell) return;

    try {
      const cellId = String(req.query?.cellId || "").trim();
      const resolution = parseResolution(req.query?.resolution);
      const worldpopYear = parsePositiveInt(req.query?.year, 2020);
      if (!cellId || resolution == null) {
        sendJson(res, 400, {
          success: false,
          error: "Missing/invalid cellId or resolution",
        });
        return;
      }
      const polygon = buildCellPolygon(cellId);
      const population = await queryWorldPopForPolygon(polygon, worldpopYear);
      sendJson(res, 200, {
        success: true,
        source: "worldpop",
        population: Math.round(population),
        resolution,
        cellId,
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);
