import type {
  SaveOrgInformationParams,
  SaveOrgInformationResult,
} from "@levante-framework/levante-zod";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";
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

const validSiteDraft = (): SaveOrgInformationParams => ({
  orgType: "site",
  orgId: SITE,
  formVersion: "version-1",
  responses: {
    sampleApproach: ["other"],
    sampleApproachOther: "word of mouth",
  },
  status: "draft",
});

async function seedSuperAdminClaims(uid: string) {
  await adminDb.doc(`userClaims/${uid}`).set({
    claims: { super_admin: true },
  });
}

async function seedFormVersion(
  formId: "siteInformation" | "schoolInformation",
  formVersion: string,
  fullFields: {
    variableName: string;
    kind: "text" | "number" | "single-select" | "multi-select";
    required?: boolean;
    options?: { value: string; label: string }[];
    displayLogic?: { field: string; includes: string };
  }[],
  registered = true
) {
  await adminDb.doc(`formDefinitions/${formId}/versions/${formVersion}`).set({
    fullFields,
    registered,
  });
}

const siteFields = [
  {
    variableName: "sampleApproach",
    kind: "multi-select" as const,
    required: true,
    options: [
      { value: "other", label: "Other" },
      { value: "convenience", label: "Convenience" },
    ],
  },
  {
    variableName: "sampleApproachOther",
    kind: "text" as const,
    required: true,
    displayLogic: { field: "sampleApproach", includes: "other" },
  },
  { variableName: "siteRecruitment", kind: "text" as const, required: true },
];

function dataWithoutTimestamps(data: DocumentData | undefined) {
  expect(data).toBeDefined();
  const { createdAt, updatedAt, ...rest } = data!;
  expect(createdAt).toBeInstanceOf(Timestamp);
  expect(updatedAt).toBeInstanceOf(Timestamp);
  return {
    rest,
    createdAt: createdAt as Timestamp,
    updatedAt: updatedAt as Timestamp,
  };
}

const schoolFields = [
  {
    variableName: "numTeachers",
    kind: "single-select" as const,
    required: true,
    options: [{ value: "10_to_24", label: "10-24 teachers" }],
  },
];

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

  it("rejects when the form version does not exist", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });

    await expect(saveOrgInformation(validSiteDraft())).rejects.toMatchObject({
      code: "functions/not-found",
    });
  });

  it("rejects when the form version is not registered", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields, false);

    const draft = validSiteDraft();
    await expect(saveOrgInformation(draft)).rejects.toMatchObject({
      code: "functions/failed-precondition",
      message: `Form version "${draft.formVersion}" is not registered.`,
    });
  });

  it("rejects unknown response keys", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", [
      { variableName: "sampleApproach", kind: "multi-select" },
    ]);

    await expect(
      saveOrgInformation({
        ...validSiteDraft(),
        responses: { notAField: "nope" },
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: [
          expect.objectContaining({
            path: "responses.notAField",
            message: expect.any(String),
          }),
        ],
      },
    });
  });

  it("rejects responses with the wrong value type", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await expect(
      saveOrgInformation({
        ...validSiteDraft(),
        responses: { sampleApproach: "other" },
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: [
          expect.objectContaining({
            path: "responses.sampleApproach",
            message: expect.any(String),
          }),
        ],
      },
    });
  });

  it("rejects values outside the field options", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await expect(
      saveOrgInformation({
        ...validSiteDraft(),
        responses: { sampleApproach: ["not-an-option"] },
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: [
          expect.objectContaining({
            path: "responses.sampleApproach",
            message: expect.any(String),
          }),
        ],
      },
    });
  });

  it("merges site responses onto districts/{orgId}/siteInformation/version-1", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    const { data } = await saveOrgInformation(validSiteDraft());
    expect(data).toEqual({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      status: "draft",
      path: `districts/${SITE}/siteInformation/version-1`,
    });

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    const first = dataWithoutTimestamps(snap.data());
    expect(first.rest).toEqual({
      sampleApproach: ["other"],
      sampleApproachOther: "word of mouth",
      siteId: SITE,
      formVersion: "version-1",
      status: "draft",
    });

    await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: { siteRecruitment: "email" },
      status: "complete",
    });

    const merged = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    const second = dataWithoutTimestamps(merged.data());
    expect(second.rest).toEqual({
      sampleApproach: ["other"],
      sampleApproachOther: "word of mouth",
      siteRecruitment: "email",
      siteId: SITE,
      formVersion: "version-1",
      status: "complete",
    });
    expect(second.createdAt.isEqual(first.createdAt)).toBe(true);
  });

  it("rejects complete when a required field is missing", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await expect(
      saveOrgInformation({
        orgType: "site",
        orgId: SITE,
        formVersion: "version-1",
        responses: { sampleApproach: ["convenience"] },
        status: "complete",
      })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
    });

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    expect(snap.exists).toBe(false);
  });

  it("rejects complete when a required text field is only whitespace", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await expect(
      saveOrgInformation({
        orgType: "site",
        orgId: SITE,
        formVersion: "version-1",
        responses: {
          sampleApproach: ["convenience"],
          siteRecruitment: "   ",
        },
        status: "complete",
      })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
      message: "Required fields are missing: siteRecruitment",
    });
  });

  it("rejects complete when Other is selected without Other text", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await expect(
      saveOrgInformation({
        orgType: "site",
        orgId: SITE,
        formVersion: "version-1",
        responses: {
          sampleApproach: ["other"],
          siteRecruitment: "email",
        },
        status: "complete",
      })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
    });
  });

  it("allows complete without Other text when Other is not selected", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    const { data } = await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: {
        sampleApproach: ["convenience"],
        siteRecruitment: "email",
      },
      status: "complete",
    });

    expect(data.status).toBe("complete");
  });

  it("ignores a late draft after the form is complete", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: {
        sampleApproach: ["convenience"],
        siteRecruitment: "email",
      },
      status: "complete",
    });

    const completeSnap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    const before = dataWithoutTimestamps(completeSnap.data());

    const { data } = await saveOrgInformation(validSiteDraft());
    expect(data.status).toBe("complete");

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    const after = dataWithoutTimestamps(snap.data());
    expect(after.rest).toEqual({
      sampleApproach: ["convenience"],
      siteRecruitment: "email",
      siteId: SITE,
      formVersion: "version-1",
      status: "complete",
    });
    expect(after.createdAt.isEqual(before.createdAt)).toBe(true);
    expect(after.updatedAt.isEqual(before.updatedAt)).toBe(true);
  });

  it("ignores a late school draft even if the school name is later missing", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb
      .doc(`schools/${SCHOOL}`)
      .set({ name: "School 1", districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await saveOrgInformation({
      orgType: "school",
      orgId: SCHOOL,
      formVersion: "version-2",
      responses: { numTeachers: "10_to_24" },
      status: "complete",
    });

    await adminDb.doc(`schools/${SCHOOL}`).set({ districtId: SITE });

    const { data } = await saveOrgInformation({
      orgType: "school",
      orgId: SCHOOL,
      formVersion: "version-2",
      responses: { numTeachers: "10_to_24" },
      status: "draft",
    });
    expect(data.status).toBe("complete");

    const snap = await adminDb
      .doc(`schools/${SCHOOL}/schoolInformation/version-2`)
      .get();
    expect(dataWithoutTimestamps(snap.data()).rest).toEqual({
      numTeachers: "10_to_24",
      schoolId: SCHOOL,
      siteId: SITE,
      schoolPseudonym: "School 1",
      siteName: "Site 1",
      formVersion: "version-2",
      status: "complete",
    });
  });

  it("deletes Other text when Other is unselected and the field is sent as null", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await saveOrgInformation(validSiteDraft());
    await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: {
        sampleApproach: ["convenience"],
        sampleApproachOther: null,
      },
      status: "draft",
    });

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    expect(dataWithoutTimestamps(snap.data()).rest).toEqual({
      sampleApproach: ["convenience"],
      siteId: SITE,
      formVersion: "version-1",
      status: "draft",
    });
  });

  it("treats null on a never-saved field as a no-op", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await seedFormVersion("siteInformation", "version-1", siteFields);

    await saveOrgInformation({
      orgType: "site",
      orgId: SITE,
      formVersion: "version-1",
      responses: { siteRecruitment: null },
      status: "draft",
    });

    const snap = await adminDb
      .doc(`districts/${SITE}/siteInformation/version-1`)
      .get();
    expect(dataWithoutTimestamps(snap.data()).rest).toEqual({
      siteId: SITE,
      formVersion: "version-1",
      status: "draft",
    });
  });

  it("merges school responses onto schools/{orgId}/schoolInformation/version-2", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb
      .doc(`schools/${SCHOOL}`)
      .set({ name: "School 1", districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    const { data } = await saveOrgInformation({
      orgType: "school",
      orgId: SCHOOL,
      formVersion: "version-2",
      responses: { numTeachers: "10_to_24" },
      status: "draft",
    });

    expect(data.path).toBe(`schools/${SCHOOL}/schoolInformation/version-2`);
    const snap = await adminDb
      .doc(`schools/${SCHOOL}/schoolInformation/version-2`)
      .get();
    expect(dataWithoutTimestamps(snap.data()).rest).toEqual({
      numTeachers: "10_to_24",
      schoolId: SCHOOL,
      siteId: SITE,
      schoolPseudonym: "School 1",
      siteName: "Site 1",
      formVersion: "version-2",
      status: "draft",
    });
  });

  it("rejects when the school document has no districtId", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb.doc(`schools/${SCHOOL}`).set({ name: "School 1" });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await expect(
      saveOrgInformation({
        orgType: "school",
        orgId: SCHOOL,
        formVersion: "version-2",
        responses: { numTeachers: "10_to_24" },
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      message: `districtId was not found on schools document "${SCHOOL}".`,
    });
  });

  it("rejects when the school's district document does not exist", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb
      .doc(`schools/${SCHOOL}`)
      .set({ name: "School 1", districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await expect(
      saveOrgInformation({
        orgType: "school",
        orgId: SCHOOL,
        formVersion: "version-2",
        responses: { numTeachers: "10_to_24" },
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      message: `districts document "${SITE}" was not found.`,
    });
  });

  it("rejects when the school document has no name", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb.doc(`schools/${SCHOOL}`).set({ districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await expect(
      saveOrgInformation({
        orgType: "school",
        orgId: SCHOOL,
        formVersion: "version-2",
        responses: { numTeachers: "10_to_24" },
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      message: `name was not found on schools document "${SCHOOL}".`,
    });
  });

  it("rejects when the school name is blank", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb
      .doc(`schools/${SCHOOL}`)
      .set({ name: "   ", districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await expect(
      saveOrgInformation({
        orgType: "school",
        orgId: SCHOOL,
        formVersion: "version-2",
        responses: { numTeachers: "10_to_24" },
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      message: `name was not found on schools document "${SCHOOL}".`,
    });
  });

  it("rejects when the school's district document has no name", async () => {
    await signInAs(client, SUPER_ADMIN_UID, { super_admin: true });
    await seedSuperAdminClaims(SUPER_ADMIN_UID);
    await adminDb.doc(`districts/${SITE}`).set({});
    await adminDb
      .doc(`schools/${SCHOOL}`)
      .set({ name: "School 1", districtId: SITE });
    await seedFormVersion("schoolInformation", "version-2", schoolFields);

    await expect(
      saveOrgInformation({
        orgType: "school",
        orgId: SCHOOL,
        formVersion: "version-2",
        responses: { numTeachers: "10_to_24" },
        status: "draft",
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      message: `name was not found on districts document "${SITE}".`,
    });
  });
});
