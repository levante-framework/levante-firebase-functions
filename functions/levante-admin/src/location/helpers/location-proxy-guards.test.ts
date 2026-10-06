import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { isEmulated } from "../../utils/utils.js";
import {
  assertAllowedReferrer,
  requireFirebaseUser,
} from "./location-proxy-guards.js";

let allowedOriginsValue = "https://allowed-a.web.app,https://allowed-b.web.app";

vi.mock("firebase-functions/params", () => ({
  defineString: () => ({ value: () => allowedOriginsValue }),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../utils/utils.js", () => ({
  isEmulated: vi.fn(),
}));

const mockGetAuth = vi.mocked(getAuth);
const mockIsEmulated = vi.mocked(isEmulated);

function mockRequest(
  headers: Record<string, string | undefined> = {}
): Request {
  return { headers } as unknown as Request;
}

function mockResponse() {
  const res = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

function mockVerifyIdToken(impl: (token: string) => Promise<unknown>) {
  mockGetAuth.mockReturnValue({
    verifyIdToken: vi.fn(impl),
  } as unknown as ReturnType<typeof getAuth>);
}

beforeEach(() => {
  vi.clearAllMocks();
  allowedOriginsValue = "https://allowed-a.web.app,https://allowed-b.web.app";
});

describe("requireFirebaseUser", () => {
  it("returns false and 401 when the Authorization header is missing", async () => {
    const res = mockResponse();

    const result = await requireFirebaseUser(mockRequest(), res);

    expect(result).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!)).toEqual({
      success: false,
      error: "Missing or invalid Authorization header",
    });
    expect(mockGetAuth).not.toHaveBeenCalled();
  });

  it("returns false and 401 when the Authorization header is not a Bearer token", async () => {
    const res = mockResponse();

    const result = await requireFirebaseUser(
      mockRequest({ authorization: "Basic abc123" }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(mockGetAuth).not.toHaveBeenCalled();
  });

  it("returns true when a valid Bearer token is verified", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "user-1" });
    mockGetAuth.mockReturnValue({
      verifyIdToken: verify,
    } as unknown as ReturnType<typeof getAuth>);
    const res = mockResponse();

    const result = await requireFirebaseUser(
      mockRequest({ authorization: "Bearer good-token" }),
      res
    );

    expect(result).toBe(true);
    expect(verify).toHaveBeenCalledWith("good-token");
    expect(res.statusCode).toBeUndefined();
  });

  it("parses the Bearer scheme case-insensitively and trims the token", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "user-1" });
    mockGetAuth.mockReturnValue({
      verifyIdToken: verify,
    } as unknown as ReturnType<typeof getAuth>);

    const result = await requireFirebaseUser(
      mockRequest({ authorization: "bearer   spaced-token  " }),
      mockResponse()
    );

    expect(result).toBe(true);
    expect(verify).toHaveBeenCalledWith("spaced-token");
  });

  it("returns false and 401 when token verification throws", async () => {
    mockVerifyIdToken(() => Promise.reject(new Error("expired")));
    const res = mockResponse();

    const result = await requireFirebaseUser(
      mockRequest({ authorization: "Bearer bad-token" }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!)).toEqual({
      success: false,
      error: "Unauthorized",
    });
  });
});

describe("assertAllowedReferrer", () => {
  it("returns true without checking the origin when emulated", () => {
    mockIsEmulated.mockReturnValue(true);
    const res = mockResponse();

    const result = assertAllowedReferrer(mockRequest(), res);

    expect(result).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("allows a request whose Referer origin is in the allow list", () => {
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ referer: "https://allowed-a.web.app/some/path?q=1" }),
      res
    );

    expect(result).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("falls back to the Origin header when there is no Referer", () => {
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://allowed-b.web.app" }),
      res
    );

    expect(result).toBe(true);
  });

  it("falls back to the Origin header when the Referer is malformed", () => {
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({
        referer: "not a url",
        origin: "https://allowed-a.web.app",
      }),
      res
    );

    expect(result).toBe(true);
  });

  it("returns false and 403 when the origin is not in the allow list", () => {
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ referer: "https://evil.example.com/path" }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("returns false and 403 when neither Referer nor Origin is present", () => {
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(mockRequest(), res);

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("trims whitespace around configured origins", () => {
    allowedOriginsValue =
      " https://allowed-a.web.app , https://allowed-b.web.app ";
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://allowed-b.web.app" }),
      res
    );

    expect(result).toBe(true);
  });

  it("ignores empty entries from a trailing comma", () => {
    allowedOriginsValue = "https://allowed-a.web.app,";
    mockIsEmulated.mockReturnValue(false);
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://allowed-a.web.app" }),
      res
    );

    expect(result).toBe(true);
  });
});

describe("assertAllowedReferrer with wildcard patterns", () => {
  beforeEach(() => {
    mockIsEmulated.mockReturnValue(false);
  });

  it("matches a dynamic segment against a wildcard pattern", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({
        referer: "https://hs-levante-admin-dev--pr123.web.app/page",
      }),
      res
    );

    expect(result).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("does not let the wildcard match across a dot boundary", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({
        referer: "https://hs-levante-admin-dev--pr123.evil.web.app/page",
      }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("anchors the pattern so a matching prefix is not enough", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({
        origin: "https://hs-levante-admin-dev--pr123.web.app.evil.com",
      }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("treats a bare wildcard segment as requiring at least the surrounding literals", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://hs-levante-admin-dev--.web.app" }),
      res
    );

    expect(result).toBe(true);
  });

  it("still rejects an origin that does not match the literal portion of the pattern", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://hs-levante-admin-prod--pr123.web.app" }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("matches an exact origin alongside a wildcard pattern", () => {
    allowedOriginsValue =
      "https://hs-levante-admin-dev.web.app,https://hs-levante-admin-dev--*.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://hs-levante-admin-dev.web.app" }),
      res
    );

    expect(result).toBe(true);
  });

  it("does not let a wildcard-free exact pattern match a dynamic origin", () => {
    allowedOriginsValue = "https://hs-levante-admin-dev.web.app";
    const res = mockResponse();

    const result = assertAllowedReferrer(
      mockRequest({ origin: "https://hs-levante-admin-dev--pr123.web.app" }),
      res
    );

    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
