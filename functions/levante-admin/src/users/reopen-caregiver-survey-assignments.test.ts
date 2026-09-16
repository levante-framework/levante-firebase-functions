import { describe, expect, it, vi } from "vitest";
import {
  buildReopenedCaregiverSurveyUpdates,
  isAssignmentOpen,
  reopenCaregiverSurveyAssignments,
} from "./reopen-caregiver-survey-assignments.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const opened = new Date("2026-09-01T00:00:00.000Z");
const closed = new Date("2026-10-15T00:00:00.000Z");

function openAssignment(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    dateOpened: opened,
    dateClosed: closed,
    completed: true,
    assessments: [
      {
        taskId: "caregiver-survey",
        startedOn: new Date("2026-09-10T00:00:00.000Z"),
        completedOn: new Date("2026-09-10T01:00:00.000Z"),
      },
    ],
    progress: { caregiver_survey: "completed" },
    ...overrides,
  };
}

describe("isAssignmentOpen", () => {
  it("is true when now is between dateOpened and dateClosed", () => {
    expect(
      isAssignmentOpen({ dateOpened: opened, dateClosed: closed }, now)
    ).toBe(true);
  });

  it("is false when the assignment has already closed", () => {
    expect(
      isAssignmentOpen(
        {
          dateOpened: opened,
          dateClosed: new Date("2026-09-14T00:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("is false when the assignment has not opened yet", () => {
    expect(
      isAssignmentOpen(
        {
          dateOpened: new Date("2026-09-16T00:00:00.000Z"),
          dateClosed: closed,
        },
        now
      )
    ).toBe(false);
  });

  it("is false when dates are missing", () => {
    expect(isAssignmentOpen({}, now)).toBe(false);
  });
});

describe("buildReopenedCaregiverSurveyUpdates", () => {
  it("reopens an open assignment whose caregiver survey is complete", () => {
    const updates = buildReopenedCaregiverSurveyUpdates(openAssignment(), now);
    expect(updates).toEqual({
      completed: false,
      assessments: [
        {
          taskId: "caregiver-survey",
          startedOn: new Date("2026-09-10T00:00:00.000Z"),
        },
      ],
      progress: { caregiver_survey: "started" },
    });
    expect(updates?.assessments[0]).not.toHaveProperty("completedOn");
  });

  it("leaves other completed tasks untouched", () => {
    const updates = buildReopenedCaregiverSurveyUpdates(
      openAssignment({
        assessments: [
          {
            taskId: "vocab",
            completedOn: new Date("2026-09-08T00:00:00.000Z"),
          },
          {
            taskId: "caregiver-survey",
            startedOn: new Date("2026-09-10T00:00:00.000Z"),
            completedOn: new Date("2026-09-10T01:00:00.000Z"),
          },
        ],
        progress: { vocab: "completed", caregiver_survey: "completed" },
      }),
      now
    );
    expect(updates?.completed).toBe(false);
    expect(updates?.assessments[0].completedOn).toEqual(
      new Date("2026-09-08T00:00:00.000Z")
    );
    expect(updates?.assessments[1]).not.toHaveProperty("completedOn");
    expect(updates?.progress).toEqual({
      vocab: "completed",
      caregiver_survey: "started",
    });
  });

  it("is a no-op for a closed date window", () => {
    expect(
      buildReopenedCaregiverSurveyUpdates(
        openAssignment({
          dateClosed: new Date("2026-09-14T00:00:00.000Z"),
        }),
        now
      )
    ).toBeUndefined();
  });

  it("is a no-op when the survey is not complete", () => {
    expect(
      buildReopenedCaregiverSurveyUpdates(
        openAssignment({
          completed: false,
          assessments: [
            {
              taskId: "caregiver-survey",
              startedOn: new Date("2026-09-10T00:00:00.000Z"),
            },
          ],
          progress: { caregiver_survey: "started" },
        }),
        now
      )
    ).toBeUndefined();
  });

  it("is a no-op when there is no survey task", () => {
    expect(
      buildReopenedCaregiverSurveyUpdates(
        openAssignment({
          assessments: [{ taskId: "vocab" }],
          progress: { vocab: "completed" },
        }),
        now
      )
    ).toBeUndefined();
  });

  it("is a no-op for missing assignment data", () => {
    expect(buildReopenedCaregiverSurveyUpdates(undefined, now)).toBeUndefined();
  });
});

describe("reopenCaregiverSurveyAssignments", () => {
  it("does not load assignments when no caregivers were newly linked", async () => {
    const db = { collection: vi.fn() };
    await reopenCaregiverSurveyAssignments(db as never, []);
    expect(db.collection).not.toHaveBeenCalled();
  });

  it("does not write when assignments are closed or the survey is incomplete", async () => {
    const runTransaction = vi.fn();
    const db = {
      collection: vi.fn(() => ({
        doc: () => ({
          collection: () => ({
            get: async () => ({
              docs: [
                {
                  id: "closed-admin",
                  data: () =>
                    openAssignment({
                      dateClosed: new Date("2026-09-14T00:00:00.000Z"),
                    }),
                  ref: {},
                },
                {
                  id: "incomplete-admin",
                  data: () =>
                    openAssignment({
                      completed: false,
                      assessments: [
                        {
                          taskId: "caregiver-survey",
                          startedOn: new Date("2026-09-10T00:00:00.000Z"),
                        },
                      ],
                      progress: { caregiver_survey: "started" },
                    }),
                  ref: {},
                },
              ],
            }),
          }),
        }),
      })),
      runTransaction,
    };

    await reopenCaregiverSurveyAssignments(db as never, ["cg1"], now);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("reopens an open completed caregiver survey", async () => {
    const runTransaction = vi.fn();
    const db = {
      collection: vi.fn(() => ({
        doc: () => ({
          collection: () => ({
            get: async () => ({
              docs: [
                {
                  id: "survey-admin",
                  data: () => openAssignment(),
                  ref: { path: "users/cg1/assignments/survey-admin" },
                },
              ],
            }),
          }),
        }),
      })),
      runTransaction,
    };

    await reopenCaregiverSurveyAssignments(db as never, ["cg1"], now);
    expect(runTransaction).toHaveBeenCalledOnce();
  });
});
