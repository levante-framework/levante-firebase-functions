import type {
  LoadFormDefinitionsParams,
  LoadFormDefinitionsResult,
} from "@levante-framework/levante-zod";
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
const UID = "u-user";

const validSiteLoad = (): LoadFormDefinitionsParams => ({
  orgType: "site",
  orgId: SITE,
});

const siteFields = [
  {
    itemId: "site_01",
    variableName: "sampleApproach",
    kind: "multi-select" as const,
    required: true,
    sectionId: "sampleRecruit",
    questionText: "How did you sample?",
  },
];

const schoolFields = [
  {
    itemId: "school_01",
    variableName: "numTeachers",
    kind: "single-select" as const,
    required: true,
    sectionId: "staff",
    questionText: "How many teachers?",
  },
];

const siteVersion = {
  registered: true,
  versionNumber: 1,
  generalPrompt: "Please complete.",
  sectionInfo: [
    {
      sectionId: "sampleRecruit",
      title: "Sampling",
      description: "How you sampled",
    },
  ],
  fullFields: siteFields,
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

describe("loadFormDefinitions (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let loadFormDefinitions: HttpsCallable<
    LoadFormDefinitionsParams,
    LoadFormDefinitionsResult
  >;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    client = getClient();
    loadFormDefinitions = client.call<
      LoadFormDefinitionsParams,
      LoadFormDefinitionsResult
    >("loadFormDefinitions");
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(loadFormDefinitions(validSiteLoad())).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, UID, {});
    await expect(
      // @ts-expect-error intentionally missing orgId
      loadFormDefinitions({ orgType: "site" })
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

  it("rejects when the org document does not exist", async () => {
    await signInAs(client, UID, {});

    await expect(loadFormDefinitions(validSiteLoad())).rejects.toMatchObject({
      code: "functions/not-found",
    });
  });

  it("rejects when the form definition does not exist", async () => {
    await signInAs(client, UID, {});
    await seedSite();

    await expect(loadFormDefinitions(validSiteLoad())).rejects.toMatchObject({
      code: "functions/not-found",
    });
  });

  it("rejects when there is no registered version", async () => {
    await signInAs(client, UID, {});
    await seedSite();
    await seedForm(
      "siteInformation",
      {},
      {
        draft: { ...siteVersion, registered: false },
      }
    );

    await expect(loadFormDefinitions(validSiteLoad())).rejects.toMatchObject({
      code: "functions/failed-precondition",
    });
  });

  it("returns the currentVersionId when that version is registered", async () => {
    await signInAs(client, UID, {});
    await seedSite();
    await seedForm(
      "siteInformation",
      {
        currentVersionId: "v1",
        formDescription: "Site form",
        fieldsDescription: { sampleApproach: "sampling" },
      },
      {
        v1: siteVersion,
        v2: { ...siteVersion, versionNumber: 2, fullFields: [] },
      }
    );

    const { data } = await loadFormDefinitions(validSiteLoad());
    expect(data).toEqual({
      formId: "siteInformation",
      versionId: "v1",
      versionNumber: 1,
      formDescription: "Site form",
      fieldsDescription: { sampleApproach: "sampling" },
      generalPrompt: "Please complete.",
      sectionInfo: siteVersion.sectionInfo,
      fullFields: siteFields,
      orgType: "site",
      orgId: SITE,
      savedResponses: [],
    });
  });

  it("falls back to the highest registered versionNumber when currentVersionId is missing", async () => {
    await signInAs(client, UID, {});
    await seedSite();
    await seedForm(
      "siteInformation",
      { formDescription: "Site form" },
      {
        v1: siteVersion,
        v2: {
          ...siteVersion,
          versionNumber: 2,
          fullFields: [{ ...siteFields[0], variableName: "siteRecruitment" }],
        },
      }
    );

    const { data } = await loadFormDefinitions(validSiteLoad());
    expect(data.versionId).toBe("v2");
    expect(data.versionNumber).toBe(2);
    expect(data.fullFields).toEqual([
      { ...siteFields[0], variableName: "siteRecruitment" },
    ]);
    expect(data.savedResponses).toEqual([]);
  });

  it("falls back when currentVersionId points to an unregistered version", async () => {
    await signInAs(client, UID, {});
    await seedSite();
    await seedForm(
      "siteInformation",
      { currentVersionId: "draft" },
      {
        draft: { ...siteVersion, registered: false, versionNumber: 3 },
        v1: siteVersion,
        v2: { ...siteVersion, versionNumber: 2 },
      }
    );

    const { data } = await loadFormDefinitions(validSiteLoad());
    expect(data.versionId).toBe("v2");
    expect(data.versionNumber).toBe(2);
  });

  it("loads schoolInformation for a school org", async () => {
    await signInAs(client, UID, {});
    await seedSchool();
    await seedForm(
      "schoolInformation",
      {
        currentVersionId: "v1",
        formDescription: "School form",
        fieldsDescription: {},
      },
      {
        v1: {
          registered: true,
          versionNumber: 1,
          generalPrompt: "",
          sectionInfo: [],
          fullFields: schoolFields,
        },
      }
    );

    const { data } = await loadFormDefinitions({
      orgType: "school",
      orgId: SCHOOL,
    });
    expect(data).toEqual({
      formId: "schoolInformation",
      versionId: "v1",
      versionNumber: 1,
      formDescription: "School form",
      fieldsDescription: {},
      generalPrompt: "",
      sectionInfo: [],
      fullFields: schoolFields,
      orgType: "school",
      orgId: SCHOOL,
      savedResponses: [],
    });
  });
});
