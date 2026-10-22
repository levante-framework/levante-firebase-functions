import { describe, expect, it } from "vitest";
import { savedResponsesFromData } from "./saved-responses.js";

const fields = [
  { variableName: "sampleApproach" },
  { variableName: "sampleApproachOther" },
];

describe("savedResponsesFromData", () => {
  it("returns an empty array when no saved document exists", () => {
    expect(savedResponsesFromData(undefined, "v1", fields)).toEqual([]);
  });

  it("returns draft answers for the current version and drops core fields", () => {
    expect(
      savedResponsesFromData(
        {
          sampleApproach: ["other"],
          sampleApproachOther: "word of mouth",
          siteId: "site-1",
          formVersion: "v1",
          status: "draft",
        },
        "v1",
        fields
      )
    ).toEqual([
      {
        formVersion: "v1",
        status: "draft",
        responses: {
          sampleApproach: ["other"],
          sampleApproachOther: "word of mouth",
        },
      },
    ]);
  });

  it("returns complete status", () => {
    expect(
      savedResponsesFromData(
        {
          sampleApproach: ["convenience"],
          status: "complete",
        },
        "v1",
        fields
      )
    ).toEqual([
      {
        formVersion: "v1",
        status: "complete",
        responses: { sampleApproach: ["convenience"] },
      },
    ]);
  });

  it("omits field keys that were not saved", () => {
    expect(
      savedResponsesFromData(
        { sampleApproach: ["convenience"], status: "draft" },
        "v1",
        fields
      )
    ).toEqual([
      {
        formVersion: "v1",
        status: "draft",
        responses: { sampleApproach: ["convenience"] },
      },
    ]);
  });
});
