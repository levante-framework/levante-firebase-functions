import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gapsForAssignment } from "./backfill-userdoc-assignment-progress.js";

const startedOn = new Date("2026-09-10T00:00:00.000Z");
const completedOn = new Date("2026-09-12T00:00:00.000Z");

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    started: true,
    completed: true,
    assessments: [
      { taskId: "vocab", startedOn, completedOn },
      {
        taskId: "caregiver-survey",
        startedOn: new Date("2026-09-11T00:00:00.000Z"),
        completedOn: new Date("2026-09-13T00:00:00.000Z"),
      },
    ],
    assigningOrgs: { districts: ["site-a"] },
    dateAssigned: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

const emptyMaps = {
  startedIds: [],
  completedIds: [],
  startedAt: {},
  completedAt: {},
};

describe("gapsForAssignment", () => {
  it("fills both copies from assessment timestamps when the user doc has neither", () => {
    const gap = gapsForAssignment("user-1", assignment(), emptyMaps);
    assert.ok(gap);
    assert.equal(gap.setStartedAt, startedOn.toISOString());
    assert.equal(gap.setCompletedAt, "2026-09-13T00:00:00.000Z");
    assert.equal(gap.addStarted, true);
    assert.equal(gap.addCompleted, true);
    assert.equal(gap.statsStarted, true);
    assert.equal(gap.statsCompleted, true);
    assert.equal(gap.siteId, "site-a");
  });

  it("leaves an assignment alone when the user doc already has both copies", () => {
    assert.equal(
      gapsForAssignment("user-1", assignment(), {
        startedIds: ["admin-1"],
        completedIds: ["admin-1"],
        startedAt: { "admin-1": startedOn },
        completedAt: { "admin-1": completedOn },
      }),
      null
    );
  });

  it("adds a missing list entry without repeating stats or the stored date", () => {
    const gap = gapsForAssignment("user-1", assignment(), {
      startedIds: [],
      completedIds: ["admin-1"],
      startedAt: { "admin-1": startedOn },
      completedAt: { "admin-1": completedOn },
    });
    assert.ok(gap);
    assert.equal(gap.addStarted, true);
    assert.equal(gap.setStartedAt, "");
    assert.equal(gap.statsStarted, false);
    assert.equal(gap.addCompleted, false);
    assert.equal(gap.statsCompleted, false);
  });

  it("sets a missing date without repeating stats when the list already has the id", () => {
    const gap = gapsForAssignment("user-1", assignment({ completed: false }), {
      ...emptyMaps,
      startedIds: ["admin-1"],
    });
    assert.ok(gap);
    assert.equal(gap.addStarted, false);
    assert.equal(gap.setStartedAt, startedOn.toISOString());
    assert.equal(gap.statsStarted, false);
    assert.equal(gap.addCompleted, false);
  });
});
