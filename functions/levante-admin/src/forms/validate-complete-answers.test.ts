import { describe, expect, it } from "vitest";
import {
  type CompleteFieldShape,
  findMissingRequiredFields,
} from "./validate-complete-answers.js";

const fields: CompleteFieldShape[] = [
  { variableName: "sampleApproach", required: true },
  {
    variableName: "sampleApproachOther",
    required: true,
    displayLogic: { field: "sampleApproach", includes: "other" },
  },
  { variableName: "siteRecruitment", required: true },
  { variableName: "optionalNote", required: false },
];

describe("findMissingRequiredFields", () => {
  it("returns no names when required answers are present", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["convenience"],
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual([]);
  });

  it("treats omitted required keys as missing", () => {
    expect(
      findMissingRequiredFields(
        { sampleApproach: ["convenience"] },
        fields
      )
    ).toEqual(["siteRecruitment"]);
  });

  it("treats an empty string as missing", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["convenience"],
          siteRecruitment: "",
        },
        fields
      )
    ).toEqual(["siteRecruitment"]);
  });

  it("treats null as missing", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["convenience"],
          siteRecruitment: null,
        },
        fields
      )
    ).toEqual(["siteRecruitment"]);
  });

  it("treats an empty array as missing", () => {
    expect(
      findMissingRequiredFields(
        { sampleApproach: [], siteRecruitment: "email" },
        fields
      )
    ).toEqual(["sampleApproach"]);
  });

  it("does not treat 0 as missing", () => {
    expect(
      findMissingRequiredFields({ count: 0 }, [
        { variableName: "count", required: true },
      ])
    ).toEqual([]);
  });

  it("requires Other text when Other is selected", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["other"],
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual(["sampleApproachOther"]);
  });

  it("requires Other text when Other is selected and the text is null", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["other"],
          sampleApproachOther: null,
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual(["sampleApproachOther"]);
  });

  it("does not require Other text when Other is not selected", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["convenience"],
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual([]);
  });

  it("does not require Other text when Other is cleared and the text is null", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["convenience"],
          sampleApproachOther: null,
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual([]);
  });

  it("accepts Other text when Other is selected", () => {
    expect(
      findMissingRequiredFields(
        {
          sampleApproach: ["other"],
          sampleApproachOther: "word of mouth",
          siteRecruitment: "email",
        },
        fields
      )
    ).toEqual([]);
  });
});
