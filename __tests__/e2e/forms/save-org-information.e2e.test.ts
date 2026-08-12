import type { HttpsCallable } from "firebase/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminDb,
  clearAuth,
  clearFirestore,
  getClient,
  signInAs,
} from "../app";

const SITE = "site-1";
const SCHOOL = "school-1";
const SUPER_ADMIN_UID = "u-super";
const SITE_ADMIN_UID = "u-admin";

type SaveOrgInformationParams = {
  orgType: "site" | "school";
  orgId: string;
  formVersion: string;
  responses: Record<string, unknown>;
  status: "draft" | "submitted";
};

type SaveOrgInformationResult = {
  orgType: "site" | "school";
  orgId: string;
  formVersion: string;
  status: "draft" | "submitted";
  path: string;
};

const validSiteDraft = (): SaveOrgInformationParams => ({
  orgType: "site",
  orgId: SITE,
  formVersion: "version-1",
  responses: { sampleApproach: ["other"], sampleApproachOther: "word of mouth" },
  status: "draft",
});

async function seedSuperAdminClaims(uid: string) {
  await adminDb.doc(`userClaims/${uid}`).set({
    claims: { super_admin: true },
  });
}

describe("saveOrgInformation (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let saveOrgInformation: HttpsCallable<
    SaveOrgInformationParams,
    SaveOrgInformationResult
  >;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    client = getClient();
    saveOrgInformation = client.call<
      SaveOrgInformationParams,
      SaveOrgInformationResult
    >("saveOrgInformation");
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(saveOrgInformation(validSiteDraft())).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await expect(
      // @ts-expect-error intentionally missing orgId
      saveOrgInformation({
        orgType: "site",
        formVersion: "version-1",
        responses: {},
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "orgId",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("rejects callers who are not super admins", async () => {
    await signInAs(client, SITE_ADMIN_UID, {
      useNewPermissions: true,
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await adminDb.doc(`userClaims/${SITE_ADMIN_UID}`).set({
      claims: { super_admin: false },
    });
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });

    await expect(saveOrgInformation(validSiteDraft())).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects when the org document does not exist", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);

    await expect(saveOrgInformation(validSiteDraft())).rejects.toMatchObject({
      code: "functions/not-found",
    });
  });

  it("merges site responses onto districts/{orgId}/siteInformation/response", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });

    const { data } = await saveOrgInformation(validSiteDraft());
    expect(data).toEqual({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      status: "draft",
      path: `districts/${SITE}/siteInformation/response`,
    });

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/response`)
      .get();
    expect(snap.data()).toEqual({
      sampleApproach: ["other"],
      sampleApproachOther: "word of mouth",
      formVersion: "version-1",
      status: "draft",
    });

    await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: { siteRecruitment: "email" },
      status: "submitted",
    });

    const merged = await adminDb
      .doc(`districts/${SITE}/siteInformation/response`)
      .get();
    expect(merged.data()).toEqual({
      sampleApproach: ["other"],
      sampleApproachOther: "word of mouth",
      siteRecruitment: "email",
      formVersion: "version-1",
      status: "submitted",
    });
  });

  it("merges school responses onto schools/{orgId}/schoolInformation/response", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`schools/${SCHOOL}`).set({ name: "School 1" });

    const { data } = await saveOrgInformation({
      orgType: "school",
      orgId: SCHOOL,
      formVersion: "version-2",
      responses: { numTeachers: "12" },
      status: "draft",
    });

    expect(data.path).toBe(`schools/${SCHOOL}/schoolInformation/response`);
    const snap = await adminDb
      .doc(`schools/${SCHOOL}/schoolInformation/response`)
      .get();
    expect(snap.data()).toEqual({
      numTeachers: "12",
      formVersion: "version-2",
      status: "draft",
    });
  });
});
