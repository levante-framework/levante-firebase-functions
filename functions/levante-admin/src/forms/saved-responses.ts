import type { SavedFormResponse } from "@levante-framework/levante-zod";

export function savedResponsesFromData(
  data: Record<string, unknown> | undefined,
  formVersion: string,
  fields: { variableName: string }[]
): SavedFormResponse[] {
  if (data === undefined) return [];

  const responses: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(data, field.variableName)) continue;
    const value = data[field.variableName];
    if (value === undefined) continue;
    responses[field.variableName] = value;
  }

  return [
    {
      formVersion,
      status: data.status === "complete" ? "complete" : "draft",
      responses,
    },
  ];
}
