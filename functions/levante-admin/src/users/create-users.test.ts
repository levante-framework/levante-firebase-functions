import { describe, it, vi, expect, beforeEach } from "vitest";
import {
  createAuthUsers,
  createUserClaimsDocs,
  createUsersDocs,
  ensureOrgsExistInSite,
  enqueueUserSyncTasks,
  generateEmails,
  generateRandomString,
  lookupUsersByHashes,
  rollbackUsers,
  validateEmails,
} from "./create-users.js";
import type { Auth } from "firebase-admin/auth";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { isEmulated } from "../utils/utils.js";
import { LEVANTE_TO_ROAR_USERTYPE } from "./user-utils.js";

type NewUserRecord = Parameters<typeof createUsersDocs>[1][number];

const emptyOrgField = { current: [], all: [], dates: {} };

function makeNewUserRecord(
  uid: string,
  overrides: Partial<NewUserRecord> = {}
): NewUserRecord {
  return {
    classes: emptyOrgField,
    cohorts: emptyOrgField,
    customClaims: {
      adminUid: uid,
      roarUid: uid,
      rolesSet: [],
      siteNames: {},
      siteRoles: {},
      useNewPermissions: true,
    },
    email: `${uid}@levante.com`,
    id: `ext-${uid}`,
    idHash: `hash-${uid}`,
    password: "pw",
    passwordHash: Buffer.from("pw"),
    roles: [{ role: "participant", siteId: "site1", siteName: "Site 1" }],
    schools: emptyOrgField,
    sites: emptyOrgField,
    uid,
    userType: "teacher",
    ...overrides,
  };
}

// Records every .set() against collection/uid and optionally fails specific uids.
// With alwaysFail=false a failing uid fails only on its first attempt, so retries succeed.
function mockWriteDb(failUids = new Set<string>(), alwaysFail = false) {
  const setCalls: { collection: string; uid: string; data: unknown }[] = [];
  const attempted = new Set<string>();
  const db = {
    collection: (collection: string) => ({
      doc: (uid: string) => ({
        set: async (data: unknown) => {
          setCalls.push({ collection, uid, data });
          const fail = failUids.has(uid) && (alwaysFail || !attempted.has(uid));
          attempted.add(uid);
          if (fail) throw new Error("write failed");
        },
      }),
    }),
  } as unknown as Firestore;
  return { db, setCalls };
}

vi.mock("../utils/utils.js", () => ({
  isEmulated: vi.fn(),
}));

const mockIsEmulated = vi.mocked(isEmulated);

function mockAuth(
  impl: (
    identifiers: { email: string }[]
  ) => Promise<{ users: { email?: string }[] }>
): Auth {
  return { getUsers: vi.fn(impl) } as unknown as Auth;
}

type AuthUserShape = {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  disabled: boolean;
  customClaims: object;
  passwordHash?: Buffer;
  password?: string;
};

function makeAuthUser(uid: string, email: string): AuthUserShape {
  return {
    uid,
    email,
    emailVerified: false,
    displayName: "",
    disabled: false,
    customClaims: {
      roarUid: uid,
      adminUid: uid,
      assessmentUid: uid,
      useNewPermissions: true,
      rolesSet: [],
      siteRoles: {},
      siteNames: {},
    },
  };
}

describe("createUsers", () => {
  describe("createAuthUsers", () => {
    const user1 = makeAuthUser("uid1", "a@levante.com");
    const user2 = makeAuthUser("uid2", "b@levante.com");

    describe("emulated path", () => {
      beforeEach(() => {
        mockIsEmulated.mockReturnValue(true);
      });

      it("resolves when all createUser calls succeed", async () => {
        const auth = {
          createUser: vi.fn().mockResolvedValue({ uid: "uid1" }),
          setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
        } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1, user2] as never)
        ).resolves.toBeUndefined();
        expect(auth.createUser).toHaveBeenCalledTimes(2);
        expect(auth.setCustomUserClaims).toHaveBeenCalledTimes(2);
      });

      it("retries only the failed users", async () => {
        const createUser = vi
          .fn()
          .mockRejectedValueOnce(new Error("already exists"))
          .mockResolvedValue({ uid: "uid2" });
        const auth = {
          createUser,
          setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
        } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1, user2] as never)
        ).resolves.toBeUndefined();
        // First pass: 2 calls; retry: 1 call for the failed user
        expect(createUser).toHaveBeenCalledTimes(3);
      });

      it("throws when MAX_RETRIES is exhausted", async () => {
        const auth = {
          createUser: vi.fn().mockRejectedValue(new Error("create failed")),
          setCustomUserClaims: vi.fn(),
        } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1] as never, 3)
        ).rejects.toThrow("Maximum retries");
      });
    });

    describe("production path", () => {
      beforeEach(() => {
        mockIsEmulated.mockReturnValue(false);
      });

      it("resolves when importUsers reports no failures", async () => {
        const importUsers = vi
          .fn()
          .mockResolvedValue({ failureCount: 0, errors: [] });
        const auth = { importUsers } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1, user2] as never)
        ).resolves.toBeUndefined();
        expect(importUsers).toHaveBeenCalledTimes(1);
      });

      it("retries only the failed users", async () => {
        const importUsers = vi
          .fn()
          .mockResolvedValueOnce({ failureCount: 1, errors: [{ index: 0 }] })
          .mockResolvedValue({ failureCount: 0, errors: [] });
        const auth = { importUsers } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1, user2] as never)
        ).resolves.toBeUndefined();
        expect(importUsers).toHaveBeenCalledTimes(2);
        // Second call should only include the one failed user
        expect(importUsers.mock.calls[1][0]).toHaveLength(1);
      });

      it("throws when MAX_RETRIES is exhausted", async () => {
        const importUsers = vi
          .fn()
          .mockResolvedValue({ failureCount: 1, errors: [{ index: 0 }] });
        const auth = { importUsers } as unknown as Auth;

        await expect(
          createAuthUsers(auth, [user1] as never, 3)
        ).rejects.toThrow("Maximum retries");
      });
    });
  });

  describe("createUserClaimsDocs", () => {
    it("writes a userClaims doc holding each user's claims", async () => {
      const { db, setCalls } = mockWriteDb();
      const users = [makeNewUserRecord("uid1"), makeNewUserRecord("uid2")];

      await expect(createUserClaimsDocs(db, users)).resolves.toBeUndefined();
      expect(setCalls).toHaveLength(2);
      expect(setCalls.every((c) => c.collection === "userClaims")).toBe(true);
      expect(setCalls[0]).toMatchObject({
        uid: "uid1",
        data: { claims: users[0].customClaims },
      });
    });

    it("retries only the failed users", async () => {
      const { db, setCalls } = mockWriteDb(new Set(["uid2"]));

      await expect(
        createUserClaimsDocs(db, [
          makeNewUserRecord("uid1"),
          makeNewUserRecord("uid2"),
        ])
      ).resolves.toBeUndefined();
      // uid1 once; uid2 twice (initial failure, then retry)
      expect(setCalls.map((c) => c.uid)).toEqual(["uid1", "uid2", "uid2"]);
    });

    it("throws when MAX_RETRIES is exhausted", async () => {
      const { db } = mockWriteDb(new Set(["uid1"]), true);

      await expect(
        createUserClaimsDocs(db, [makeNewUserRecord("uid1")])
      ).rejects.toThrow("Maximum retries");
    });
  });

  describe("createUsersDocs", () => {
    it("writes a users doc with mapped fields", async () => {
      const { db, setCalls } = mockWriteDb();
      const teacher = makeNewUserRecord("uid1");

      await expect(createUsersDocs(db, [teacher])).resolves.toBeUndefined();
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]).toMatchObject({ collection: "users", uid: "uid1" });
      expect(setCalls[0].data).toMatchObject({
        uid: "uid1",
        archived: false,
        disabled: false,
        syncStatus: "pending",
        userType: LEVANTE_TO_ROAR_USERTYPE.teacher,
        email: teacher.email,
        username: "uid1",
        idHash: teacher.idHash,
        roles: teacher.roles,
        districts: teacher.sites,
        groups: teacher.cohorts,
        schools: teacher.schools,
        classes: teacher.classes,
      });
    });

    it("maps LEVANTE userType to ROAR and includes child birth fields", async () => {
      const { db, setCalls } = mockWriteDb();
      const child = makeNewUserRecord("uid1", {
        userType: "child",
        birthMonth: 6,
        birthYear: 2015,
      });

      await createUsersDocs(db, [child]);
      expect(setCalls[0].data).toMatchObject({
        userType: LEVANTE_TO_ROAR_USERTYPE.child,
        birthMonth: 6,
        birthYear: 2015,
      });
    });

    it("omits birth fields when not provided", async () => {
      const { db, setCalls } = mockWriteDb();

      await createUsersDocs(db, [makeNewUserRecord("uid1")]);
      expect(setCalls[0].data).not.toHaveProperty("birthMonth");
      expect(setCalls[0].data).not.toHaveProperty("birthYear");
    });

    it("retries only the failed users", async () => {
      const { db, setCalls } = mockWriteDb(new Set(["uid2"]));

      await expect(
        createUsersDocs(db, [
          makeNewUserRecord("uid1"),
          makeNewUserRecord("uid2"),
        ])
      ).resolves.toBeUndefined();
      expect(setCalls.map((c) => c.uid)).toEqual(["uid1", "uid2", "uid2"]);
    });

    it("throws when MAX_RETRIES is exhausted", async () => {
      const { db } = mockWriteDb(new Set(["uid1"]), true);

      await expect(
        createUsersDocs(db, [makeNewUserRecord("uid1")])
      ).rejects.toThrow("Maximum retries");
    });
  });

  describe("ensureOrgsExistInSite", () => {
    type OrgFixture = {
      id: string;
      exists: boolean;
      districtId?: string;
      parentOrgId?: string;
    };

    function mockDb(fixtures: OrgFixture[]): Firestore {
      const byId = new Map(fixtures.map((f) => [f.id, f]));
      return {
        collection: () => ({ doc: (id: string) => ({ id }) }),
        getAll: vi.fn(async (...refs: Array<{ id: string }>) =>
          refs.map((ref) => {
            const f = byId.get(ref.id);
            if (!f?.exists)
              return { exists: false, ref, data: () => undefined };
            return {
              exists: true,
              ref,
              data: () => ({
                districtId: f.districtId,
                parentOrgId: f.parentOrgId,
              }),
            };
          })
        ),
      } as unknown as Firestore;
    }

    function makeUsers(orgIds: {
      schools?: string[];
      classes?: string[];
      cohorts?: string[];
    }): Parameters<typeof ensureOrgsExistInSite>[2] {
      return [
        {
          id: "u1",
          userType: "caregiver",
          orgIds: {
            schools: orgIds.schools ?? [],
            classes: orgIds.classes ?? [],
            cohorts: orgIds.cohorts ?? [],
          },
        },
      ] as Parameters<typeof ensureOrgsExistInSite>[2];
    }

    it("resolves when all orgs exist and belong to the site via districtId", async () => {
      const db = mockDb([
        { id: "school1", exists: true, districtId: "site1" },
        { id: "class1", exists: true, districtId: "site1" },
      ]);
      await expect(
        ensureOrgsExistInSite(
          db,
          "site1",
          makeUsers({ schools: ["school1"], classes: ["class1"] })
        )
      ).resolves.toBeUndefined();
    });

    it("resolves when cohorts belong to the site via parentOrgId", async () => {
      const db = mockDb([
        { id: "cohort1", exists: true, parentOrgId: "site1" },
      ]);
      await expect(
        ensureOrgsExistInSite(db, "site1", makeUsers({ cohorts: ["cohort1"] }))
      ).resolves.toBeUndefined();
    });

    it("throws not-found when a school is missing", async () => {
      const db = mockDb([{ id: "school1", exists: false }]);
      await expect(
        ensureOrgsExistInSite(db, "site1", makeUsers({ schools: ["school1"] }))
      ).rejects.toMatchObject({ code: "not-found" });
    });

    it("throws not-found when a class is missing", async () => {
      const db = mockDb([{ id: "class1", exists: false }]);
      await expect(
        ensureOrgsExistInSite(db, "site1", makeUsers({ classes: ["class1"] }))
      ).rejects.toMatchObject({ code: "not-found" });
    });

    it("throws not-found when a cohort is missing", async () => {
      const db = mockDb([{ id: "cohort1", exists: false }]);
      await expect(
        ensureOrgsExistInSite(db, "site1", makeUsers({ cohorts: ["cohort1"] }))
      ).rejects.toMatchObject({ code: "not-found" });
    });

    it("throws invalid-argument when an org belongs to a different site", async () => {
      const db = mockDb([
        { id: "school1", exists: true, districtId: "other-site" },
      ]);
      await expect(
        ensureOrgsExistInSite(db, "site1", makeUsers({ schools: ["school1"] }))
      ).rejects.toMatchObject({ code: "invalid-argument" });
    });

    it("deduplicates org IDs across users before fetching", async () => {
      const getAll = vi.fn(async (...refs: Array<{ id: string }>) =>
        refs.map((ref) => ({
          exists: true,
          ref,
          data: () => ({ districtId: "site1" }),
        }))
      );
      const db = {
        collection: () => ({ doc: (id: string) => ({ id }) }),
        getAll,
      } as unknown as Firestore;
      const users = [
        {
          id: "u1",
          userType: "caregiver",
          orgIds: { schools: ["school1"], classes: [], cohorts: [] },
        },
        {
          id: "u2",
          userType: "caregiver",
          orgIds: { schools: ["school1"], classes: [], cohorts: [] },
        },
      ] as Parameters<typeof ensureOrgsExistInSite>[2];
      await ensureOrgsExistInSite(db, "site1", users);
      expect(getAll.mock.calls[0]).toHaveLength(1);
    });
  });

  describe("generateEmails", () => {
    it("returns the requested number of unique emails", async () => {
      const auth = mockAuth(async () => ({ users: [] }));
      const result = await generateEmails(3, auth);
      expect(result).toHaveLength(3);
      expect(new Set(result).size).toBe(3);
    });

    it("retries when all initial candidates are already taken", async () => {
      const getUsers = vi
        .fn()
        .mockImplementationOnce(async (identifiers: { email: string }[]) => ({
          // First call: mark every candidate as taken to force a retry
          users: identifiers.map(({ email }) => ({ email })),
        }))
        .mockImplementation(async () => ({ users: [] }));

      const result = await generateEmails(2, { getUsers } as unknown as Auth);
      expect(result).toHaveLength(2);
      expect(getUsers).toHaveBeenCalledTimes(2);
    });
  });

  describe("generateRandomString", () => {
    it("returns a string of length 10 by default", () => {
      expect(generateRandomString()).toHaveLength(10);
    });

    it("returns a string of the requested length", () => {
      expect(generateRandomString(5)).toHaveLength(5);
      expect(generateRandomString(20)).toHaveLength(20);
    });

    it("contains only lowercase letters and digits", () => {
      expect(generateRandomString(100)).toMatch(/^[a-z0-9]+$/);
    });
  });

  describe("lookupUsersByHashes", () => {
    function mockDoc(idHash: string, docId = idHash): DocumentSnapshot {
      return {
        id: docId,
        get: (field: string) => (field === "idHash" ? idHash : undefined),
      } as unknown as DocumentSnapshot;
    }

    function mockDb(allDocs: DocumentSnapshot[]): Firestore {
      return {
        collection: () => ({
          where: (_field: string, _op: string, hashes: string[]) => ({
            get: async () => ({
              docs: allDocs.filter((doc) =>
                hashes.includes(doc.get("idHash") as string)
              ),
            }),
          }),
        }),
      } as unknown as Firestore;
    }

    it("returns an empty map when no hashes match", async () => {
      const db = mockDb([]);
      const result = await lookupUsersByHashes(db, ["hash1", "hash2"]);
      expect(result.size).toBe(0);
    });

    it("returns a map of hash to doc for matching hashes", async () => {
      const doc1 = mockDoc("hash1", "uid1");
      const doc2 = mockDoc("hash2", "uid2");
      const db = mockDb([doc1, doc2]);
      const result = await lookupUsersByHashes(db, ["hash1", "hash2", "hash3"]);
      expect(result.size).toBe(2);
      expect(result.get("hash1")?.id).toBe("uid1");
      expect(result.get("hash2")?.id).toBe("uid2");
      expect(result.has("hash3")).toBe(false);
    });

    it("throws HttpsError('internal') when duplicate hashes exist", async () => {
      const db = mockDb([mockDoc("hash1", "uid1"), mockDoc("hash1", "uid2")]);
      await expect(lookupUsersByHashes(db, ["hash1"])).rejects.toMatchObject({
        code: "internal",
      });
    });

    it("fires multiple queries when given more than 30 hashes", async () => {
      const whereFn = vi.fn(() => ({ get: async () => ({ docs: [] }) }));
      const db = {
        collection: () => ({ where: whereFn }),
      } as unknown as Firestore;
      const hashes = Array.from({ length: 31 }, (_, i) => `hash${i}`);
      await lookupUsersByHashes(db, hashes);
      expect(whereFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("rollbackUsers", () => {
    function mockRollbackDb(commit = vi.fn().mockResolvedValue(undefined)) {
      const deletes: { collection: string; uid: string }[] = [];
      const batch = {
        delete: vi.fn((ref: { collection: string; uid: string }) => {
          deletes.push(ref);
        }),
        commit,
      };
      const db = {
        batch: () => batch,
        collection: (collection: string) => ({
          doc: (uid: string) => ({ collection, uid }),
        }),
      } as unknown as Firestore;
      return { db, deletes, commit };
    }

    it("does nothing when there are no uids", async () => {
      const deleteUsers = vi.fn();
      const auth = { deleteUsers } as unknown as Auth;
      const { db, commit } = mockRollbackDb();

      await rollbackUsers(auth, db, []);
      expect(deleteUsers).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it("deletes Auth users and both Firestore docs per uid", async () => {
      const deleteUsers = vi.fn().mockResolvedValue(undefined);
      const auth = { deleteUsers } as unknown as Auth;
      const { db, deletes, commit } = mockRollbackDb();

      await rollbackUsers(auth, db, ["uid1", "uid2"]);
      expect(deleteUsers).toHaveBeenCalledWith(["uid1", "uid2"]);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(deletes).toEqual([
        { collection: "userClaims", uid: "uid1" },
        { collection: "users", uid: "uid1" },
        { collection: "userClaims", uid: "uid2" },
        { collection: "users", uid: "uid2" },
      ]);
    });

    it("chunks Auth deletes at 1000 and Firestore batches at 250", async () => {
      const deleteUsers = vi.fn().mockResolvedValue(undefined);
      const auth = { deleteUsers } as unknown as Auth;
      const { db, commit } = mockRollbackDb();
      const uids = Array.from({ length: 1001 }, (_, i) => `uid${i}`);

      await rollbackUsers(auth, db, uids);
      expect(deleteUsers).toHaveBeenCalledTimes(2);
      expect(deleteUsers.mock.calls[0][0]).toHaveLength(1000);
      expect(deleteUsers.mock.calls[1][0]).toHaveLength(1);
      // 1001 users / 250 per batch -> 5 commits
      expect(commit).toHaveBeenCalledTimes(5);
    });

    it("swallows Auth deletion errors and still cleans up Firestore", async () => {
      const auth = {
        deleteUsers: vi.fn().mockRejectedValue(new Error("auth boom")),
      } as unknown as Auth;
      const { db, commit } = mockRollbackDb();

      await expect(rollbackUsers(auth, db, ["uid1"])).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it("swallows Firestore commit errors", async () => {
      const auth = {
        deleteUsers: vi.fn().mockResolvedValue(undefined),
      } as unknown as Auth;
      const commit = vi.fn().mockRejectedValue(new Error("commit boom"));
      const { db } = mockRollbackDb(commit);

      await expect(rollbackUsers(auth, db, ["uid1"])).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalled();
    });
  });

  describe("enqueueUserSyncTasks", () => {
    type Queue = Parameters<typeof enqueueUserSyncTasks>[0];

    function mockQueue(failUids = new Set<string>()) {
      const enqueued: string[] = [];
      const enqueue = vi.fn(async (payload: { uid: string }) => {
        if (failUids.has(payload.uid)) throw new Error("enqueue failed");
        enqueued.push(payload.uid);
      });
      return { queue: { enqueue } as unknown as Queue, enqueue, enqueued };
    }

    function mockMarkDb() {
      const updates: { uid: string; data: Record<string, unknown> }[] = [];
      const commit = vi.fn().mockResolvedValue(undefined);
      const batch = {
        update: vi.fn((ref: { uid: string }, data: Record<string, unknown>) => {
          updates.push({ uid: ref.uid, data });
        }),
        commit,
      };
      const db = {
        batch: () => batch,
        collection: () => ({ doc: (uid: string) => ({ uid }) }),
      } as unknown as Firestore;
      return { db, updates, commit };
    }

    it("marks only the failed-enqueue users and leaves successful ones untouched", async () => {
      const records = [
        makeNewUserRecord("uid1"),
        makeNewUserRecord("uid2"),
        makeNewUserRecord("uid3"),
      ];
      const { queue, enqueue, enqueued } = mockQueue(new Set(["uid2"]));
      const { db, updates, commit } = mockMarkDb();

      await enqueueUserSyncTasks(queue, db, records, "uri", "site1");

      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(enqueued).toEqual(["uid1", "uid3"]);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(updates).toEqual([
        {
          uid: "uid2",
          data: expect.objectContaining({ syncStatus: "failed" }),
        },
      ]);
    });

    it("does not touch Firestore when every enqueue succeeds", async () => {
      const records = [makeNewUserRecord("uid1"), makeNewUserRecord("uid2")];
      const { queue } = mockQueue();
      const { db, updates, commit } = mockMarkDb();

      await enqueueUserSyncTasks(queue, db, records, "uri", "site1");

      expect(updates).toEqual([]);
      expect(commit).not.toHaveBeenCalled();
    });

    it("accumulates failures across enqueue chunks", async () => {
      // > ENQUEUE_CHUNK_SIZE (50) so the work spans multiple chunks; fail one
      // uid in the first chunk and one in the second.
      const records = Array.from({ length: 60 }, (_, i) =>
        makeNewUserRecord(`uid${i}`)
      );
      const { queue } = mockQueue(new Set(["uid10", "uid55"]));
      const { db, updates } = mockMarkDb();

      await enqueueUserSyncTasks(queue, db, records, "uri", "site1");

      expect(updates.map((u) => u.uid).sort()).toEqual(["uid10", "uid55"]);
    });
  });

  describe("validateEmails", () => {
    it("returns all emails when none are already registered", async () => {
      const auth = mockAuth(async () => ({ users: [] }));
      const emails = ["a@levante.com", "b@levante.com"];
      const result = await validateEmails(emails, auth);
      expect(result).toEqual(emails);
    });

    it("filters out already-registered emails", async () => {
      const auth = mockAuth(async () => ({
        users: [{ email: "taken@levante.com" }],
      }));
      const result = await validateEmails(
        ["taken@levante.com", "free@levante.com"],
        auth
      );
      expect(result).toEqual(["free@levante.com"]);
    });

    it("returns an empty array when all emails are already taken", async () => {
      const auth = mockAuth(async (identifiers) => ({
        users: identifiers.map(({ email }) => ({ email })),
      }));
      const result = await validateEmails(
        ["a@levante.com", "b@levante.com"],
        auth
      );
      expect(result).toEqual([]);
    });
  });
});
