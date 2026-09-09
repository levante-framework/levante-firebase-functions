import { describe, expect, it } from "vitest";
import {
  areAssessmentsComplete,
  progressKeyFromTaskId,
  rebuildAssignmentProgress,
} from "./assignment.js";

describe("progressKeyFromTaskId", () => {
  it("underscores hyphenated task ids", () => {
    expect(progressKeyFromTaskId("hearts-and-flowers")).toBe(
      "hearts_and_flowers"
    );
  });
});

describe("areAssessmentsComplete", () => {
  it("is false when a required assessment has no completedOn", () => {
    expect(
      areAssessmentsComplete([
        { taskId: "egma-math", completedOn: new Date() },
        { taskId: "hearts-and-flowers" },
      ])
    ).toBe(false);
  });

  it("treats the current task as complete", () => {
    expect(
      areAssessmentsComplete(
        [
          { taskId: "egma-math", completedOn: new Date() },
          { taskId: "hearts-and-flowers" },
        ],
        "hearts-and-flowers"
      )
    ).toBe(true);
  });

  it("treats optional assessments as complete", () => {
    expect(
      areAssessmentsComplete([
        { taskId: "egma-math", completedOn: new Date() },
        { taskId: "hearts-and-flowers", optional: true },
      ])
    ).toBe(true);
  });
});

describe("rebuildAssignmentProgress", () => {
  it("adds missing keys and drops stale ones", () => {
    expect(
      rebuildAssignmentProgress(
        [{ taskId: "hearts-and-flowers" }, { taskId: "egma-math" }],
        { egma_math: "completed", vocab: "assigned" }
      )
    ).toEqual({
      hearts_and_flowers: "assigned",
      egma_math: "completed",
    });
  });

  it("promotes existing assigned when the assessment is completed", () => {
    expect(
      rebuildAssignmentProgress(
        [{ taskId: "hearts-and-flowers", completedOn: new Date() }],
        { hearts_and_flowers: "assigned" }
      )
    ).toEqual({ hearts_and_flowers: "completed" });
  });
});
