import { describe, it, expect } from "vitest";
import {
  surveyTaskIdForUserType,
  findSurveyAssessmentIndex,
} from "./save-survey-results.js";

describe("surveyTaskIdForUserType", () => {
  it.each([
    ["parent", "caregiver-survey"],
    ["caregiver", "caregiver-survey"],
    ["teacher", "teacher-survey"],
    ["student", "child-survey"],
    ["child", "child-survey"],
    ["PARENT", "caregiver-survey"],
  ])("maps %s to %s", (userType, expected) => {
    expect(surveyTaskIdForUserType(userType)).toBe(expected);
  });

  it.each([[undefined], [""], ["admin"]])(
    "returns undefined for unmapped userType %s",
    (userType) => {
      expect(surveyTaskIdForUserType(userType)).toBeUndefined();
    }
  );
});

describe("findSurveyAssessmentIndex", () => {
  it("prefers the task matching the user type over the first survey task", () => {
    const assessments = [
      { taskId: "child-survey" },
      { taskId: "caregiver-survey" },
    ];
    // Regression for bug-1031: a caregiver must not land on child-survey just
    // because it appears first in the array.
    expect(findSurveyAssessmentIndex(assessments, "parent")).toBe(1);
    expect(findSurveyAssessmentIndex(assessments, "student")).toBe(0);
  });

  it("falls back to the first survey task when no type-specific task exists", () => {
    const assessments = [{ taskId: "vocab" }, { taskId: "survey" }];
    expect(findSurveyAssessmentIndex(assessments, "parent")).toBe(1);
  });

  it("falls back to the first survey task when userType is unmapped", () => {
    const assessments = [{ taskId: "caregiver-survey" }];
    expect(findSurveyAssessmentIndex(assessments, undefined)).toBe(0);
  });

  it("returns -1 when there is no survey task", () => {
    const assessments = [{ taskId: "vocab" }, { taskId: "matrix-reasoning" }];
    expect(findSurveyAssessmentIndex(assessments, "parent")).toBe(-1);
  });
});
