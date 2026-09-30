import axios from "axios";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

const cartoBasemapApiKey = defineSecret("CARTO_BASEMAP_API_KEY");

const ALLOWED_STYLE = "light_all";
const MIN_ZOOM = 0;
const MAX_ZOOM = 20;
const CARTO_TILE_SUBDOMAIN = "a";

type ParsedTilePath = {
  style: string;
  z: number;
  x: number;
  y: number;
  scale: "" | "@2x";
};

function parseTilePath(rawPath: string): ParsedTilePath | null {
  const pathname = String(rawPath || "").split("?")[0];
  const cleaned = pathname.replace(/^\/+/, "");
  const match = cleaned.match(
    /^(?:[^/]+\/)?light_all\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png$/i
  );
  if (!match) {
    return null;
  }

  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const scale = match[4] === "@2x" ? "@2x" : "";

  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < MIN_ZOOM ||
    z > MAX_ZOOM
  ) {
    return null;
  }

  const tileCount = 2 ** z;
  if (x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    return null;
  }

  return { style: ALLOWED_STYLE, z, x, y, scale };
}

function buildCartoUpstreamUrl(tile: ParsedTilePath, apiKey: string): string {
  const { z, x, y, scale } = tile;
  const params = new URLSearchParams({ key: apiKey });
  return `https://${CARTO_TILE_SUBDOMAIN}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}${scale}.png?${params.toString()}`;
}

export const cartoBasemapTile = onRequest(
  { secrets: [cartoBasemapApiKey] },
  async (req: Request, res: Response) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      res.status(405).send("Method Not Allowed");
      return;
    }

    const tile = parseTilePath(req.path);
    if (!tile) {
      res.status(400).send("Bad Request");
      return;
    }

    const apiKey = cartoBasemapApiKey.value();
    if (!apiKey) {
      logger.error("CARTO_BASEMAP_API_KEY is not configured");
      res.status(500).send("Internal Server Error");
      return;
    }

    const upstreamUrl = buildCartoUpstreamUrl(tile, apiKey);

    try {
      const upstream = await axios.get<ArrayBuffer>(upstreamUrl, {
        responseType: "arraybuffer",
        validateStatus: () => true,
        timeout: 15_000,
      });

      if (upstream.status !== 200) {
        logger.warn("Carto basemap upstream error", {
          status: upstream.status,
          z: tile.z,
          x: tile.x,
          y: tile.y,
        });
        res.status(upstream.status === 404 ? 404 : 502).send("Bad Gateway");
        return;
      }

      const cacheControl =
        upstream.headers["cache-control"] || "public, max-age=86400";
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", cacheControl);
      res.status(200).send(Buffer.from(upstream.data));
    } catch (error) {
      logger.error("Carto basemap proxy failed", { error });
      res.status(502).send("Bad Gateway");
    }
  }
);
