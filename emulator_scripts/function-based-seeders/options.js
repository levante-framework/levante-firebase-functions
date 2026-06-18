const VALID_PROFILES = new Set([
  "dashboard",
  "large",
  "minimal",
  "no-administrations",
  "tasks-only",
]);

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function parseInteger(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function getTaskSourceProject(env = process.env) {
  return (
    env.SEED_TASK_SOURCE_PROJECT ||
    env.TASKS_SOURCE_PROJECT ||
    "hs-levante-admin-dev"
  );
}

function getFunctionsSeedOptions(env = process.env) {
  const requestedProfile = env.SEED_PROFILE || "dashboard";
  const profile = VALID_PROFILES.has(requestedProfile)
    ? requestedProfile
    : "dashboard";
  if (profile !== requestedProfile) {
    console.warn(
      `Unknown SEED_PROFILE "${requestedProfile}"; falling back to "dashboard".`
    );
  }

  const defaultStudentCount = profile === "large" ? 200 : 20;
  const studentCount = parseInteger(
    env.SEED_STUDENT_COUNT,
    defaultStudentCount
  );

  return {
    profile,
    sourceProjectId: getTaskSourceProject(env),
    superAdminEmail: env.E2E_AI_SUPER_ADMIN_EMAIL || "superadmin@levante.test",
    superAdminPassword: env.E2E_AI_SUPER_ADMIN_PASSWORD || "super123",
    studentCount,
    includeAdministrations: ![
      "minimal",
      "no-administrations",
      "tasks-only",
    ].includes(profile),
    includeOptionalAdministrationTemplates: parseBoolean(
      env.SEED_INCLUDE_OPTIONAL_ADMINISTRATION_TEMPLATES,
      false
    ),
    validate: parseBoolean(
      env.SEED_VALIDATE,
      profile !== "tasks-only" && profile !== "minimal"
    ),
  };
}

module.exports = { getFunctionsSeedOptions, getTaskSourceProject };
