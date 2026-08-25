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
