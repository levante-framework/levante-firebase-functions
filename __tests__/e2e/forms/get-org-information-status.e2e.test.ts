import type {
  GetOrgInformationStatusParams,
  GetOrgInformationStatusResult,
} from "@levante-framework/levante-zod";
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
const SCHOOL = "school-1";
const UID = "u-user";

const SITE_ADMIN_CLAIMS = {
  useNewPermissions: true,
  siteRoles: { [SITE]: ["site_admin"] },
};

const siteVersion = {
  registered: true,
  versionNumber: 1,
  generalPrompt: "Please complete.",
  sectionInfo: [],
  fullFields: [],
};

async function seedSite() {
  await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
}

async function seedSchool() {
  await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
  await adminDb
    .doc(`schools/${SCHOOL}`)
    .set({ name: "School 1", districtId: SITE });
}

async function seedForm(
  formId: "siteInformation" | "schoolInformation",
  definition: Record<string, unknown>,
  versions: Record<string, Record<string, unknown>>
) {
  await adminDb.doc(`formDefinitions/${formId}`).set(definition);
  await Promise.all(
    Object.entries(versions).map(([id, data]) =>
      adminDb.doc(`formDefinitions/${formId}/versions/${id}`).set(data)
    )
  );
}

describe("getOrgInformationStatus (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let getOrgInformationStatus: HttpsCallable<
    GetOrgInformationStatusParams,
    GetOrgInformationStatusResult
  >;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    getOrgInformationStatus = client.call<
      GetOrgInformationStatusParams,
      GetOrgInformationStatusResult
    >("getOrgInformationStatus");
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [SITE] })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing orgIds
      getOrgInformationStatus({ orgType: "site" })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "orgIds",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("rejects an empty orgIds array", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [] })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "orgIds",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("rejects callers who have not been migrated to the new permission system", async () => {
    await signInAs(client, "u-legacy", {
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await seedSite();
    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [SITE] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects callers without read access to the org's site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await seedSchool();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [SITE] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(
      getOrgInformationStatus({ orgType: "school", orgIds: [SCHOOL] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects the whole call when any requested site is not allowed", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb.doc(`districts/${OTHER_SITE}`).set({ name: "Site 2" });
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    await expect(
      getOrgInformationStatus({
        orgType: "site",
        orgIds: [SITE, OTHER_SITE],
      })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects the whole call when any requested school is on a site that is not allowed", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb.doc(`districts/${OTHER_SITE}`).set({ name: "Site 2" });
    await adminDb
      .doc("schools/school-allowed")
      .set({ name: "Allowed", districtId: SITE });
    await adminDb
      .doc("schools/school-other")
      .set({ name: "Other", districtId: OTHER_SITE });
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    await expect(
      getOrgInformationStatus({
        orgType: "school",
        orgIds: ["school-allowed", "school-other"],
      })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("returns an org error when the org document does not exist", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, error: { code: "org" } }],
    });
  });

  it("returns an org error for a missing org before checking permission", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, error: { code: "org" } }],
    });
  });

  it("returns an org error when a school id is passed as a site", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SCHOOL],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SCHOOL, error: { code: "org" } }],
    });
  });

  it("returns an org-incomplete error when the school has no districtId", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await adminDb.doc(`schools/${SCHOOL}`).set({ name: "School 1" });
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgIds: [SCHOOL],
    });
    expect(data).toEqual({
      orgType: "school",
      results: [{ orgId: SCHOOL, error: { code: "org-incomplete" } }],
    });
  });

  it("rejects when the form definition document does not exist", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();

    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [SITE] })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
      details: { code: "no-current-version", id: "siteInformation" },
    });
  });

  it("rejects with no-current-version when every org is missing and the form does not exist", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);

    await expect(
      getOrgInformationStatus({ orgType: "site", orgIds: [SITE] })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
      details: { code: "no-current-version", id: "siteInformation" },
    });
  });

  it("rejects when there is no registered version", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      {},
      {
        draft: { ...siteVersion, registered: false },
      }
    );

    await expect(
      getOrgInformationStatus({ orgType: "school", orgIds: [SCHOOL] })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
      details: { code: "no-current-version", id: "schoolInformation" },
    });
  });

  it("returns not-started when the site has no saved answer", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "not-started" }],
    });
  });

  it("returns incomplete when the site answer is draft", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "incomplete" }],
    });
  });

  it("returns complete when the site answer is complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "complete",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "complete" }],
    });
  });

  it("returns not-started when the school has no saved answer", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgIds: [SCHOOL],
    });
    expect(data).toEqual({
      orgType: "school",
      results: [{ orgId: SCHOOL, progress: "not-started" }],
    });
  });

  it("returns incomplete when the school answer is draft", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`schools/${SCHOOL}/schoolInformation/v1`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgIds: [SCHOOL],
    });
    expect(data).toEqual({
      orgType: "school",
      results: [{ orgId: SCHOOL, progress: "incomplete" }],
    });
  });

  it("returns complete when the school answer is complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`schools/${SCHOOL}/schoolInformation/v1`).set({
      status: "complete",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgIds: [SCHOOL],
    });
    expect(data).toEqual({
      orgType: "school",
      results: [{ orgId: SCHOOL, progress: "complete" }],
    });
  });

  it("returns one result per school in orgIds order", async () => {
    const completeId = "school-complete";
    const draftId = "school-draft";
    const noneId = "school-none";
    const missingId = "school-missing";

    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site 1" });
    await adminDb
      .doc(`schools/${completeId}`)
      .set({ name: "Complete", districtId: SITE });
    await adminDb
      .doc(`schools/${draftId}`)
      .set({ name: "Draft", districtId: SITE });
    await adminDb
      .doc(`schools/${noneId}`)
      .set({ name: "None", districtId: SITE });
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`schools/${completeId}/schoolInformation/v1`).set({
      status: "complete",
    });
    await adminDb.doc(`schools/${draftId}/schoolInformation/v1`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgIds: [completeId, draftId, noneId, missingId],
    });
    expect(data).toEqual({
      orgType: "school",
      results: [
        { orgId: completeId, progress: "complete" },
        { orgId: draftId, progress: "incomplete" },
        { orgId: noneId, progress: "not-started" },
        { orgId: missingId, error: { code: "org" } },
      ],
    });
  });

  it("returns a result for each duplicate org id", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE, SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [
        { orgId: SITE, progress: "not-started" },
        { orgId: SITE, progress: "not-started" },
      ],
    });
  });

  it("ignores an answer saved only on another version", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v2" },
      {
        v1: siteVersion,
        v2: { ...siteVersion, versionNumber: 2 },
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "complete",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "not-started" }],
    });
  });

  it("uses the highest registered version when currentVersionId is missing", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      {},
      {
        v1: siteVersion,
        v2: { ...siteVersion, versionNumber: 2 },
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "complete",
    });
    await adminDb.doc(`districts/${SITE}/siteInformation/v2`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "incomplete" }],
    });
  });

  it("falls back when currentVersionId points to an unregistered version", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "draft" },
      {
        draft: { ...siteVersion, registered: false, versionNumber: 3 },
        v2: { ...siteVersion, versionNumber: 2 },
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/draft`).set({
      status: "complete",
    });
    await adminDb.doc(`districts/${SITE}/siteInformation/v2`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [{ orgId: SITE, progress: "incomplete" }],
    });
  });

  it("returns an unexpected-status error when the answer status is neither draft nor complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "archived",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [
        {
          orgId: SITE,
          error: { code: "unexpected-status", status: "archived" },
        },
      ],
    });
  });

  it("returns an unexpected-status error when the status is not a string", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      {
        v1: siteVersion,
      }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: 1,
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgIds: [SITE],
    });
    expect(data).toEqual({
      orgType: "site",
      results: [
        { orgId: SITE, error: { code: "unexpected-status", status: "1" } },
      ],
    });
  });
});
