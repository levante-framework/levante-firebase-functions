import { describe, it, expect } from "vitest";
import { fetchSyncStatusCounts } from "./site-utils.js";
import type { Firestore } from "firebase-admin/firestore";

const future = { toMillis: () => Date.now() + 86_400_000 };
const past = { toMillis: () => Date.now() - 86_400_000 };

type AdminDoc = {
  dateOpened?: object;
  dateClosed?: object;
  syncStatus?: string;
};
type UserDoc = { syncStatus?: string };

// where()/select() are no-ops here: archived/disabled/off-site exclusion is
// enforced by the Firestore query, not this function, so it's covered by the
// e2e test. These unit tests exercise the in-memory date and bucketing logic.
function mockDb(adminDocs: AdminDoc[], userDocs: UserDoc[]): Firestore {
  function makeChain(docs: object[]) {
    const snap = {
      docs: docs.map((d) => ({
        get: (f: string) => (d as Record<string, unknown>)[f],
      })),
    };
    const q: any = {
      where: () => q,
      select: () => ({ get: async () => snap }),
    };
    return q;
  }
  return {
    collection: (name: string) =>
      makeChain(name === "administrations" ? adminDocs : userDocs),
  } as unknown as Firestore;
}

const openAdmin = (syncStatus?: string): AdminDoc => ({
  dateOpened: past,
  dateClosed: future,
  syncStatus,
});

describe("fetchSyncStatusCounts", () => {
  it("returns all zeros when there are no documents", async () => {
    const db = mockDb([], []);
    await expect(fetchSyncStatusCounts(db, "site1")).resolves.toEqual({
      assignments: { complete: 0, failed: 0, pending: 0 },
      users: { complete: 0, failed: 0, pending: 0 },
    });
  });

  describe("assignments", () => {
    it.each([
      ["pending", { pending: 1, complete: 0, failed: 0 }],
      ["complete", { pending: 0, complete: 1, failed: 0 }],
      ["failed", { pending: 0, complete: 0, failed: 1 }],
      [undefined, { pending: 0, complete: 1, failed: 0 }], // default bucket
    ])(
      "buckets an open administration with syncStatus=%s",
      async (status, expected) => {
        const db = mockDb([openAdmin(status)], []);
        const { assignments } = await fetchSyncStatusCounts(db, "site1");
        expect(assignments).toEqual(expected);
      }
    );

    it("counts upcoming administrations (dateOpened in future)", async () => {
      const db = mockDb(
        [{ dateOpened: future, dateClosed: future, syncStatus: "pending" }],
        []
      );
      const { assignments } = await fetchSyncStatusCounts(db, "site1");
      expect(assignments).toEqual({ pending: 1, complete: 0, failed: 0 });
    });

    it("skips closed administrations", async () => {
      const db = mockDb(
        [{ dateOpened: past, dateClosed: past, syncStatus: "pending" }],
        []
      );
      const { assignments } = await fetchSyncStatusCounts(db, "site1");
      expect(assignments).toEqual({ pending: 0, complete: 0, failed: 0 });
    });

    it("skips administrations with missing dates", async () => {
      const db = mockDb(
        [
          { syncStatus: "pending" },
          { dateOpened: past, syncStatus: "pending" },
          { dateClosed: future, syncStatus: "pending" },
        ],
        []
      );
      const { assignments } = await fetchSyncStatusCounts(db, "site1");
      expect(assignments).toEqual({ pending: 0, complete: 0, failed: 0 });
    });
  });

  describe("users", () => {
    it.each([
      ["pending", { pending: 1, complete: 0, failed: 0 }],
      ["complete", { pending: 0, complete: 1, failed: 0 }],
      ["failed", { pending: 0, complete: 0, failed: 1 }],
      [undefined, { pending: 0, complete: 1, failed: 0 }], // default bucket
    ])("buckets a user with syncStatus=%s", async (status, expected) => {
      const db = mockDb([], [{ syncStatus: status }]);
      const { users } = await fetchSyncStatusCounts(db, "site1");
      expect(users).toEqual(expected);
    });
  });
});
