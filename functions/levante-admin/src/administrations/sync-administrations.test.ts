// TODO: This file currently only covers `syncAssignmentsForUserFieldChange`'s
// transaction orchestration, with its Firestore and sync dependencies mocked:
// - it runs in a single `db.runTransaction`;
// - it discovers administrations from the user's exhaustive orgs and passes only
//   currently-open ones (dropping closed and missing docs) to
//   `updateAssignmentsForUserFromAdministrations`;
// - it threads `userDataOverride` into that call;
// - it appends the user-doc field write after the assignment read/write phases
//   and then flushes stats (the ordering that keeps all reads before any write).
//
// The real end-to-end behavior it orchestrates (assignment create/delete,
// in-progress retention, stats math, and atomic rollback when the transaction
// throws) is exercised through the `updateUsersInfo` e2e suite, not here.
//
// A future PR should broaden this file to the rest of `sync-administrations`,
// which has no unit coverage: `processUserAddedOrgs`,
// `processRemovedAdministration`, and the add/update/remove task-enqueue paths.
// It could also assert the rollback path when a dependency throws (currently
// e2e-only) and the read-before-write ordering across `getExhaustiveOrgs` /
// `getAdministrationsFromOrgs`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirestore: vi.fn(),
  getExhaustiveOrgs: vi.fn(),
  getAdministrationsFromOrgs: vi.fn(),
  updateAssignmentsForUserFromAdministrations: vi.fn(),
  parseTimestamp: vi.fn(),
  registryFlush: vi.fn(),
  registryForAdministration: vi.fn(),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: mocks.getFirestore,
  FieldValue: { serverTimestamp: vi.fn(() => "TS") },
  Timestamp: class {},
  Filter: {},
}));

vi.mock("firebase-functions/v2", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("firebase-admin/functions", () => ({ getFunctions: vi.fn() }));

vi.mock("../orgs/org-utils.js", () => ({
  getExhaustiveOrgs: mocks.getExhaustiveOrgs,
  getOnlyExistingOrgs: vi.fn(),
  getUsersFromOrgs: vi.fn(),
}));

vi.mock("../assignments/assignment-utils.js", () => ({
  removeAssignmentFromUsers: vi.fn(),
  updateAssignmentsForUserFromAdministrations:
    mocks.updateAssignmentsForUserFromAdministrations,
}));

vi.mock("../assignments/admin-stats-buffer.js", () => ({
  AdminStatsBufferRegistry: vi.fn(() => ({
    flush: mocks.registryFlush,
    forAdministration: mocks.registryForAdministration,
  })),
}));

vi.mock("./administration-utils.js", () => ({
  getAdministrationsFromOrgs: mocks.getAdministrationsFromOrgs,
  standardizeAdministrationOrgs: vi.fn(),
}));

vi.mock("../utils/logging.js", () => ({
  summarizeIdListForLog: vi.fn(),
  summarizeOrgsForLog: vi.fn(),
}));

vi.mock("../utils/utils.js", () => ({
  getFunctionUrl: vi.fn(),
  MAX_TRANSACTIONS: 500,
  parseTimestamp: mocks.parseTimestamp,
}));

const { syncAssignmentsForUserFieldChange } = await import(
  "./sync-administrations.js"
);

type AdminDoc = { exists: boolean; data?: () => Record<string, unknown> };

// Builds a fake db/transaction. `administrations` is what getAdministrationsFromOrgs
// returns; `adminDocs` maps an administration id to the doc transaction.get sees.
function setup({
  administrations,
  adminDocs = {},
  exhaustiveOrgs = {},
}: {
  administrations: string[];
  adminDocs?: Record<string, AdminDoc>;
  exhaustiveOrgs?: Record<string, unknown>;
}) {
  const transaction = {
    get: vi.fn(
      async (ref: { id: string }) => adminDocs[ref.id] ?? { exists: false }
    ),
    update: vi.fn(),
  };
  const administrationsColl = {
    doc: vi.fn((id: string) => ({ id, path: `administrations/${id}` })),
  };
  const usersColl = {
    doc: vi.fn((id: string) => ({ id, path: `users/${id}` })),
  };
  const db = {
    collection: vi.fn((name: string) =>
      name === "administrations" ? administrationsColl : usersColl
    ),
    runTransaction: vi.fn(
      async (cb: (t: typeof transaction) => Promise<void>) => cb(transaction)
    ),
  };
  mocks.getFirestore.mockReturnValue(db);
  mocks.getExhaustiveOrgs.mockResolvedValue(exhaustiveOrgs);
  mocks.getAdministrationsFromOrgs.mockResolvedValue({ administrations });
  mocks.parseTimestamp.mockImplementation((v: unknown) => v);
  return { db, transaction };
}

const future = () => new Date(Date.now() + 365 * 86_400_000);
const past = () => new Date(Date.now() - 86_400_000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncAssignmentsForUserFieldChange", () => {
  it("resyncs open administrations with the override, then writes the field change and flushes stats in one transaction", async () => {
    const dateClosed = future();
    const { db, transaction } = setup({
      administrations: ["adminA"],
      adminDocs: {
        adminA: { exists: true, data: () => ({ dateClosed, name: "adminA" }) },
      },
    });
    const currentOrgs = {
      districts: ["site1"],
      schools: [],
      classes: [],
      groups: [],
    };
    const userDocUpdate = { birthYear: 2015, birthDateUpdatedAt: "TS" };
    const userDataOverride = { birthMonth: 5, birthYear: 2015 };

    await syncAssignmentsForUserFieldChange(
      "user1",
      currentOrgs,
      userDocUpdate,
      userDataOverride
    );

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.getExhaustiveOrgs).toHaveBeenCalledWith({
      orgs: currentOrgs,
      transaction,
      includeArchived: false,
    });
    expect(mocks.getAdministrationsFromOrgs).toHaveBeenCalledWith({
      orgs: expect.anything(),
      transaction,
      restrictToOpenAdministrations: true,
    });

    // The open administration is synced with the override threaded through.
    const call =
      mocks.updateAssignmentsForUserFromAdministrations.mock.calls[0];
    expect(call[0]).toBe("user1");
    expect(call[1]).toEqual([
      {
        administrationId: "adminA",
        administrationData: { dateClosed, name: "adminA" },
      },
    ]);
    expect(call[2]).toBe(transaction);
    expect(call[4]).toBe(userDataOverride);

    // The field change is persisted on the user doc, and stats are flushed.
    expect(transaction.update).toHaveBeenCalledWith(
      { id: "user1", path: "users/user1" },
      userDocUpdate
    );
    expect(mocks.registryFlush).toHaveBeenCalledWith(transaction);
  });

  it("drops closed and missing administrations, syncing only open ones", async () => {
    const dateClosed = future();
    setup({
      administrations: ["openAdmin", "closedAdmin", "missingAdmin"],
      adminDocs: {
        openAdmin: { exists: true, data: () => ({ dateClosed }) },
        closedAdmin: { exists: true, data: () => ({ dateClosed: past() }) },
        // missingAdmin is absent, so transaction.get reports { exists: false }.
      },
    });

    await syncAssignmentsForUserFieldChange(
      "user1",
      { districts: ["site1"] },
      {},
      {}
    );

    const synced =
      mocks.updateAssignmentsForUserFromAdministrations.mock.calls[0][1];
    expect(synced).toEqual([
      { administrationId: "openAdmin", administrationData: { dateClosed } },
    ]);
  });

  it("appends the field write after the assignment sync and before the stats flush", async () => {
    const { transaction } = setup({
      administrations: ["adminA"],
      adminDocs: {
        adminA: { exists: true, data: () => ({ dateClosed: future() }) },
      },
    });

    await syncAssignmentsForUserFieldChange(
      "user1",
      { districts: ["site1"] },
      { birthYear: 2015 },
      {}
    );

    const syncOrder =
      mocks.updateAssignmentsForUserFromAdministrations.mock
        .invocationCallOrder[0];
    const updateOrder = (transaction.update as Mock).mock
      .invocationCallOrder[0];
    const flushOrder = mocks.registryFlush.mock.invocationCallOrder[0];
    expect(syncOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(flushOrder);
  });
});
