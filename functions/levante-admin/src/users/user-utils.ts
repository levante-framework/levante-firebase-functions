export const LEVANTE_TO_ROAR_USERTYPE = {
  admin: "admin",
  caregiver: "parent",
  child: "student",
  teacher: "teacher",
} as const;

export const ROAR_TO_LEVANTE_USERTYPE = {
  admin: "admin",
  parent: "caregiver",
  student: "child",
  teacher: "teacher",
} as const;

export function isRoarUserType(
  value: unknown
): value is keyof typeof ROAR_TO_LEVANTE_USERTYPE {
  return typeof value === "string" && value in ROAR_TO_LEVANTE_USERTYPE;
}
