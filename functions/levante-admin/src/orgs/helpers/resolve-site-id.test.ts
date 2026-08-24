import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { resolveSiteId } from "./resolve-site-id.js";

// Serves docs keyed by `collection/id`; a missing key reads as non-existent.
// Records reads so tests can assert which collection/doc was hit.
function mockReadDb(docs: Record<string, Record<string, unknown>>) {
  const reads: { collection: string; id: string }[] = [];
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        get: async () => {
          reads.push({ collection, id });
          const data = docs[`${collection}/${id}`];
          return { exists: data !== undefined, data: () => data };
        },
      }),
    }),
  } as unknown as Firestore;
  return { db, reads };
}

describe("resolveSiteId", () => {
  it("returns the orgId directly for a site without reading Firestore", async () => {
    const { db, reads } = mockReadDb({});
    await expect(resolveSiteId(db, "site", "site-1")).resolves.toBe("site-1");
    expect(reads).toEqual([]);
  });

  it("reads a school's districtId", async () => {
    const { db, reads } = mockReadDb({
      "schools/school-1": { districtId: "site-1" },
    });
    await expect(resolveSiteId(db, "school", "school-1")).resolves.toBe(
      "site-1"
    );
    expect(reads).toEqual([{ collection: "schools", id: "school-1" }]);
  });

  it("reads a class's districtId", async () => {
    const { db } = mockReadDb({
      "classes/class-1": { districtId: "site-1" },
    });
    await expect(resolveSiteId(db, "class", "class-1")).resolves.toBe("site-1");
  });

  it("reads a cohort's parentOrgId from the groups collection", async () => {
    const { db, reads } = mockReadDb({
      "groups/cohort-1": { parentOrgId: "site-1", parentOrgType: "districts" },
    });
    await expect(resolveSiteId(db, "cohort", "cohort-1")).resolves.toBe(
      "site-1"
    );
    expect(reads).toEqual([{ collection: "groups", id: "cohort-1" }]);
  });

  it("throws not-found when the org does not exist", async () => {
    const { db } = mockReadDb({});
    await expect(resolveSiteId(db, "school", "missing")).rejects.toMatchObject({
      code: "not-found",
      details: { code: "org", orgType: "school", orgId: "missing" },
    });
  });

  it("throws org-site-missing when a school has no districtId", async () => {
    const { db } = mockReadDb({
      "schools/school-1": { name: "Orphan" },
    });
    await expect(resolveSiteId(db, "school", "school-1")).rejects.toMatchObject(
      {
        code: "internal",
        details: { code: "org-site-missing", orgType: "school" },
      }
    );
  });

  it("throws org-site-missing when a cohort has no parentOrgId", async () => {
    const { db } = mockReadDb({
      "groups/cohort-1": { parentOrgType: "districts" },
    });
    await expect(resolveSiteId(db, "cohort", "cohort-1")).rejects.toMatchObject(
      {
        code: "internal",
        details: { code: "org-site-missing", orgType: "cohort" },
      }
    );
  });
});
