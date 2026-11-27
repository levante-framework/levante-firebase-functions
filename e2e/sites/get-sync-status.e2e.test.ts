import type { GetSyncStatusResult } from "@levante-framework/levante-zod";
import { Timestamp } from "firebase-admin/firestore";
import type { HttpsCallable } from "firebase/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminDb,
  clearAuth,
  clearFirestore,
  getClient,
  seedSystemPermissions,
  signInAs,
} from "../app";

const SITE = "site-1";
const OTHER_SITE = "site-2";

const SITE_ADMIN_CLAIMS = {
  useNewPermissions: true,
  siteRoles: { [SITE]: ["site_admin"] },
};

const ZERO = { pending: 0, complete: 0, failed: 0 };

const daysFromNow = (days: number) =>
  Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

// A currently-open administration in SITE (opened in the past, closes in the future).
const openAdmin = (syncStatus?: string) => ({
  siteId: SITE,
  dateOpened: daysFromNow(-2),
  dateClosed: daysFromNow(5),
  ...(syncStatus && { syncStatus }),
});

// An active (non-archived, non-disabled) user in SITE.
const activeUser = (syncStatus?: string) => ({
  archived: false,
  disabled: false,
  districts: { current: [SITE] },
  ...(syncStatus && { syncStatus }),
});

describe("getSyncStatus (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let getSyncStatus: HttpsCallable<{ siteId: string }, GetSyncStatusResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    getSyncStatus = client.call<{ siteId: string }, GetSyncStatusResult>(
      "getSyncStatus"
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(getSyncStatus({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing siteId
      getSyncStatus({})
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "siteId",
            message: expect.any(String),
          }),
        ]),
      },
    });
    await expect(
      // @ts-expect-error intentionally wrong type for siteId
      getSyncStatus({ siteId: 123 })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "siteId",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("rejects callers without read access to the requested site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await expect(getSyncStatus({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects migrated callers with no site roles", async () => {
    await signInAs(client, "u-no-roles", { useNewPermissions: true });
    await expect(getSyncStatus({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects callers who have not been migrated to the new permission system", async () => {
    await signInAs(client, "u-legacy", {
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await expect(getSyncStatus({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("returns all zeros for a site with no data", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);

    const { data } = await getSyncStatus({ siteId: SITE });

    expect(data).toEqual({ assignments: ZERO, users: ZERO });
  });

  it("buckets open and upcoming assignments by syncStatus, excluding closed, date-less, and off-site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    const batch = adminDb.batch();

    // Counted: open (pending/complete/failed/missing) + upcoming pending.
    batch.set(
      adminDb.doc("administrations/a-open-pending"),
      openAdmin("pending")
    );
    batch.set(
      adminDb.doc("administrations/a-open-complete"),
      openAdmin("complete")
    );
    batch.set(
      adminDb.doc("administrations/a-open-failed"),
      openAdmin("failed")
    );
    batch.set(adminDb.doc("administrations/a-open-no-status"), openAdmin()); // no syncStatus -> complete
    batch.set(adminDb.doc("administrations/a-upcoming-pending"), {
      siteId: SITE,
      dateOpened: daysFromNow(3),
      dateClosed: daysFromNow(10),
      syncStatus: "pending",
    });

    // Excluded: closed, missing dates, off-site.
    batch.set(adminDb.doc("administrations/a-closed"), {
      siteId: SITE,
      dateOpened: daysFromNow(-30),
      dateClosed: daysFromNow(-1),
      syncStatus: "pending",
    });
    batch.set(adminDb.doc("administrations/a-no-dates"), {
      siteId: SITE,
      syncStatus: "pending",
    });
    batch.set(adminDb.doc("administrations/a-other-site"), {
      ...openAdmin("pending"),
      siteId: OTHER_SITE,
    });

    await batch.commit();

    const { data } = await getSyncStatus({ siteId: SITE });

    expect(data.assignments).toEqual({ pending: 2, complete: 2, failed: 1 });
    expect(data.users).toEqual(ZERO);
  });

  it("buckets active users by syncStatus, excluding archived, disabled, and off-site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    const batch = adminDb.batch();

    // Counted.
    batch.set(adminDb.doc("users/u-pending"), activeUser("pending"));
    batch.set(adminDb.doc("users/u-complete"), activeUser("complete"));
    batch.set(adminDb.doc("users/u-failed"), activeUser("failed"));
    batch.set(adminDb.doc("users/u-no-status"), activeUser()); // no syncStatus -> complete

    // Excluded: archived, disabled, off-site.
    batch.set(adminDb.doc("users/u-archived"), {
      ...activeUser("pending"),
      archived: true,
    });
    batch.set(adminDb.doc("users/u-disabled"), {
      ...activeUser("pending"),
      disabled: true,
    });
    batch.set(adminDb.doc("users/u-other-site"), {
      ...activeUser("pending"),
      districts: { current: [OTHER_SITE] },
    });

    await batch.commit();

    const { data } = await getSyncStatus({ siteId: SITE });

    expect(data.users).toEqual({ pending: 1, complete: 2, failed: 1 });
    expect(data.assignments).toEqual(ZERO);
  });
});
