import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import {
  buildCellPolygon,
  parsePositiveInt,
  parseResolution,
  queryWorldPopForPolygon,
  resolveKonturPopulation,
  resolveShardUrlForCell,
} from "./population-h3-helpers.js";

const populationRequestOptions = {
  cors: true,
  invoker: "public" as const,
  timeoutSeconds: 60,
  memory: "256MiB" as const,
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

export const populationKonturH3 = onRequest(
  populationRequestOptions,
  async (req, res) => {
    if (rejectNonGet(req, res)) return;

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
