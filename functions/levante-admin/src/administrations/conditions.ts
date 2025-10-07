import _get from "lodash-es/get";
import { IUserData } from "../interfaces.js";

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

const getAge = (birthMonth: number, birthYear: number): number => {
  const today = new Date();
  const todayMonth = today.getMonth();
  const todayYear = today.getFullYear();

  let age = todayYear - birthYear;

  // If the current month is before the birth month, they haven't had their birthday this year yet.
  // If it's the same month, we assume they've had their birthday.
  if (todayMonth < birthMonth) {
    age--;
  }
  return age;
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

    if ((condition as FieldCondition).field === "age") {
      // We never use age conditions for non-student users.
      if (userData.userType !== "student") {
        return false;
      }
      fieldValue = getAge(userData.birthMonth, userData.birthYear);
    }

    const evaluationResult = evaluateFieldCondition({
      value: fieldValue,
      op: (condition as FieldCondition).op,
      referenceValue: referenceValue,
    });

    return evaluationResult;
  } else if ((condition as CompositeCondition).conditions) {
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
