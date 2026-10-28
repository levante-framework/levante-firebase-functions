import { LANGUAGE_OTHER } from "@levante-framework/levante-zod";

export type CompleteFieldShape = {
  variableName: string;
  required: boolean;
  kind?:
    | "text"
    | "number"
    | "single-select"
    | "multi-select"
    | "language-selection";
  displayLogic?: { field: string; includes: string };
};

function isMissingValue(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null) return true;
  if (typeof value === "string" && value.trim().length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function isMissingLanguageSelection(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return true;

  const { codes, otherDescription } = value as {
    codes?: unknown;
    otherDescription?: unknown;
  };
  if (!Array.isArray(codes) || codes.length === 0) return true;
  if (!codes.includes(LANGUAGE_OTHER)) return false;
  if (typeof otherDescription !== "string") return true;
  return otherDescription.trim().length === 0;
}

function isDisplayLogicMet(
  answers: Record<string, unknown>,
  displayLogic: { field: string; includes: string }
): boolean {
  const parent = answers[displayLogic.field];
  if (Array.isArray(parent)) return parent.includes(displayLogic.includes);
  if (typeof parent === "string") return parent === displayLogic.includes;
  return false;
}

export function findMissingRequiredFields(
  answers: Record<string, unknown>,
  fields: CompleteFieldShape[]
): string[] {
  const missing: string[] = [];

  for (const field of fields) {
    if (!field.required) continue;
    if (field.displayLogic && !isDisplayLogicMet(answers, field.displayLogic)) {
      continue;
    }
    const missingThisField =
      field.kind === "language-selection"
        ? isMissingLanguageSelection(answers[field.variableName])
        : isMissingValue(answers[field.variableName]);
    if (missingThisField) {
      missing.push(field.variableName);
    }
  }

  return missing;
}
