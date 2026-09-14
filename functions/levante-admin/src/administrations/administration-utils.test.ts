import { beforeEach, describe, expect, it, vi } from "vitest";

const filterWhere = vi.fn((field: string, op: string, value: unknown) => ({
  field,
  op,
  value,
}));
const filterAnd = vi.fn((...filters: unknown[]) => ({
  op: "and",
  filters,
}));
const getFirestore = vi.fn();

vi.mock("firebase-admin/firestore", () => ({
  FieldPath: class FieldPath {
    segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  },
  FieldValue: {},
  Filter: {
    and: (...filters: unknown[]) => filterAnd(...filters),
    where: (field: string, op: string, value: unknown) =>
      filterWhere(field, op, value),
  },
  getFirestore,
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(),
}));

vi.mock("firebase-functions/v2", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("firebase-functions/v2/https", () => ({
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("../assignments/assignment-utils.js", () => ({
  removeOrgsFromAssignments: vi.fn(),
}));

vi.mock("../assignments/assignment-sync-in-transaction.js", () => ({
  AdminStatsBufferRegistry: class AdminStatsBufferRegistry {},
}));

vi.mock("../orgs/org-utils.js", () => ({
  chunkOrgs: vi.fn(),
  getExhaustiveOrgs: vi.fn(),
  getMinimalOrgs: vi.fn(),
  getOnlyExistingOrgs: vi.fn(),
  getReadOrgs: vi.fn(),
}));

vi.mock("../utils/logging.js", () => ({
  summarizeAdministrationsForLog: vi.fn((value: unknown) => value),
  summarizeIdListForLog: vi.fn(),
  summarizeOrgsForLog: vi.fn(),
}));

const { getAdministrationsForAdministrator } = await import(
  "./administration-utils.js"
);

type AdminDoc = { data?: Record<string, unknown>; id: string };

function mockFirestore(adminDocs: AdminDoc[] = []) {
  const administrationsQuery = {
    where: vi.fn(function where() {
      return administrationsQuery;
    }),
  };

  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "administrations") {
        throw new Error(`unexpected collection ${name}`);
      }
      return administrationsQuery;
    }),
    runTransaction: vi.fn(async (cb: (transaction: unknown) => unknown) => {
      const transaction = {
        get: vi.fn(async () => ({
          docs: adminDocs.map((doc) => ({
            data: () => doc.data ?? {},
            id: doc.id,
          })),
        })),
      };
      return cb(transaction);
    }),
  };

  getFirestore.mockReturnValue(db);
  return { administrationsQuery, db };
}

describe("queryAdministrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies only the siteId filter when testData is null and open restriction is off", async () => {
    const { administrationsQuery } = mockFirestore();
    const siteFilter = { field: "siteId", op: "==", value: "site-1" };
    filterWhere.mockReturnValueOnce(siteFilter);
    const andFilter = { filters: [siteFilter], op: "and" };
    filterAnd.mockReturnValueOnce(andFilter);

    await getAdministrationsForAdministrator({
      adminUid: "admin-1",
      siteId: "site-1",
    });

    expect(filterWhere).toHaveBeenCalledTimes(1);
    expect(filterWhere).toHaveBeenCalledWith("siteId", "==", "site-1");
    expect(filterAnd).toHaveBeenCalledTimes(1);
    expect(filterAnd).toHaveBeenCalledWith(siteFilter);
    expect(administrationsQuery.where).toHaveBeenCalledTimes(1);
    expect(administrationsQuery.where).toHaveBeenCalledWith(andFilter);
  });

  it("adds a testData equality filter when testData is boolean", async () => {
    mockFirestore();

    await getAdministrationsForAdministrator({
      adminUid: "admin-1",
      siteId: "site-1",
      testData: false,
    });

    expect(filterWhere).toHaveBeenCalledWith("siteId", "==", "site-1");
    expect(filterWhere).toHaveBeenCalledWith("testData", "==", false);
    expect(filterWhere).toHaveBeenCalledTimes(2);
    expect(filterAnd.mock.calls[0]?.[0]).toEqual({
      field: "siteId",
      op: "==",
      value: "site-1",
    });
    expect(filterAnd.mock.calls[0]?.[1]).toEqual({
      field: "testData",
      op: "==",
      value: false,
    });
  });

  it("adds a dateClosed filter when restrictToOpenAdministrations is true", async () => {
    mockFirestore();
    const before = Date.now();

    await getAdministrationsForAdministrator({
      adminUid: "admin-1",
      restrictToOpenAdministrations: true,
      siteId: "site-1",
    });

    const after = Date.now();
    expect(filterWhere).toHaveBeenCalledWith(
      "dateClosed",
      ">",
      expect.any(Date)
    );
    const closedAt = filterWhere.mock.calls.find(
      (call) => call[0] === "dateClosed"
    )?.[2] as Date;
    expect(closedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(closedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("combines siteId, testData, and dateClosed filters in that order", async () => {
    mockFirestore();

    await getAdministrationsForAdministrator({
      adminUid: "admin-1",
      restrictToOpenAdministrations: true,
      siteId: "site-1",
      testData: true,
    });

    expect(filterWhere.mock.calls.map((call) => call[0])).toEqual([
      "siteId",
      "testData",
      "dateClosed",
    ]);
    expect(filterAnd).toHaveBeenCalledTimes(1);
    expect(filterAnd.mock.calls[0]).toHaveLength(3);
  });

  it("does not call where when a super admin requests all administrations", async () => {
    const userClaimsQuery = { kind: "userClaims" };
    const administrationsQuery = {
      where: vi.fn(function where() {
        return administrationsQuery;
      }),
    };
    const db = {
      collection: vi.fn((name: string) => {
        if (name === "administrations") return administrationsQuery;
        if (name === "userClaims") {
          return { where: () => userClaimsQuery };
        }
        throw new Error(`unexpected collection ${name}`);
      }),
      runTransaction: vi.fn(async (cb: (transaction: unknown) => unknown) => {
        const transaction = {
          get: vi.fn(async (query: unknown) => {
            if (query === userClaimsQuery) {
              return {
                docs: [{ data: () => ({ claims: { super_admin: true } }) }],
                empty: false,
              };
            }
            return { docs: [] };
          }),
        };
        return cb(transaction);
      }),
    };
    getFirestore.mockReturnValue(db);

    await getAdministrationsForAdministrator({
      adminUid: "super-admin",
    });

    expect(filterWhere).not.toHaveBeenCalled();
    expect(filterAnd).not.toHaveBeenCalled();
    expect(administrationsQuery.where).not.toHaveBeenCalled();
  });

  it("maps snapshot documents to { id, ...data }", async () => {
    mockFirestore([
      { data: { name: "Fall", siteId: "site-1" }, id: "admin-a" },
      { data: { name: "Spring", siteId: "site-1" }, id: "admin-b" },
    ]);

    await expect(
      getAdministrationsForAdministrator({
        adminUid: "admin-1",
        siteId: "site-1",
      })
    ).resolves.toEqual([
      { id: "admin-a", name: "Fall", siteId: "site-1" },
      { id: "admin-b", name: "Spring", siteId: "site-1" },
    ]);
  });

  it("returns an empty array when the snapshot has no documents", async () => {
    mockFirestore([]);

    await expect(
      getAdministrationsForAdministrator({
        adminUid: "admin-1",
        siteId: "site-1",
      })
    ).resolves.toEqual([]);
  });
});
