import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IUserData } from "../interfaces.js";
import { evaluateCondition, type Condition } from "./conditions.js";

// July 15, 2026. birthMonth is 1-based (January = 1), so a January 2021 birth is 5 years and 6 months.
const TODAY = new Date(2026, 6, 15);

function user(overrides: Partial<IUserData> = {}): IUserData {
  return {
    userType: "student",
    birthMonth: 1,
    birthYear: 2021,
    ...overrides,
  } as IUserData;
}

function ageCondition(
  field: "age" | "ageMonths",
  value: number | string,
  op = "EQUAL"
): Condition {
  return { field, op, value } as Condition;
}

describe("evaluateCondition age fields", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats 5 years and 6 months as 66, inside the stored year 5", () => {
    const userData = user({ birthMonth: 1, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 66) })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", "5") })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", 5) })
    ).toBe(true);
  });

  it("counts the birth month as reached, the lower bound of that year", () => {
    const userData = user({ birthMonth: 7, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 60) })
    ).toBe(true);
    expect(
      evaluateCondition({
        userData,
        condition: ageCondition("age", "5", "GREATER_THAN_OR_EQUAL"),
      })
    ).toBe(true);
    expect(
      evaluateCondition({
        userData,
        condition: ageCondition("age", "5", "GREATER_THAN"),
      })
    ).toBe(false);
  });

  it("is one month short when the current month is before the birth month", () => {
    const userData = user({ birthMonth: 8, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 59) })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", 4) })
    ).toBe(true);
  });

  it("treats 72 months as older than year 5 and inside year 6", () => {
    const userData = user({ birthMonth: 7, birthYear: 2020 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 72) })
    ).toBe(true);
    expect(
      evaluateCondition({
        userData,
        condition: ageCondition("age", "5", "GREATER_THAN"),
      })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", "5") })
    ).toBe(false);
    expect(
      evaluateCondition({
        userData,
        condition: ageCondition("age", "5", "LESS_THAN_OR_EQUAL"),
      })
    ).toBe(false);
  });

  it("fails age and ageMonths conditions for non-student users", () => {
    const userData = user({ userType: "teacher" });

    expect(
      evaluateCondition({ userData, condition: ageCondition("age", 5) })
    ).toBe(false);
    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 66) })
    ).toBe(false);
  });
});
