// TODO: This file currently only covers the `userDataOverride` threading in
// `updateAssignmentsForUserFromAdministrations` via the create branch
// (`prepareNewAssignment`): that conditions evaluate against the stored user
// doc when no override is given, and against the overridden birth fields (while
// keeping stored orgs) when one is. Heavy dependencies (Firestore, org-utils,
// conditions, sync-in-transaction, assignment/utils/logging helpers) are mocked.
//
// A future PR should broaden coverage of this module, notably:
// - The update branch of `readPhaseForUser` (existing assignment): override
//   causing newly-qualifying assessments to be added and newly-ineligible,
//   not-yet-started assessments to be dropped, plus the in-progress retention
//   boundary (startedOn/runId assessments are kept regardless of conditions).
// - The delete path: an existing assignment removed when the override makes the
//   user ineligible for all assessments or removes org membership.
// - `addAssignmentToUsers` / `updateAssignmentForUsers` / `removeOrgsFromAssignments`
//   and `removeAssignmentFromUsers`, including their stats-registry interactions.
// - End-to-end behavior of `syncAssignmentsForUserFieldChange` (atomic field +
//   assignment write, no-op rollback on failure) belongs in the e2e suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Transaction } from "firebase-admin/firestore";

// Refs are compared by identity in the fake transaction below.
const assignmentRef = { path: "users/user1/assignments/admin1" };
const userRef = {
  path: "users/user1",
  collection: () => ({ doc: () => assignmentRef }),
};
const db = { collection: () => ({ doc: () => userRef }) };

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => db,
}));

vi.mock("../administrations/conditions.js", () => ({
  evaluateCondition: vi.fn(() => true),
}));

vi.mock("../orgs/org-utils.js", () => ({
  getReadOrgs: vi.fn(async () => ({})),
  isEmptyOrgs: vi.fn(() => false),
}));

vi.mock("./assignment-sync-in-transaction.js", () => ({
  syncOnAssignmentCreated: vi.fn(),
  syncOnAssignmentDeleted: vi.fn(),
  syncOnAssignmentUpdated: vi.fn(),
}));

vi.mock("../utils/assignment.js", () => ({
  rebuildAssignmentProgress: vi.fn(() => ({})),
  areAssessmentsComplete: vi.fn(() => false),
}));

vi.mock("../utils/utils.js", () => ({
  parseTimestamp: vi.fn(() => new Date()),
  removeUndefinedFields: vi.fn((x: unknown) => x),
}));

vi.mock("../utils/logging.js", () => ({
  summarizeAssignmentForLog: vi.fn(),
  summarizeAssessmentsForLog: vi.fn(),
  summarizeIdListForLog: vi.fn(),
}));

const { evaluateCondition } = await import("../administrations/conditions.js");
const { updateAssignmentsForUserFromAdministrations } = await import(
  "./assignment-utils.js"
);

const storedUserData = {
  districts: { current: ["site1"] },
  birthMonth: 1,
  birthYear: 2000,
};

const administrationData = {
  districts: ["site1"],
  schools: [],
  classes: [],
  groups: [],
  assessments: [
    {
      taskId: "t1",
      variantId: "v1",
      variantName: "vn1",
      conditions: { assigned: { op: "GREATER_THAN", field: "age", value: 5 } },
    },
  ],
} as never;

function setup() {
  const transaction = {
    get: vi.fn(async (ref: unknown) => {
      if (ref === assignmentRef) return { exists: false };
      if (ref === userRef)
        return { exists: true, data: () => ({ ...storedUserData }) };
      return { exists: false };
    }),
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as Transaction;
  const statsRegistry = {
    forAdministration: () => ({ recordIncrements: vi.fn(), flush: vi.fn() }),
  } as never;
  return { transaction, statsRegistry };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateAssignmentsForUserFromAdministrations userDataOverride", () => {
  it("evaluates conditions against the stored user doc when no override is given", async () => {
    const { transaction, statsRegistry } = setup();

    await updateAssignmentsForUserFromAdministrations(
      "user1",
      [{ administrationId: "admin1", administrationData }],
      transaction,
      statsRegistry
    );

    const passedUserData = (evaluateCondition as unknown as Mock).mock
      .calls[0][0].userData;
    expect(passedUserData.birthMonth).toBe(1);
    expect(passedUserData.birthYear).toBe(2000);
  });

  it("evaluates conditions against overridden birth fields while keeping stored orgs", async () => {
    const { transaction, statsRegistry } = setup();

    await updateAssignmentsForUserFromAdministrations(
      "user1",
      [{ administrationId: "admin1", administrationData }],
      transaction,
      statsRegistry,
      { birthMonth: 7, birthYear: 2010 }
    );

    const passedUserData = (evaluateCondition as unknown as Mock).mock
      .calls[0][0].userData;
    expect(passedUserData.birthMonth).toBe(7);
    expect(passedUserData.birthYear).toBe(2010);
    // Org membership is never overridden.
    expect(passedUserData.districts).toEqual({ current: ["site1"] });
  });
});
