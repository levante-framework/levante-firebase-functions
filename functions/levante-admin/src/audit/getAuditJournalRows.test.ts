import { describe, expect, it, vi } from "vitest";
import {
  getAuditJournalRowsHandler,
  hasSuperAdminClaim,
  normalizeAuditJournalQueryParams,
} from "./getAuditJournalRows.js";
import type {
  AuditJournalReader,
  RequiredAuditJournalQueryParams,
} from "./types.js";

const authWithClaims = (customClaims: Record<string, unknown>) => ({
  getUser: vi.fn().mockResolvedValue({ customClaims }),
});

describe("getAuditJournalRows", () => {
  it("recognizes super_admin from supported claim shapes", () => {
    expect(hasSuperAdminClaim({ super_admin: true })).toBe(true);
    expect(hasSuperAdminClaim({ rolesSet: ["super_admin"] })).toBe(true);
    expect(hasSuperAdminClaim({ roles: [{ role: "super_admin" }] })).toBe(true);
    expect(hasSuperAdminClaim({ siteRoles: { global: ["super_admin"] } })).toBe(
      true
    );
    expect(hasSuperAdminClaim({ rolesSet: ["site_admin"] })).toBe(false);
  });

  it("normalizes query params with safe defaults and bounds", () => {
    const params = normalizeAuditJournalQueryParams(
      {
        operation: "delete",
        resourcePathPrefix: "users/",
        payloadTruncated: true,
        includePayloads: true,
        limit: 500,
      },
      new Date("2026-08-15T12:00:00.000Z")
    );

    expect(params).toEqual({
      startTime: "2026-08-14T12:00:00.000Z",
      endTime: "2026-08-15T12:00:00.000Z",
      resourcePath: null,
      resourcePathPrefix: "users/",
      operation: "delete",
      actor: null,
      requestId: null,
      payloadTruncated: true,
      includePayloads: true,
      limit: 100,
      pageToken: null,
    });
  });

  it("rejects non-super-admin callers", async () => {
    await expect(
      getAuditJournalRowsHandler({
        requesterUid: "site-admin",
        data: {},
        auth: authWithClaims({ rolesSet: ["site_admin"] }),
        reader: { query: vi.fn() },
      })
    ).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("queries BigQuery for super admins", async () => {
    const query =
      vi.fn<(_: RequiredAuditJournalQueryParams) => Promise<{ rows: [] }>>();
    query.mockResolvedValue({ rows: [] });
    const reader: AuditJournalReader = { query };

    await expect(
      getAuditJournalRowsHandler({
        requesterUid: "super-admin",
        data: {
          startTime: "2026-08-14T00:00:00.000Z",
          endTime: "2026-08-15T00:00:00.000Z",
          resourcePath: "users/test-user",
          limit: 10,
        },
        auth: authWithClaims({ rolesSet: ["super_admin"] }),
        reader,
      })
    ).resolves.toEqual({ rows: [] });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: "2026-08-14T00:00:00.000Z",
        endTime: "2026-08-15T00:00:00.000Z",
        resourcePath: "users/test-user",
        limit: 10,
      })
    );
  });
});
