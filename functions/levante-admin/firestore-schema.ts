import * as admin from "firebase-admin";

/** Firestore Timestamp type alias. */
export type Timestamp = admin.firestore.Timestamp;

/** Generic structure for organization references used in multiple places. */
export interface OrgRefMap {
  classes: string[];
  districts: string[];
  families: string[];
  groups: string[];
  schools: string[];
}

/** Assessment condition rule within an administration. */
export interface AssessmentConditionRule {
  /** e.g. `"userType"`. */
  field: string;
  /** e.g. `"EQUAL"`, `"AND"`. */
  op: string;
  /** e.g. `"student"`. */
  value: string | number | boolean | null;
}

/** Assessment conditions within an administration. */
export interface AssessmentConditions {
  /** Structure needs clarification based on usage. */
  assigned: Record<string, unknown>;
  conditions: AssessmentConditionRule[];
}

/** Individual assessment within an administration. */
export interface Assessment {
  conditions: AssessmentConditions;
  /** Parameters specific to the task. */
  params: Record<string, unknown>;
  /** e.g. `"egma-math"`. */
  taskName: string;
  /** e.g. `"egma-math"`. */
  taskId: string;
  /** Reference to a task variant. */
  variantId: string;
  /** e.g. `"es-CO"`. */
  variantName: string;
}

/** Legal information within administrations and assignedOrgs. */
export interface LegalInfo {
  amount: string;
  assent: string | null;
  consent: string | null;
  expectedTime: string;
}

/**
 * Document in the `administrations` collection.
 * Stores metadata about each administration (assignment) including the sequence of
 * tasks, involved organizations, and visibility control.
 */
export interface Administration {
  assessments: Assessment[];
  /** Document IDs from the `classes` collection. */
  classes: string[];
  /** User UID. */
  createdBy: string;
  creatorName: string;
  dateClosed: Timestamp;
  dateCreated: Timestamp;
  dateOpened: Timestamp;
  /** Document IDs from the `districts` collection. */
  districts: string[];
  /** Document IDs from the `families` collection. */
  families: string[];
  /** Document IDs from the `groups` collection. */
  groups: string[];
  legal: LegalInfo;
  minimalOrgs: OrgRefMap;
  /** Internal name. */
  name: string;
  /** Public-facing name. */
  publicName: string;
  readOrgs: OrgRefMap;
  /** Document IDs from the `schools` collection. */
  schools: string[];
  sequential: boolean;
  siteId: string;
  syncChunksCompleted?: number;
  syncChunksTotal?: number;
  syncErrorMessage?: string;
  syncStatus?: "pending" | "complete" | "failed";
  tags: string[];
  testData: boolean;
}

/** Document in the `assignedOrgs` subcollection of `administrations`. */
export interface AssignedOrg {
  administrationId: string;
  /** User UID of the administration creator. */
  createdBy: string;
  /** Copied from administration. */
  dateClosed: Timestamp;
  /** Timestamp of assignment creation or copied from admin; needs clarification. */
  dateCreated: Timestamp;
  /** Copied from administration. */
  dateOpened: Timestamp;
  /** Copied from administration. */
  legal: LegalInfo;
  /** Copied from administration. */
  name: string;
  /** Document ID of the assigned organization. */
  orgId: string;
  /** Type of the assigned organization. */
  orgType: "classes" | "districts" | "families" | "groups" | "schools";
  /** Copied from administration. */
  publicName: string;
  /** Copied from administration. */
  testData: boolean;
  /** Timestamp of assignment creation/update. */
  timestamp: Timestamp;
}

/** Document in the `readOrgs` subcollection of `administrations`. */
export interface ReadOrg {
  administrationId: string;
  /** User UID of the administration creator. */
  createdBy: string;
  /** Copied from administration. */
  dateClosed: Timestamp;
  /** Timestamp of assignment creation or copied from admin; needs clarification. */
  dateCreated: Timestamp;
  /** Copied from administration. */
  dateOpened: Timestamp;
  /** Copied from administration. */
  legal: LegalInfo;
  /** Copied from administration. */
  name: string;
  /** Document ID of the assigned organization. */
  orgId: string;
  /** Type of the assigned organization. */
  orgType: "classes" | "districts" | "families" | "groups" | "schools";
  /** Copied from administration. */
  publicName: string;
  /** Copied from administration. */
  testData: boolean;
  /** Timestamp of assignment creation/update. */
  timestamp: Timestamp;
}

/** Document in the `stats` subcollection of `administrations`. */
export interface Stat {
  assignment: Record<string, number>;
  survey: Record<string, number>;
}

/**
 * Document in the `classes` collection.
 * Details about classes, including school affiliation and optional educational details.
 */
export interface Class {
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** User UID. */
  createdBy: string;
  districtId: string;
  /** Same as document ID. */
  id: string;
  name: string;
  schoolId: string;
}

/**
 * Document in the `districts` collection.
 * Manages information about districts (sites), including associated schools.
 */
export interface District {
  archived: boolean;
  createdAt: Timestamp;
  /** User UID. */
  createdBy: string;
  updatedAt: Timestamp;
  name: string;
  tags: string[];
  subGroups?: string[];
  schools?: string[];
}

/**
 * Document in the `groups` collection.
 * Manages group (cohort) data, potentially representing subgroups within a district (site).
 * Catch-all type for when a group of users does not fit into a traditional org type.
 */
export interface Group {
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** User UID. */
  createdBy: string;
  /** Document ID of the parent organization. */
  parentOrgId: string;
  /** Type of the parent organization. */
  parentOrgType: "district";
  name: string;
  tags: string[];
}

/**
 * Document in the `schools` collection.
 * Contains data about schools, including their districts.
 */
export interface School {
  archived: boolean;
  /** Document IDs of classes. */
  classes?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** User UID. */
  createdBy: string;
  districtId: string;
  /** Same as document ID. */
  id: string;
  name: string;
}

/**
 * Org information forms: the `formDefinitions` collection and response subcollections.
 */

/**
 * Document in the `siteInformation` subcollection of `districts`.
 * Optional subcollection: a district document may or may not have siteInformation.
 * Allowed values for select fields are sourced from the runtime form definition,
 * so they are typed as strings here rather than hardcoded literal unions.
 */
export interface SiteInformation {
  siteId: string;
  /**
   * Document ID of the form definition version this response was collected against
   * (`formDefinitions/siteInformation/versions/{versionId}`).
   */
  formVersion: string;
  sampleApproach: string[];
  /** Only populated when `sampleApproach` includes `"other"`. */
  sampleApproachOther?: string;
  siteRecruitment: string;
  adminApproach: string[];
  /** Only populated when `adminApproach` includes `"other"`. */
  adminApproachOther?: string;
  testConditions: string;
  equipmentType: string[];
  equipmentDevices: string;
  siteGeoArea: string;
  siteGeoType: string;
  sitePopulationSize: string;
  siteRaceEthnicity: string;
  siteSES: string;
  siteLifestyle: string;
  siteTech: string;
  siteLanguages: string;
  siteSubsistence: string[];
  schoolingAgeStart: number;
  schoolingAgeEnd: number;
  schoolingProgression: string;
  schoolingTeacherQuals: string;
  anythingElse?: string;
}

/**
 * Document in the `schoolInformation` subcollection of `schools`.
 * Optional subcollection: a school document may or may not have schoolInformation.
 * Allowed values for select fields are sourced from the runtime form definition,
 * so they are typed as strings here rather than hardcoded literal unions.
 */
export interface SchoolInformation {
  siteId: string;
  siteName: string;
  schoolId: string;
  schoolPseudonym: string;
  /**
   * Document ID of the form definition version this response was collected against
   * (`formDefinitions/schoolInformation/versions/{versionId}`).
   */
  formVersion: string;
  numStudents: string;
  studentAgeYoungest: number;
  studentAgeOldest: number;
  numTeachers: string;
  studentsPerTeacher: number;
  avgClassSize: string;
  schoolFunding: string;
  schoolReligious: string;
  schoolTuition: string;
  schoolSelectiveness: string[];
  /** Only populated when `schoolSelectiveness` includes `"other"`. */
  schoolSelectivenessOther?: string;
  instructionLanguages: string;
  schoolDayLength: number;
  teacherQuals: string;
}

/** Response field keys shared across org-information forms (site and school). */
export type InformationFieldKey =
  | keyof SiteInformation
  | keyof SchoolInformation;

/** Section metadata within a form definition version. */
export interface FormSectionInfo {
  sectionId: string;
  title: string;
  description: string;
}

/**
 * Single field within an org-information form version. Describes how to render and
 * validate one question. `variableName` matches a `SiteInformation` or
 * `SchoolInformation` response property for that form.
 */
export interface FullInformationFormField {
  /** Stable spreadsheet id, e.g. `"site_02"`. */
  itemId: string;
  variableName: InformationFieldKey;
  kind: "text" | "number" | "single-select" | "multi-select";
  required: boolean;
  sectionId: string;
  questionText: string;
  /** Value/label pairs for select fields; omitted for text/number fields. */
  options?: { value: string; label: string }[];
  /**
   * Conditional visibility: only render/collect this field when another field's
   * value satisfies the rule (e.g. show `sampleApproachOther` when
   * `sampleApproach` includes `"other"`).
   */
  displayLogic?: { field: InformationFieldKey; includes: string };
  infoExample?: string;
  notes?: string;
}

/**
 * Document in the top-level `formDefinitions` collection.
 * Document ID is the form identifier (e.g. `"siteInformation"`, `"schoolInformation"`).
 * Form-specific field definitions live in the `versions` subcollection.
 */
export interface FormDefinition {
  currentVersionId: string;
  formDescription: string;
  /**
   * Per-response-field descriptions; keys are `SiteInformation` or `SchoolInformation`
   * property names for this form.
   */
  fieldsDescription: Record<string, string>;
}

/**
 * Document in the `versions` subcollection of `formDefinitions`.
 * Immutable snapshot of a published definition
 * (`formDefinitions/{formId}/versions/{versionId}`).
 */
export interface FormDefinitionVersion {
  registered: boolean;
  versionNumber: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Null if/when this version is awaiting registration. */
  liveFrom: Timestamp | null;
  /** Null while this is the current live version. */
  liveUntil: Timestamp | null;
  generalPrompt?: string;
  sectionInfo: FormSectionInfo[];
  fullFields: FullInformationFormField[];
}

/**
 * Claims structure within `UserClaims`.
 * Manages custom claims for users, facilitating access control based on administrative
 * roles or organizational (group) affiliations.
 */
export interface Claims {
  adminOrgs: OrgRefMap;
  /** Purpose needs clarification. */
  adminUid?: string;
  assessmentUid?: string;
  minimalAdminOrgs: OrgRefMap;
  /** Purpose needs clarification. */
  roarUid?: string;
  super_admin: boolean;
}

/** Document in the `userClaims` collection. Document ID is the user UID. */
export interface UserClaims {
  claims: Claims;
  /** Unix milliseconds timestamp. */
  lastUpdated: number;
  testData?: boolean;
}

/** Admin-specific data within `users` documents. */
export interface AdminData {
  /** IDs of administrations. */
  administrationsCreated: string[];
}

/** Organizational associations within `users` documents. */
export interface OrgAssociationMap {
  all: string[];
  current: string[];
  /** Structure needs clarification. */
  dates: Record<string, Timestamp>;
}

/** User legal document acceptance within `users` documents. */
export interface UserLegal {
  /** Keyed by form hash/identifier. */
  assent: Record<string, Timestamp>;
  /** Keyed by ToS version hash/identifier. */
  tos: Record<string, Timestamp>;
}

/**
 * Document in the `users` collection. Document ID is the user UID.
 * Stores comprehensive user data including assignments and organizational affiliations.
 */
export interface User {
  /** Only for admin users. */
  adminData?: AdminData;
  /** Only for participants. */
  assignments?: {
    /** Document IDs from `administrations` that are assigned. */
    assigned: string[];
    /** Document IDs from `administrations` that are completed. */
    completed: string[];
    /** Document IDs from `administrations` that are started. */
    started: string[];
  };
  archived: boolean;
  assessmentUid: string;
  classes: OrgAssociationMap;
  createdAt: Timestamp;
  disabled: boolean;
  displayName: string;
  districts: OrgAssociationMap;
  email: string;
  groups: OrgAssociationMap;
  legal: UserLegal;
  schools: OrgAssociationMap;
  /** e.g. `"google"`; only for admin users. */
  sso?: string;
  userType: "admin" | "teacher" | "student" | "parent";
  testData?: boolean;
  roles: { siteId: string; role: string; siteName: string }[];
}

/**
 * Document in the `assignments` subcollection of `users`.
 * Represents a specific administration assigned to a user.
 */
export interface AssignmentAssessment {
  progress: {
    survey: string;
    publicName: string;
    readOrgs: {
      classes: string[];
      districts: string[];
      families: string[];
      groups: string[];
      schools: string[];
    };
    sequential: boolean;
    started: boolean;
    testData: boolean;
    userData: {
      assessmentPid: string | null;
      assessmentUid: string | null;
      email: string;
      name: string | null;
      username: string;
    };
  };
  assessments: {
    optional: boolean;
    taskId: string;
    variantId: string;
    variantName: string;
    startedOn?: Timestamp;
    completedOn?: Timestamp;
    [key: string]: any;
  }[];
  optional: boolean;
  params: {
    taskId: string;
    variantId: string;
    variantName: string;
  };
  assigningOrgs: {
    classes: string[];
    districts: string[];
    families: string[];
    groups: string[];
    schools: string[];
  };
  completed: boolean;
  createdBy: string;
  dateAssigned: string;
  dateClosed: string;
  dateCreated: string;
  dateOpened: string;
  demoData: boolean;
  id: string;
  name: string;
  /** Mirrors administration `syncStatus`. Only show `"complete"` assignments to users. */
  syncStatus?: "pending" | "complete" | "failed";
}

/** Tracks versions of legal documents using GitHub as a reference point. */
export interface Legal {}

/** Permission action types allowed in the system. */
export type PermissionAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "exclude";

/**
 * Permissions structure within the `system/permissions` document.
 * Defines granular permissions for different admin roles.
 */
export interface RolePermissions {
  groups: {
    sites: PermissionAction[];
    schools: PermissionAction[];
    classes: PermissionAction[];
    cohorts: PermissionAction[];
  };
  assignments: PermissionAction[];
  users: PermissionAction[];
  admins: {
    super_admin: PermissionAction[];
    site_admin: PermissionAction[];
    admin: PermissionAction[];
    research_assistant: PermissionAction[];
  };
  tasks: PermissionAction[];
}

/**
 * Document in the `system` collection.
 * Currently only contains the permissions document.
 */
export interface SystemPermissions {
  permissions: {
    super_admin: RolePermissions;
    site_admin: RolePermissions;
    admin: RolePermissions;
    research_assistant: RolePermissions;
    participant: RolePermissions;
  };
  updatedAt: Timestamp;
  /** e.g. `"1.1.0"`. */
  version: string;
}

/** Assessment and task data interfaces. */

/**
 * Document in the `tasks` collection.
 * Defines tasks used in assessments, including descriptions and variant configurations.
 * Document ID: task identifier (e.g. `matrix-reasoning`).
 */
export interface TaskDoc {
  description?: string;
  /** URL. */
  image?: string;
  lastUpdated?: Timestamp;
  name?: string;
  registered?: boolean;
  taskURL?: string;
}

/**
 * Document in the `tasks/{taskId}/variants` subcollection.
 * Manages different configurations or versions of a task.
 * Document ID: variant identifier.
 */
export interface VariantDoc {
  lastUpdated?: Timestamp;
  /** e.g. `"default"`, `"adaptive"`. */
  name?: string;
  /** Task-specific; variable structure. */
  params?: Record<string, any>;
  registered?: boolean;
  taskURL?: string;
  variantURL?: string;
}

/** Guest and assessment run data interfaces. */

/**
 * Document in the `guests` collection.
 * Manages temporary or guest user data for one-off assessments without full registration.
 * Document ID: guest `assessmentUid`.
 */
export interface GuestDoc {
  age?: number;
  assessmentPid?: string;
  assessmentUid?: string;
  created?: Timestamp;
  lastUpdated?: Timestamp;
  /** Task IDs interacted with. */
  tasks?: string[];
  userType?: "guest";
  /** Variant IDs assigned. */
  variants?: string[];
}

/**
 * Document in the `guests/{guestId}/runs` or `users/{userId}/runs` subcollection.
 * Document ID: unique run ID.
 */
export interface RunDoc {
  assigningOrgs?: string[] | null;
  assignmentId?: string | null;
  completed?: boolean;
  /** Run ID. */
  id?: string;
  readOrgs?: string[] | null;
  reliable?: boolean;
  scores?: {
    computed?: {
      composite?: number;
    };
    raw?: {
      composite?: {
        practice?: {
          numAttempted?: number;
          numCorrect?: number;
          numIncorrect?: number;
          thetaEstimate?: number | null;
          thetaSE?: number | null;
        };
        test?: {
          numAttempted?: number;
          numCorrect?: number;
          numIncorrect?: number;
          thetaEstimate?: number | null;
          thetaSE?: number | null;
        };
      };
    };
  };
  /** e.g. `"matrix-reasoning"`. */
  taskId?: string;
  timeFinished?: Timestamp;
  timeStarted?: Timestamp;
  userData?: {
    /** Guest UID. */
    assessmentUid?: string;
    variantId?: string;
  };
}

/**
 * Document in the `guests/{guestId}/runs/{runId}/trials` or
 * `users/{userId}/runs/{runId}/trials` subcollection.
 * Document ID: trial ID or unique identifier within the run.
 * Structure varies significantly based on the parent run's `taskId`.
 */
export interface TrialDoc {
  /** Common fields exist, but many are task-dependent. */
  [key: string]: any;
  assessment_stage?: string;
  correct?: boolean;
  isPractice?: boolean;
  responseSource?: string;
  rt?: number;
  serverTimestamp?: Timestamp;
  stimulus?: string;
  time_elapsed?: number;
  answer?: string;
  corpusTrialType?: string;
  distractors?: Record<string, any>;
  incorrectPracticeResponse?: Record<string, any>;
  isPracticeTrial?: boolean;
  item?: string;
  response?: string | number;
  responseType?: string;
  trialIndex?: number;
}
