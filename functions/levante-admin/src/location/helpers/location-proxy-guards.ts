import { getAuth } from "firebase-admin/auth";
import type { Request, Response } from "express";
import { defineString } from "firebase-functions/params";
import { isEmulated } from "../../utils/utils.js";

const allowedOrigins = defineString("ALLOWED_ORIGINS", {
  default:
    "https://hs-levante-admin-dev.web.app,https://hs-levante-admin-dev--*.web.app",
});

function parseBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  return token || null;
}

function sendUnauthorized(res: Response, error: string): void {
  res
    .status(401)
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ success: false, error }));
}

function resolveRequestOrigin(req: Request): string | undefined {
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // ignore malformed Referer
    }
  }

  return req.headers.origin;
}

export async function requireFirebaseUser(
  req: Request,
  res: Response
): Promise<boolean> {
  const token = parseBearerToken(req);
  if (!token) {
    sendUnauthorized(res, "Missing or invalid Authorization header");
    return false;
  }

  try {
    await getAuth().verifyIdToken(token);
    return true;
  } catch (error) {
    sendUnauthorized(res, "Unauthorized");
    return false;
  }
}

function originMatchesPattern(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) return origin === pattern;

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, "[^.]*")}$`);

  return regex.test(origin);
}

export function assertAllowedReferrer(req: Request, res: Response): boolean {
  if (isEmulated()) return true;

  const origin: string | undefined = resolveRequestOrigin(req);
  const allowedOriginsArray = String(allowedOrigins.value())
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  if (
    !origin ||
    !allowedOriginsArray.some((pattern) =>
      originMatchesPattern(origin, pattern)
    )
  ) {
    res.status(403).send("Forbidden");
    return false;
  }

  return true;
}
