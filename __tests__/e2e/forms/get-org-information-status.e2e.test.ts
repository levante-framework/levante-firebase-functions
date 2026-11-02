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
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing orgId
      getOrgInformationStatus({ orgType: "site" })
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

  it("rejects callers who have not been migrated to the new permission system", async () => {
    await signInAs(client, "u-legacy", {
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await seedSite();
    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
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
      { v1: siteVersion }
    );
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(
      getOrgInformationStatus({ orgType: "school", orgId: SCHOOL })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects when the org document does not exist", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "org", type: "site", id: SITE },
    });
  });

  it("rejects a school id passed as a site", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SCHOOL })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "org", type: "site", id: SCHOOL },
    });
  });

  it("rejects when the school document has no districtId", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await adminDb.doc(`schools/${SCHOOL}`).set({ name: "School 1" });

    await expect(
      getOrgInformationStatus({ orgType: "school", orgId: SCHOOL })
    ).rejects.toMatchObject({
      code: "functions/internal",
      details: { code: "org-incomplete", type: "school", id: SCHOOL },
    });
  });

  it("rejects when the form definition document does not exist", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
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
      { draft: { ...siteVersion, registered: false } }
    );

    await expect(
      getOrgInformationStatus({ orgType: "school", orgId: SCHOOL })
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
      { v1: siteVersion }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "not-started",
    });
  });

  it("returns incomplete when the site answer is draft", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "incomplete",
    });
  });

  it("returns complete when the site answer is complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "complete",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "site",
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "complete",
    });
  });

  it("returns not-started when the school has no saved answer", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgId: SCHOOL,
    });
    expect(data).toEqual({
      orgId: SCHOOL,
      orgType: "school",
      progress: "not-started",
    });
  });

  it("returns incomplete when the school answer is draft", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`schools/${SCHOOL}/schoolInformation/v1`).set({
      status: "draft",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgId: SCHOOL,
    });
    expect(data).toEqual({
      orgId: SCHOOL,
      orgType: "school",
      progress: "incomplete",
    });
  });

  it("returns complete when the school answer is complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSchool();
    await seedForm(
      "schoolInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`schools/${SCHOOL}/schoolInformation/v1`).set({
      status: "complete",
    });

    const { data } = await getOrgInformationStatus({
      orgType: "school",
      orgId: SCHOOL,
    });
    expect(data).toEqual({
      orgId: SCHOOL,
      orgType: "school",
      progress: "complete",
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
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "not-started",
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
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "incomplete",
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
      orgId: SITE,
    });
    expect(data).toEqual({
      orgId: SITE,
      orgType: "site",
      progress: "incomplete",
    });
  });

  it("rejects an answer whose status is neither draft nor complete", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: "archived",
    });

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({
      code: "functions/internal",
      details: { code: "unexpected-status", id: SITE, status: "archived" },
    });
  });

  it("rejects a non-string status with the value stringified", async () => {
    await signInAs(client, UID, SITE_ADMIN_CLAIMS);
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "v1" },
      { v1: siteVersion }
    );
    await adminDb.doc(`districts/${SITE}/siteInformation/v1`).set({
      status: 1,
    });

    await expect(
      getOrgInformationStatus({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({
      code: "functions/internal",
      details: { code: "unexpected-status", id: SITE, status: "1" },
    });
  });
});
