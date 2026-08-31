import { describe, expect, it } from "vitest";
import {
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
