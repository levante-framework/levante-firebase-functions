export type CompleteFieldShape = {
  variableName: string;
  required: boolean;
  displayLogic?: { field: string; includes: string };
};

function isMissingValue(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null) return true;
  if (typeof value === "string" && value.trim().length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
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
    if (isMissingValue(answers[field.variableName])) {
      missing.push(field.variableName);
    }
  }

  return missing;
}
