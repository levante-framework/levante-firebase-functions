import _get from "lodash-es/get.js";
import type { IUserData } from "../interfaces.js";

/**
 * Enum representing different comparison operators.
 */
enum Operator {
  LESS_THAN = "LESS_THAN",
  GREATER_THAN = "GREATER_THAN",
  LESS_THAN_OR_EQUAL = "LESS_THAN_OR_EQUAL",
  GREATER_THAN_OR_EQUAL = "GREATER_THAN_OR_EQUAL",
  EQUAL = "EQUAL",
  NOT_EQUAL = "NOT_EQUAL",
}

/**
 * Interface representing a condition based on a document field, an operator,
 * and a reference value.
 */
interface FieldCondition {
  field: string;
  op: Operator;
  value: boolean | number | string | Date;
}

/**
 * Interface representing a condition based on a composite of other conditions.
 */
interface CompositeCondition {
  op: "AND" | "OR";
  conditions: Condition[];
}

type SelectAllCondition = true;

/**
 * Type representing a condition that can be either a FieldCondition, a CompositeCondition, or a SelectAllCondition.
 */
export type Condition =
  | FieldCondition
  | CompositeCondition
  | SelectAllCondition;

/**
 * Function that evaluates a FieldCondition based on the reference value.
 *
 * @param {T} value - The value to compare against.
 * @param {Operator} op - The operator to use for comparison.
 * @param {T} referenceValue - The reference value to compare against.
 * @returns {boolean} - True if the value matches the reference value based on the operator, false otherwise.
 */
const evaluateFieldCondition = <T>({
  value,
  op,
  referenceValue,
}: {
  value: T;
  op: Operator;
  referenceValue: T;
}): boolean => {
  if (op === Operator.EQUAL) {
    return value === referenceValue;
  } else if (op === Operator.NOT_EQUAL) {
    return value !== referenceValue;
  } else if (op === Operator.LESS_THAN) {
    return value < referenceValue;
  } else if (op === Operator.GREATER_THAN) {
    return value > referenceValue;
  } else if (op === Operator.LESS_THAN_OR_EQUAL) {
    return value <= referenceValue;
  } else if (op === Operator.GREATER_THAN_OR_EQUAL) {
    return value >= referenceValue;
  }
  return false;
};

// Stored birthMonth is 1-based (January = 1). Date.getMonth() is 0-based.
const birthMonthIndex = (birthMonth: number): number => birthMonth - 1;

// The birth month counts as reached, and the day of the month is ignored.
const getAgeInMonths = (birthMonth: number, birthYear: number): number => {
  const today = new Date();
  return (
    (today.getFullYear() - birthYear) * 12 +
    (today.getMonth() - birthMonthIndex(birthMonth))
  );
};

/**
 * Function that evaluates a Condition based on the provided user data.
 *
 * @param {object} userData - The user data to evaluate the condition against.
 * @param {Condition} condition - The condition to evaluate.
 * @returns {boolean} - True if the condition is satisfied, false otherwise.
 */
export const evaluateCondition = ({
  userData,
  condition,
}: {
  userData: IUserData;
  condition: Condition;
}): boolean => {
  if ((condition as SelectAllCondition) === true) {
    return true;
  } else if ((condition as FieldCondition).field) {
    let fieldValue = _get(userData, (condition as FieldCondition).field);

    let referenceValue = (condition as FieldCondition).value;

    const field = (condition as FieldCondition).field;
    if (field === "age" || field === "ageMonths") {
      // We never use age conditions for non-student users.
      if (userData.userType !== "student") {
        return false;
      }
      const months = getAgeInMonths(userData.birthMonth, userData.birthYear);
      if (!Number.isFinite(months)) return false;
      if (field === "age") {
        const year = parseInt(String(referenceValue), 10);
        if (Number.isNaN(year)) return false;
        // floor(months / 12) is the whole-year age, so age == 5 covers that year through month 11.
        fieldValue = Math.floor(months / 12);
        referenceValue = year;
      } else {
        fieldValue = months;
      }
    }

    const evaluationResult = evaluateFieldCondition({
      value: fieldValue,
      op: (condition as FieldCondition).op,
      referenceValue: referenceValue,
    });

    return evaluationResult;
  } else if ((condition as CompositeCondition).conditions) {
    // The dashboard saves assignment conditions as one flat group with one op,
    // so a task has a single userType today. Several userTypes alone would be an
    // OR group, which this evaluates correctly. Several userTypes combined with an
    // age rule, such as (student OR parent) AND ageMonths >= 66, needs nested
    // groups on the dashboard side. Revisit this when a task can have that.
    if ((condition as CompositeCondition).op === "AND") {
      return (condition as CompositeCondition).conditions.every((_condition) =>
        evaluateCondition({ userData, condition: _condition })
      );
    } else if ((condition as CompositeCondition).op === "OR") {
      return (condition as CompositeCondition).conditions.some((_condition) =>
        evaluateCondition({ userData, condition: _condition })
      );
    }
    return false;
  }
  return false;
};
