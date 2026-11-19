// NB: only `serializeTask` and `toStoredUserTypes` are covered here. The
// module's other exports still need unit tests.
import { describe, it, expect } from "vitest";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { serializeTask, toStoredUserTypes } from "./task-management-utils.js";

function makeSnap(id: string, data: Record<string, unknown>): DocumentSnapshot {
  return { id, data: () => data } as unknown as DocumentSnapshot;
}

describe("toStoredUserTypes", () => {
  it("maps LEVANTE names to the ROAR names stored in Firestore", () => {
    expect(toStoredUserTypes(["caregiver", "child", "teacher"])).toEqual([
      "parent",
      "student",
      "teacher",
    ]);
  });

  it("returns an empty array for no user types", () => {
    expect(toStoredUserTypes([])).toEqual([]);
  });
});

describe("serializeTask", () => {
  const base = { createdAt: "2024-01-01T00:00:00.000Z" };

  it("translates stored ROAR user types to LEVANTE names", () => {
    const task = serializeTask(
      makeSnap("task1", {
        ...base,
        validUserTypes: ["parent", "student", "teacher"],
      })
    );
    expect(task.validUserTypes).toEqual(["caregiver", "child", "teacher"]);
  });

  it("drops unknown and non-task (admin) user types", () => {
    const task = serializeTask(
      makeSnap("task1", {
        ...base,
        validUserTypes: ["admin", "parent", "bogus"],
      })
    );
    expect(task.validUserTypes).toEqual(["caregiver"]);
  });

  it("round-trips through toStoredUserTypes", () => {
    const levante = ["child", "teacher", "caregiver"] as const;
    const task = serializeTask(
      makeSnap("task1", { ...base, validUserTypes: toStoredUserTypes(levante) })
    );
    expect(task.validUserTypes).toEqual([...levante]);
  });

  it.each([
    ["missing", undefined],
    ["not an array", "parent"],
  ])("returns [] when validUserTypes is %s", (_label, value) => {
    const task = serializeTask(
      makeSnap("task1", { ...base, validUserTypes: value })
    );
    expect(task.validUserTypes).toEqual([]);
  });

  it.each([
    ["true", true, true],
    ["absent", undefined, false],
    ["falsey non-boolean", "yes", false],
  ])("serializes registered=%s", (_label, stored, expected) => {
    const task = serializeTask(
      makeSnap("task1", { ...base, registered: stored })
    );
    expect(task.registered).toBe(expected);
  });
});
