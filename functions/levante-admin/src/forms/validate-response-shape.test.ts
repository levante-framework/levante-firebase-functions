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
];

describe("validateResponseShape", () => {
  it("returns no issues for an empty payload", () => {
    expect(validateResponseShape({}, fields)).toEqual([]);
  });

  it("allows a partial payload of valid values", () => {
    expect(
      validateResponseShape(
        { notes: "ok", sampleApproach: ["other"] },
        fields
      )
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
    expect(validateResponseShape({ numTeachers: ["10_to_24"] }, fields)).toEqual(
      [{ path: "responses.numTeachers", message: "Expected a string." }]
    );
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
    expect(
      validateResponseShape({ numTeachers: "10_to_24" }, fields)
    ).toEqual([]);
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
});
