export const ROLES = {
  SUPER_ADMIN: "super_admin",
  SITE_ADMIN: "site_admin",
  ADMIN: "admin",
  RESEARCH_ASSISTANT: "research_assistant",
  PARTICIPANT: "participant",
};

export const LOG_SIZE = 3;

export const ADMINISTRATOR_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
};

export const FIRESTORE_SYSTEM_COLLECTION = "system";
export const FIRESTORE_PERMISSIONS_DOCUMENT = "permissions";
export const FIRESTORE_PERMISSIONS_LOGS_COLLECTION = "logs";

export const PERMISSION_LOGGING_MODE = "debug";

export const ORG_COLLECTION_TO_SUBRESOURCE = {
  districts: "sites",
  schools: "schools",
  classes: "classes",
  groups: "cohorts",
};
