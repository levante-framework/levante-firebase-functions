import { describe, expect, it } from "vitest";
import {
  buildReopenedTeacherSurveyUpdates,
  gapForTeacherAssignment,
  isCohortOnlyTeacher,
} from "./reopen-cohort-teacher-classroom-surveys.js";

const now = new Date("2026-10-30T12:00:00Z");
const openAssignmentDates = {
  dateOpened: new Date("2026-09-01T00:00:00Z"),
  dateClosed: new Date("2026-12-01T00:00:00Z"),
};

function surveySnap(data: Record<string, unknown>) {
  return {
    exists: true,
    ref: { path: "users/teacher-1/surveyResponses/resp-1" },
    data: () => data,
  } as any;
}

describe("isCohortOnlyTeacher", () => {
  it("matches teachers with cohorts and no classes", () => {
    expect(
      isCohortOnlyTeacher({
        userType: "teacher",
        groups: { current: ["cohort-1"] },
        classes: { current: [] },
      })
    ).toBe(true);
  });

  it("rejects teachers with classes", () => {
    expect(
      isCohortOnlyTeacher({
        userType: "teacher",
        groups: { current: ["cohort-1"] },
        classes: { current: ["class-1"] },
      })
    ).toBe(false);
  });

  it("rejects non-teachers", () => {
    expect(
      isCohortOnlyTeacher({
        userType: "student",
        groups: { current: ["cohort-1"] },
      })
    ).toBe(false);
  });
});

describe("gapForTeacherAssignment", () => {
  const assignmentData = {
    ...openAssignmentDates,
    completed: true,
    assessments: [
      {
        taskId: "teacher-survey",
        startedOn: new Date("2026-09-10T00:00:00Z"),
        completedOn: new Date("2026-09-11T00:00:00Z"),
      },
    ],
    progress: { teacher_survey: "completed" },
  };

  it("matches a completed general-only survey", () => {
    const gap = gapForTeacherAssignment({
      uid: "teacher-1",
      assignmentId: "admin-1",
      assignmentData,
      surveyResponseSnap: surveySnap({
        administrationId: "admin-1",
        general: { isComplete: true },
        specific: [],
      }),
      now,
    });

    expect(gap).toMatchObject({
      uid: "teacher-1",
      administrationId: "admin-1",
      taskId: "teacher-survey",
      generalComplete: true,
      hasGenericComplete: false,
    });
  });

  it("skips when the generic classroom part is already complete", () => {
    expect(
      gapForTeacherAssignment({
        uid: "teacher-1",
        assignmentId: "admin-1",
        assignmentData,
        surveyResponseSnap: surveySnap({
          administrationId: "admin-1",
          general: { isComplete: true },
          specific: [{ classId: "generic", isComplete: true }],
        }),
        now,
      })
    ).toBeNull();
  });

  it("skips when the assignment is not marked completed", () => {
    expect(
      gapForTeacherAssignment({
        uid: "teacher-1",
        assignmentId: "admin-1",
        assignmentData: { ...assignmentData, completed: false },
        surveyResponseSnap: surveySnap({
          administrationId: "admin-1",
          general: { isComplete: true },
        }),
        now,
      })
    ).toBeNull();
  });
});

describe("buildReopenedTeacherSurveyUpdates", () => {
  it("clears survey completion and sets progress to started", () => {
    const updates = buildReopenedTeacherSurveyUpdates({
      completed: true,
      assessments: [
        {
          taskId: "teacher-survey",
          startedOn: new Date("2026-09-10T00:00:00Z"),
          completedOn: new Date("2026-09-11T00:00:00Z"),
        },
      ],
      progress: { teacher_survey: "completed" },
    });

    expect(updates?.completed).toBe(false);
    expect(updates?.progress.teacher_survey).toBe("started");
    expect(updates?.assessments[0].completedOn).toBeUndefined();
    expect(updates?.assessments[0].startedOn).toEqual(
      new Date("2026-09-10T00:00:00Z")
    );
  });
});
