import { describe, expect, it } from "vitest";
import {
  isAssignmentCompletedFromProgress,
  progressKeyForTaskId,
} from "./update-best-run-and-completion.js";

describe("progressKeyForTaskId", () => {
  it("keeps underscore task IDs unchanged", () => {
    expect(progressKeyForTaskId("vocab")).toBe("vocab");
  });

  it("maps hyphenated task IDs to the stored progress key", () => {
    expect(progressKeyForTaskId("hearts-and-flowers")).toBe(
      "hearts_and_flowers"
    );
  });
});

describe("isAssignmentCompletedFromProgress", () => {
  it("marks the assignment complete when the last hyphenated task finishes", () => {
    const progress = {
      hearts_and_flowers: "started",
      vocab: "completed",
    };

    expect(
      isAssignmentCompletedFromProgress(
        progress,
        "hearts-and-flowers",
        "completed"
      )
    ).toBe(true);
  });

  it("does not treat a stale hyphen key as the stored progress entry", () => {
    const progress = {
      hearts_and_flowers: "started",
    };

    expect(
      isAssignmentCompletedFromProgress(
        progress,
        "hearts-and-flowers",
        "completed"
      )
    ).toBe(true);
  });

  it("keeps the assignment incomplete when another task is still open", () => {
    const progress = {
      hearts_and_flowers: "started",
      vocab: "assigned",
    };

    expect(
      isAssignmentCompletedFromProgress(
        progress,
        "hearts-and-flowers",
        "completed"
      )
    ).toBe(false);
  });
});
