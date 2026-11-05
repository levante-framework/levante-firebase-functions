import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IUserData } from "../interfaces.js";
import { evaluateCondition, type Condition } from "./conditions.js";

// July 15, 2026 is month index 6, so a January 2021 birth is 5 years and 6 months.
const TODAY = new Date(2026, 6, 15);

function user(overrides: Partial<IUserData> = {}): IUserData {
  return {
    userType: "student",
    birthMonth: 0,
    birthYear: 2021,
    ...overrides,
  } as IUserData;
}

function ageCondition(field: "age" | "ageMonths", value: number): Condition {
  return { field, op: "EQUAL", value } as Condition;
}

describe("evaluateCondition age fields", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats 5 years and 6 months as 66, and age as whole years", () => {
    const userData = user({ birthMonth: 0, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 66) })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", 5) })
    ).toBe(true);
  });

  it("counts the birth month as reached, so the same month is exact years times 12", () => {
    const userData = user({ birthMonth: 6, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 60) })
    ).toBe(true);
  });

  it("is one month short when the current month is before the birth month", () => {
    const userData = user({ birthMonth: 7, birthYear: 2021 });

    expect(
      evaluateCondition({ userData, condition: ageCondition("ageMonths", 59) })
    ).toBe(true);
    expect(
      evaluateCondition({ userData, condition: ageCondition("age", 4) })
    ).toBe(true);
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
