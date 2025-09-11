import * as admin from "firebase-admin";

// Type alias for Firestore Timestamp
type Timestamp = admin.firestore.Timestamp;

// Generic structure for organization references used in multiple places
interface OrgRefMap {
  classes: string[];
  districts: string[];
  families: string[];
  groups: string[];
  schools: string[];
}

// Structure for Assessment Condition Rules within Administrations
interface AssessmentConditionRule {
  field: string; // e.g., "userType"
  op: string; // e.g., "EQUAL", "AND"
  value: string | number | boolean | null; // e.g., "student"
}

// Structure for Assessment Conditions within Administrations
interface AssessmentConditions {
  assigned: Record<string, unknown>; // Structure needs clarification based on usage
  conditions: AssessmentConditionRule[];
}

// Structure for individual Assessments within Administrations
interface Assessment {
  conditions: AssessmentConditions;
  params: Record<string, unknown>; // Parameters specific to the task
  taskName: string; // e.g., "egma-math"
  taskId: string; // e.g., "egma-math"
  variantId: string; // Reference to a task variant
  variantName: string; // e.g., "es-CO"
}

// Structure for Legal information within Administrations and AssignedOrgs
interface LegalInfo {
  amount: string;
  assent: string | null;
  consent: string | null;
  expectedTime: string;
}

// Interface for documents in the `administrations` collection
// Stores metadata about each administration (assignment) including the sequence of tasks, involved organizations, and visibility control.
interface Administration {
  assessments: Assessment[];
  classes: string[]; // Document IDs from `classes` collection
  createdBy: string; // User UID
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
  tags: string[];
  testData: boolean;
}

// Interface for documents in the `assignedOrgs` subcollection of `administrations`
interface AssignedOrg {
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
interface readOrg {
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
interface Stat {
  assignment: Record<string, number>;
  survey: Record<string, number>;
}

// Interface for documents in the `classes` collection
// Details about classes, including school affiliation and optional educational details
interface Class {
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
interface District {
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
interface Group {
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
interface School {
  archived: boolean;
  classes?: string[]; // Document IDs of classes
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string; // User UID
  districtId: string;
  id: string; // Same as document ID
  name: string;
}

// Structure for Claims within UserClaims
// Manages custom claims for users, facilitating access control based on administrative roles or organizational (Group) affiliations.
interface Claims {
  adminOrgs: OrgRefMap;
  adminUid?: string; // Purpose needs clarification
  assessmentUid?: string;
  minimalAdminOrgs: OrgRefMap;
  roarUid?: string; // Purpose needs clarification
  super_admin: boolean;
}

// Interface for documents in the `userClaims` collection (Document ID is User UID)
interface UserClaims {
  claims: Claims;
  lastUpdated: number; // Unix milliseconds timestamp?
  testData?: boolean;
}

// Structure for Admin-specific data within Users
interface AdminData {
  administrationsCreated: string[]; // IDs of administrations
}

// Structure for organizational associations within Users
interface OrgAssociationMap {
  all: string[];
  current: string[];
  dates: Record<string, Timestamp>; // Structure needs clarification
}

// Structure for user legal document acceptance within Users
interface UserLegal {
  assent: Record<string, Timestamp>; // Keyed by form hash/identifier
  tos: Record<string, Timestamp>; // Keyed by ToS version hash/identifier
}

// Interface for documents in the `users` collection (Document ID is User UID)
// Stores comprehensive user data including assignments and organizational affiliations.
interface User {
  adminData?: AdminData; // only for admin users
  assignments?: {
    // only for participants
    assigned: string[]; // Document IDs from `administrations` collection that are assigned
    completed: string[]; // Document IDs from `administrations` collection that are completed
    started: string[]; // Document IDs from `administrations` collection that are started
  };
  archived: boolean;
  assessmentUid: string;
  classes: OrgAssociationMap;
  createdAt: Timestamp;
  displayName: string;
  districts: OrgAssociationMap;
  email: string;
  groups: OrgAssociationMap;
  legal: UserLegal;
  schools: OrgAssociationMap;
  sso?: string; // e.g., "google" only for admin users
  userType: "admin" | "teacher" | "student" | "parent";
  testData?: boolean;
  roles: { siteId: string; role: string, siteName: string }[];
}

// Interface for the assignments subcollection of `users`
// Represents a specific administration assigned to a user.
interface AssignmentAssessment {
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
}

// Tracks versions of legal documents using GitHub as a reference point.
interface legal {}

// --- Assessment & Task Data --- interfaces

/**
 * Interface for documents in the `tasks` collection.
 * Defines tasks used in assessments, including descriptions and variant configurations.
 * Document ID: Task identifier (e.g., `matrix-reasoning`).
 */
export interface TaskDoc {
  description?: string;
  image?: string; // URL
  lastUpdated?: Timestamp;
  name?: string;
  registered?: boolean;
  taskURL?: string; // Optional
}

/**
 * Interface for documents in the `tasks/{taskId}/variants` subcollection.
 * Manages different configurations or versions of a task, allowing for customization of the assessment experience.
 * Document ID: Variant identifier.
 */
export interface VariantDoc {
  lastUpdated?: Timestamp;
  name?: string; // e.g., "default", "adaptive"
  params?: Record<string, any>; // Task-specific, variable structure
  registered?: boolean;
  taskURL?: string; // Optional
  variantURL?: string; // Optional
}

// --- Guest & Assessment Run Data --- interfaces

/**
 * Interface for documents in the `guests` collection.
 * Manages temporary or guest user data, often used for one-off assessments without full user registration.
 * Document ID: Guest assessmentUid.
 */
export interface GuestDoc {
  age?: number;
  assessmentPid?: string;
  assessmentUid?: string;
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
    assessmentUid?: string; // Guest UID
    variantId?: string;
  };
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
