import { describe, expect, it } from "vitest";
import {
  type ResponseFieldShape,
  validateResponseShape,
} from "./validate-response-shape.js";

const fields: ResponseFieldShape[] = [
  { variableName: "notes", kind: "text" },
  { variableName: "schoolDayLength", kind: "number" },
  {
    variableName: "numTeachers",
    kind: "single-select",
    options: [
      { value: "10_to_24", label: "10-24" },
      { value: "25_plus", label: "25+" },
    ],
  },
  {
    variableName: "sampleApproach",
    kind: "multi-select",
    options: [
      { value: "other", label: "Other" },
      { value: "convenience", label: "Convenience" },
    ],
  },
  { variableName: "siteLanguages", kind: "language-selection" },
];

describe("validateResponseShape", () => {
  it("returns no issues for an empty payload", () => {
    expect(validateResponseShape({}, fields)).toEqual([]);
  });

  it("allows a partial payload of valid values", () => {
    expect(
      validateResponseShape({ notes: "ok", sampleApproach: ["other"] }, fields)
    ).toEqual([]);
  });

  it("rejects unknown keys", () => {
    expect(validateResponseShape({ notAField: "nope" }, fields)).toEqual([
      {
        path: "responses.notAField",
        message: 'Unknown field "notAField".',
      },
    ]);
  });

  it("accepts null on a known field", () => {
    expect(validateResponseShape({ notes: null }, fields)).toEqual([]);
  });

  it("rejects null on an unknown field", () => {
    expect(validateResponseShape({ notAField: null }, fields)).toEqual([
      {
        path: "responses.notAField",
        message: 'Unknown field "notAField".',
      },
    ]);
  });

  it("rejects a non-string text value", () => {
    expect(validateResponseShape({ notes: 1 }, fields)).toEqual([
      { path: "responses.notes", message: "Expected a string." },
    ]);
  });

  it("rejects a non-number number value", () => {
    expect(validateResponseShape({ schoolDayLength: "12" }, fields)).toEqual([
      { path: "responses.schoolDayLength", message: "Expected a number." },
    ]);
  });

  it("accepts a valid number", () => {
    expect(validateResponseShape({ schoolDayLength: 12 }, fields)).toEqual([]);
  });

  it("rejects a non-string single-select value", () => {
    expect(
      validateResponseShape({ numTeachers: ["10_to_24"] }, fields)
    ).toEqual([
      { path: "responses.numTeachers", message: "Expected a string." },
    ]);
  });

  it("rejects a single-select value outside options", () => {
    expect(validateResponseShape({ numTeachers: "12" }, fields)).toEqual([
      {
        path: "responses.numTeachers",
        message: "Value is not an allowed option.",
      },
    ]);
  });

  it("accepts a valid single-select value", () => {
    expect(validateResponseShape({ numTeachers: "10_to_24" }, fields)).toEqual(
      []
    );
  });

  it("rejects a non-array multi-select value", () => {
    expect(validateResponseShape({ sampleApproach: "other" }, fields)).toEqual([
      { path: "responses.sampleApproach", message: "Expected a string array." },
    ]);
  });

  it("rejects a multi-select array with a non-string item", () => {
    expect(validateResponseShape({ sampleApproach: [1] }, fields)).toEqual([
      { path: "responses.sampleApproach", message: "Expected a string array." },
    ]);
  });

  it("rejects a multi-select value outside options", () => {
    expect(
      validateResponseShape({ sampleApproach: ["not-an-option"] }, fields)
    ).toEqual([
      {
        path: "responses.sampleApproach",
        message: "Value is not an allowed option.",
      },
    ]);
  });

  it("accepts a valid multi-select value", () => {
    expect(
      validateResponseShape(
        { sampleApproach: ["other", "convenience"] },
        fields
      )
    ).toEqual([]);
  });

  it("collects multiple issues", () => {
    expect(
      validateResponseShape(
        { notes: 1, notAField: true, numTeachers: "12" },
        fields
      )
    ).toEqual([
      { path: "responses.notes", message: "Expected a string." },
      {
        path: "responses.notAField",
        message: 'Unknown field "notAField".',
      },
      {
        path: "responses.numTeachers",
        message: "Value is not an allowed option.",
      },
    ]);
  });

  describe("language-selection", () => {
    it("accepts ISO codes with a null description", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: ["en", "es"], otherDescription: null } },
          fields
        )
      ).toEqual([]);
    });

    it("accepts an empty codes array", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: [], otherDescription: null } },
          fields
        )
      ).toEqual([]);
    });

    it("accepts other with a description", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: {
              codes: ["other"],
              otherDescription: "Kichwa",
            },
          },
          fields
        )
      ).toEqual([]);
    });

    it("accepts mixed ISO codes and other", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: {
              codes: ["en", "other"],
              otherDescription: "Kichwa",
            },
          },
          fields
        )
      ).toEqual([]);
    });

    it("accepts null", () => {
      expect(validateResponseShape({ siteLanguages: null }, fields)).toEqual(
        []
      );
    });

    it("rejects duplicate codes", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: { codes: ["en", "en"], otherDescription: null },
          },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.codes.0",
          message: "Must be unique",
        },
        {
          path: "responses.siteLanguages.codes.1",
          message: "Must be unique",
        },
      ]);
    });

    it("rejects an alpha-3 alias", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: ["eng"], otherDescription: null } },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.codes.0",
          message: "Invalid ISO 639-1 alpha-2 code",
        },
      ]);
    });

    it("rejects free text in codes", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: ["English"], otherDescription: null } },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.codes.0",
          message: "Invalid ISO 639-1 alpha-2 code",
        },
      ]);
    });

    it("rejects an uppercase code", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: ["EN"], otherDescription: null } },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.codes.0",
          message: "Invalid ISO 639-1 alpha-2 code",
        },
      ]);
    });

    it("rejects a string value", () => {
      expect(
        validateResponseShape({ siteLanguages: "English" }, fields)
      ).toEqual([
        {
          path: "responses.siteLanguages",
          message: "Invalid input: expected object, received string",
        },
      ]);
    });

    it("rejects other with a null description", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: { codes: ["other"], otherDescription: null },
          },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.otherDescription",
          message: "Required when codes includes other",
        },
      ]);
    });

    it("rejects other with an empty description", () => {
      expect(
        validateResponseShape(
          { siteLanguages: { codes: ["other"], otherDescription: "" } },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.otherDescription",
          message: "Required when codes includes other",
        },
      ]);
    });

    it("rejects other with a whitespace-only description", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: { codes: ["other"], otherDescription: "   " },
          },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.otherDescription",
          message: "Required when codes includes other",
        },
      ]);
    });

    it("rejects a description when codes does not include other", () => {
      expect(
        validateResponseShape(
          {
            siteLanguages: { codes: ["en"], otherDescription: "Kichwa" },
          },
          fields
        )
      ).toEqual([
        {
          path: "responses.siteLanguages.otherDescription",
          message: "Must be null when codes does not include other",
        },
      ]);
    });

    it("rejects a missing otherDescription key", () => {
      expect(
        validateResponseShape({ siteLanguages: { codes: ["en"] } }, fields)
      ).toEqual([
        {
          path: "responses.siteLanguages.otherDescription",
          message: "Invalid input: expected string, received undefined",
        },
      ]);
    });
  });
});
