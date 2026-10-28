export type ResponseFieldShape = {
  variableName: string;
  kind: "text" | "number" | "single-select" | "multi-select";
  options?: { value: string; label: string }[];
};

export type ResponseShapeIssue = {
  path: string;
  message: string;
};

function optionValues(field: ResponseFieldShape): Set<string> {
  return new Set((field.options ?? []).map((option) => option.value));
}

export function validateResponseShape(
  responses: Record<string, unknown>,
  fields: ResponseFieldShape[]
): ResponseShapeIssue[] {
  const fieldsByName = new Map(
    fields.map((field) => [field.variableName, field])
  );
  const issues: ResponseShapeIssue[] = [];

  for (const [key, value] of Object.entries(responses)) {
    const path = `responses.${key}`;
    const field = fieldsByName.get(key);

    if (!field) {
      issues.push({
        path,
        message: `Unknown field "${key}".`,
      });
      continue;
    }

    if (value === null) continue;

    if (field.kind === "text") {
      if (typeof value !== "string") {
        issues.push({ path, message: "Expected a string." });
      }
      continue;
    }

    if (field.kind === "number") {
      if (typeof value !== "number") {
        issues.push({ path, message: "Expected a number." });
      }
      continue;
    }

    const allowed = optionValues(field);

    if (field.kind === "single-select") {
      if (typeof value !== "string") {
        issues.push({ path, message: "Expected a string." });
        continue;
      }
      if (!allowed.has(value)) {
        issues.push({ path, message: "Value is not an allowed option." });
      }
      continue;
    }

    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      issues.push({ path, message: "Expected a string array." });
      continue;
    }
    if (value.some((item) => !allowed.has(item))) {
      issues.push({ path, message: "Value is not an allowed option." });
    }
  }

  return issues;
}
