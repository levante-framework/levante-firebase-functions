import type { CoarseLocation } from "@levante-framework/levante-zod";
import * as admin from "firebase-admin";

// Type alias for Firestore Timestamp
export type Timestamp = admin.firestore.Timestamp;

// Generic structure for organization references used in multiple places
export interface OrgRefMap {
  classes: string[];
  districts: string[];
  families: string[];
  groups: string[];
  schools: string[];
}

// Structure for Assessment Condition Rules within Administrations
export interface AssessmentConditionRule {
  field: string; // e.g., "userType"
  op: string; // e.g., "EQUAL", "AND"
  value: string | number | boolean | null; // e.g., "student"
}

// Structure for Assessment Conditions within Administrations
export interface AssessmentConditions {
  assigned: Record<string, unknown>; // Structure needs clarification based on usage
  conditions: AssessmentConditionRule[];
}

// Structure for individual Assessments within Administrations
export interface Assessment {
  conditions: AssessmentConditions;
  params: Record<string, unknown>; // Parameters specific to the task
  taskName: string; // e.g., "egma-math"
  taskId: string; // e.g., "egma-math"
  variantId: string; // Reference to a task variant
  variantName: string; // e.g., "es-CO"
}

// Structure for Legal information within Administrations and AssignedOrgs
export interface LegalInfo {
  amount: string;
  assent: string | null;
  consent: string | null;
  expectedTime: string;
}

// Interface for documents in the `administrations` collection
// Stores metadata about each administration (assignment) including the sequence of tasks, involved organizations, and visibility control.
export interface Administration {
  assessments: Assessment[];
  classes: string[]; // Document IDs from `classes` collection
  createdBy: string; // User UID
  creatorName: string;
  dateClosed: Timestamp;
  dateCreated: Timestamp;
  dateOpened: Timestamp;
  districts: string[]; // Document IDs from `districts` collection
  families: string[]; // Document IDs from `families` collection
  groups: string[]; // Document IDs from `groups` collection
  legal: LegalInfo;
  minimalOrgs: OrgRefMap;
  name: string; // Internal name
  publicName: string; // Public-facing name
  readOrgs: OrgRefMap;
  schools: string[]; // Document IDs from `schools` collection
  sequential: boolean;
  siteId: string;
  syncChunksCompleted?: number;
  syncChunksTotal?: number;
  syncErrorMessage?: string;
  syncStatus?: "pending" | "complete" | "failed";
  tags: string[];
  testData: boolean;
}

// Interface for documents in the `assignedOrgs` subcollection of `administrations`
export interface AssignedOrg {
  administrationId: string;
  createdBy: string; // User UID of the administration creator
  dateClosed: Timestamp; // Copied from administration
  dateCreated: Timestamp; // Timestamp of assignment creation or copied from admin? Needs clarification
  dateOpened: Timestamp; // Copied from administration
  legal: LegalInfo; // Copied from administration
  name: string; // Copied from administration
  orgId: string; // Document ID of the assigned organization
  orgType: "classes" | "districts" | "families" | "groups" | "schools"; // Type of the assigned organization
  publicName: string; // Copied from administration
  testData: boolean; // Copied from administration
  timestamp: Timestamp; // Timestamp of assignment creation/update
}

// Interface for documents in the `readOrgs` subcollection of `administrations`
export interface ReadOrg {
  administrationId: string;
  createdBy: string; // User UID of the administration creator
  dateClosed: Timestamp; // Copied from administration
  dateCreated: Timestamp; // Timestamp of assignment creation or copied from admin? Needs clarification
  dateOpened: Timestamp; // Copied from administration
  legal: LegalInfo; // Copied from administration
  name: string; // Copied from administration
  orgId: string; // Document ID of the assigned organization
  orgType: "classes" | "districts" | "families" | "groups" | "schools"; // Type of the assigned organization
  publicName: string; // Copied from administration
  testData: boolean; // Copied from administration
  timestamp: Timestamp; // Timestamp of assignment creation/update
}

// Interface for the stats subcollection of `administrations`
export interface Stat {
  assignment: Record<string, number>;
  survey: Record<string, number>;
}

// Interface for documents in the `classes` collection
// Details about classes, including school affiliation and optional educational details
export interface Class {
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string; // User UID
  districtId: string;
  id: string; // Same as document ID
  name: string;
  schoolId: string;
}

// Interface for documents in the `districts` collection
// Manages information about districts (sites), including associated schools.
export interface District {
  archived: boolean;
  createdAt: Timestamp;
  createdBy: string; // User UID
  updatedAt: Timestamp;
  name: string;
  tags: string[];
  subGroups?: string[];
  schools?: string[];
}

// Interface for documents in the `groups` collection
// Purpose: Manages group (cohort) data, potentially representing subgroups within a district (site).
// This is a catch all type group for when a group of users does not fit into the traditional group type.
export interface Group {
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string; // User UID
  parentOrgId: string; // Document ID of the parent organization
  parentOrgType: "district"; // Type of the parent organization
  name: string;
  tags: string[];
}

// Interface for documents in the `schools` collection
// Contains data about schools, including their districts.
export interface School {
  archived: boolean;
  classes?: string[]; // Document IDs of classes
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string; // User UID
  districtId: string;
  id: string; // Same as document ID
  name: string;
}

// --- Org information forms (`formDefinitions` collection and response subcollections) ---

export interface SiteInformationCore {
  siteId: string;
  /**
   * Document ID of the form definition version this response was collected against
   * (`formDefinitions/siteInformation/versions/{versionId}`).
   */
  formVersion: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** `draft` for page/leave saves; `complete` when the form is finished. */
  status: "draft" | "complete";
}

export interface SiteInformationAnswers {
  sampleApproach?: string[];
  /** Only populated when `sampleApproach` includes `"other"`. */
  sampleApproachOther?: string;
  siteRecruitment?: string;
  adminApproach?: string[];
  /** Only populated when `adminApproach` includes `"other"`. */
  adminApproachOther?: string;
  testConditions?: string;
  equipmentType?: string[];
  equipmentDevices?: string;
  siteGeoArea?: string;
  siteGeoType?: string;
  sitePopulationSize?: string;
  siteRaceEthnicity?: string;
  siteSES?: string;
  siteLifestyle?: string;
  siteTech?: string;
  siteLanguages?: string;
  siteSubsistence?: string[];
  schoolingAgeStart?: number;
  schoolingAgeEnd?: number;
  schoolingProgression?: string;
  schoolingTeacherQuals?: string;
  anythingElse?: string;
}

/**
 * Document in the `siteInformation` subcollection of `districts`.
 * Optional subcollection: a district document may or may not have siteInformation.
 * Allowed values for select fields are sourced from the runtime form definition,
 * so they are typed as strings here rather than hardcoded literal unions.
 */
export type SiteInformation = SiteInformationCore & SiteInformationAnswers;

export interface SchoolInformationCore {
  siteId: string;
  siteName: string;
  schoolId: string;
  schoolPseudonym: string;
  /**
   * Document ID of the form definition version this response was collected against
   * (`formDefinitions/schoolInformation/versions/{versionId}`).
   */
  formVersion: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** `draft` for page/leave saves; `complete` when the form is finished. */
  status: "draft" | "complete";
}

export interface SchoolInformationAnswers {
  numStudents?: string;
  studentAgeYoungest?: number;
  studentAgeOldest?: number;
  numTeachers?: string;
  studentsPerTeacher?: number;
  avgClassSize?: string;
  schoolFunding?: string;
  schoolReligious?: string;
  schoolTuition?: string;
  schoolSelectiveness?: string[];
  /** Only populated when `schoolSelectiveness` includes `"other"`. */
  schoolSelectivenessOther?: string;
  instructionLanguages?: string;
  schoolDayLength?: number;
  teacherQuals?: string;
}

/**
 * Document in the `schoolInformation` subcollection of `schools`.
 * Optional subcollection: a school document may or may not have schoolInformation.
 * Allowed values for select fields are sourced from the runtime form definition,
 * so they are typed as strings here rather than hardcoded literal unions.
 */
export type SchoolInformation = SchoolInformationCore &
  SchoolInformationAnswers;

/** Response field keys shared across org-information forms (site and school). */
export type InformationFieldKey =
  | keyof SiteInformation
  | keyof SchoolInformation;

/** How a form definition field is rendered and stored. */
export type FormFieldKind =
  | "text"
  | "number"
  | "single-select"
  | "multi-select"
  | "display-only";

/** Section metadata within a form definition version. */
export interface FormSectionInfo {
  sectionId: string;
  title: string;
  description: string;
}

/**
 * Single field within a form definition version. Describes how to render and
 * validate one item. `variableName` is the stored response key: an org-form
 * property, or a participant-survey response key. `display-only` items are
 * shown and are not stored as responses.
 */
export interface FullInformationFormField {
  /** Stable spreadsheet id, e.g. `"site_02"`. */
  itemId: string;
  variableName: string;
  kind: FormFieldKind;
  required: boolean;
  sectionId: string;
  questionText: string;
  /**
   * Groups items that belong to one question. Matrix rows share the matrix
   * question's id.
   */
  questionId?: string;
  /**
   * Set when a single-select should render as part of a matrix rather than as
   * its own control.
   */
  renderAs?: string;
  /** Value/label pairs for select fields; omitted for text/number fields. */
  options?: { value: string; label: string }[];
  /**
   * Conditional visibility: only render/collect this field when another field's
   * value satisfies the rule (e.g. show `sampleApproachOther` when
   * `sampleApproach` includes `"other"`).
   */
  displayLogic?: { field: string; includes: string };
  infoExample?: string;
  notes?: string;
  /**
   * Determines whether this question appears even if the site has not yet
   * customised the form.
   */
  surveyCore?: boolean;
}

interface FormDefinitionBase {
  currentVersionId: string;
  formDescription: string;
  /**
   * Per-response-field descriptions. Keys are org-form property names
   * (`SiteInformation` or `SchoolInformation`) or participant-survey response keys.
   */
  fieldsDescription: Record<string, string>;
}

export interface OrgInformationFormDefinition extends FormDefinitionBase {
  formType: "orgInformation";
}

export interface ParticipantSurveyFormDefinition extends FormDefinitionBase {
  formType: "participantSurvey";
}

/**
 * Document in the top-level `formDefinitions` collection.
 * Document ID is the form identifier (e.g. `"siteInformation"`, `"caregiver-general"`).
 * Form-specific field definitions live in the `versions` subcollection.
 * `fieldsDescription` is required for both org forms and participant surveys.
 */
export type FormDefinition =
  | OrgInformationFormDefinition
  | ParticipantSurveyFormDefinition;

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
 * Stored answer for one survey question.
 * A matrix is not a value: each row is its own response key and stores the
 * selected option as a scalar. A list is a multi-select. Unanswered questions
 * are `null` on the responses map. `null` here is a cleared answer that still
 * has a response time. Boolean is allowed; current items do not use it.
 */
export type SurveyResponseScalar = string | number | boolean;

export type SurveyResponseValue =
  | SurveyResponseScalar
  | SurveyResponseScalar[]
  | null;

export interface SurveyItemResponse {
  responseValue: SurveyResponseValue;
  responseTime: Timestamp;
  /** Text stored with this answer. Absent on existing documents. */
  responseText?: string;
  /** Prompt shown for this question. Absent on existing documents. */
  questionPrompt?: string;
}

/**
 * Answers for one survey part. `versionId` is the form definition version for
 * this part only (`formDefinitions/{formId}/versions/{versionId}`). Absent on
 * parts written before versioned survey definitions.
 */
export interface SurveyResponsePart {
  isComplete: boolean;
  responses: Record<string, SurveyItemResponse | null>;
  versionId?: string;
}

/** Caregiver general part (`caregiver-general`). */
export interface CaregiverGeneralSurveyResponse extends SurveyResponsePart {}

/** Teacher general part (`teacher-general`). */
export interface TeacherGeneralSurveyResponse extends SurveyResponsePart {}

/** One child-specific caregiver part (`caregiver-specific`). */
export interface CaregiverSpecificSurveyResponse extends SurveyResponsePart {
  childId: string;
}

/** One class-specific teacher part (`teacher-specific`). */
export interface TeacherSpecificSurveyResponse extends SurveyResponsePart {
  classId: string;
}

/**
 * Adult document in `users/{uid}/surveyResponses/{surveyResponseId}`.
 * One document per user per administration. `pageNo`, when present, is the
 * last saved page, not a per-part field. A caregiver document uses the
 * caregiver parts; a teacher document uses the teacher parts.
 */
export interface SurveyResponses {
  administrationId: string;
  /** Last saved page. Absent when a save does not send one. */
  pageNo?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  general?: CaregiverGeneralSurveyResponse | TeacherGeneralSurveyResponse;
  specific?: Array<
    CaregiverSpecificSurveyResponse | TeacherSpecificSurveyResponse
  >;
}

// Structure for Claims within UserClaims
// Manages custom claims for users, facilitating access control based on administrative roles or organizational (Group) affiliations.
export interface Claims {
  adminOrgs: OrgRefMap;
  adminUid?: string; // Purpose needs clarification
  minimalAdminOrgs: OrgRefMap;
  roarUid?: string; // Purpose needs clarification
  super_admin: boolean;
}

// Interface for documents in the `userClaims` collection (Document ID is User UID)
export interface UserClaims {
  claims: Claims;
  lastUpdated: number; // Unix milliseconds timestamp?
  testData?: boolean;
}

// Structure for Admin-specific data within Users
export interface AdminData {
  administrationsCreated: string[]; // IDs of administrations
}

// Structure for organizational associations within Users
export interface OrgAssociationMap {
  all: string[];
  current: string[];
  dates: Record<string, { from: Timestamp; to: Timestamp | null }>;
}

// Structure for user legal document acceptance within Users
export interface UserLegal {
  assent: Record<string, Timestamp>; // Keyed by form hash/identifier
  tos: Record<string, Timestamp>; // Keyed by ToS version hash/identifier
}

// Interface for documents in the `users` collection (Document ID is User UID)
// Stores comprehensive user data including assignments and organizational affiliations.
export interface User {
  adminData?: AdminData; // only for admin users
  assignments?: {
    // only for participants
    assigned: string[]; // Document IDs from `administrations` collection that are assigned
    completed: string[]; // Document IDs from `administrations` collection that are completed
    started: string[]; // Document IDs from `administrations` collection that are started
  };
  archived: boolean;
  birthDateUpdatedAt?: Timestamp;
  birthMonth?: number;
  birthYear?: number;
  childIds?: string[]; // TODO: backfill `studentIds` -> `childIds` in db
  childLabelIndex?: number; // only for children; index into the childLabel i18n list
  classes: OrgAssociationMap;
  createdAt: Timestamp;
  disabled: boolean;
  displayName: string;
  districts: OrgAssociationMap;
  email: string;
  groups: OrgAssociationMap;
  idHash?: string;
  lastChildLabelIndex?: number; // only for caregivers; last minted childLabelIndex (omit if none)
  location?: CoarseLocation;
  parentIds?: string[];
  roles: { siteId: string; role: string; siteName: string }[];
  schools: OrgAssociationMap;
  syncStatus?: "pending" | "complete" | "failed";
  teacherIds?: string[];
  userType: "admin" | "teacher" | "student" | "parent";
  username?: string;
  testData?: boolean;
  uid?: string;
  updatedAt: Timestamp;
}

// Interface for the assignments subcollection of `users`
// Represents a specific administration assigned to a user.
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
  /** Mirrors administration syncStatus. Only show "complete" assignments to users. */
  syncStatus?: "pending" | "complete" | "failed";
}

// Tracks versions of legal documents using GitHub as a reference point.
export interface Legal {}

/**
 * Permission action types allowed in the system.
 */
export type PermissionAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "exclude";

/**
 * Interface for the permissions structure within the system/permissions document.
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
 * Interface for documents in the `system` collection.
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
  version: string; // e.g., "1.1.0"
}

// --- Assessment & Task Data --- interfaces

/**
 * Interface for documents in the `tasks` collection.
 * Defines tasks used in assessments, including descriptions and variant configurations.
 * Document ID: Task identifier (e.g., `matrix-reasoning`).
 */
export interface TaskDoc {
  archived?: boolean;
  createdAt?: Timestamp;
  createdBy?: string;
  description?: string;
  image?: string; // URL
  name?: string;
  registered?: boolean;
  updatedAt?: Timestamp;
  updatedBy?: string;
  validUserTypes?: ("parent" | "student" | "teacher")[];
  /** @deprecated Use `updatedAt` instead. */
  lastUpdated?: Timestamp;
  /** @deprecated Was only used by MEFS. */
  taskURL?: string;
}

/**
 * Interface for documents in the `tasks/{taskId}/variants` subcollection.
 * Manages different configurations or versions of a task, allowing for customization of the assessment experience.
 * Document ID: Variant identifier.
 */
export interface VariantDoc {
  archived?: boolean;
  createdAt?: Timestamp | string;
  createdBy?: string;
  displayName?: string;
  lastUpdated?: Timestamp;
  name?: string; // e.g., "default", "adaptive"
  params?: Record<string, boolean | number | string | null>;
  registered?: boolean;
  taskURL?: string; // Optional
  updatedAt?: Timestamp | string;
  updatedBy?: string;
  variantURL?: string; // Optional
}

/**
 * Interface for documents in the `variantParamSpecs` collection.
 * Catalog of allowed variant parameter names and types.
 * Document ID: semantic param name (e.g. `maxTime`).
 */
export interface VariantParamSpecDoc {
  archived: boolean;
  createdAt: Timestamp | string;
  createdBy: string;
  description: string;
  name: string;
  type: "boolean" | "number" | "string" | "unknown";
  updatedAt: Timestamp | string;
  updatedBy: string;
}

// --- Guest & Assessment Run Data --- interfaces

/**
 * Interface for documents in the `guests` collection.
 * Manages temporary or guest user data, often used for one-off assessments without full user registration.
 * Document ID: guest UID.
 */
export interface GuestDoc {
  age?: number;
  assessmentPid?: string;
  created?: Timestamp;
  lastUpdated?: Timestamp;
  tasks?: string[]; // Task IDs interacted with
  userType?: "guest";
  variants?: string[]; // Variant IDs assigned
}

/**
 * Interface for documents in the `guests/{guestId}/runs` and `users/{userId}/runs` subcollection.
 * Document ID: Unique Run ID.
 */
export interface RunDoc {
  assigningOrgs?: string[] | null;
  assignmentId?: string | null;
  completed?: boolean;
  id?: string; // Run ID
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
  taskId?: string; // e.g., "matrix-reasoning"
  timeFinished?: Timestamp;
  timeStarted?: Timestamp;
  userData?: {
    variantId?: string;
  };
  stopReason?: string | null;
}

/**
 * Interface for documents in the `guests/{guestId}/runs/{runId}/trials` and `users/{userId}/runs/{runId}/trials` subcollection.
 * Document ID: Trial ID or unique identifier within the run.
 * Note: The structure of this document varies significantly based on the parent run's taskId.
 */
export interface TrialDoc {
  // Common fields exist, but many are task-dependent.
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
