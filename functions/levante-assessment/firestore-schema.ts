/**
 * @fileoverview Firestore schema definition for the Levante Assessment project.
 * Using TypeScript interfaces.
 */

/**
 * A type representing a Firestore Timestamp or a standard JS Date.
 */
export type Timestamp = Date; // Or firebase.firestore.Timestamp if preferred

// --- User Data --- interfaces

/**
 * Interface for documents in the `users` collection (Mirrored from Admin Project).
 * Document ID: Admin Project User UID.
 */
export interface UserDoc {
  adminData?: {
    administrationsCreated?: string[];
  };
  archived?: boolean;
  assessmentUid?: string; // UID in *this* project's Auth
  classes?: {
    all?: string[];
    current?: string[];
    dates?: Record<string, Timestamp>; // Structure needs clarification
  };
  createdAt?: Timestamp;
  displayName?: string;
  districts?: {
    all?: string[];
    current?: string[];
    dates?: Record<string, Timestamp>;
  };
  email?: string;
  families?: {
    all?: string[];
    current?: string[];
    dates?: Record<string, Timestamp>;
  };
  groups?: {
    all?: string[];
    current?: string[];
    dates?: Record<string, Timestamp>;
  };
  lastUpdated?: Timestamp;
  legal?: {
    assent?: Record<string, Timestamp>; // Keyed by form hash
    tos?: Record<string, Timestamp>; // Keyed by ToS hash
  };
  schools?: {
    all?: string[];
    current?: string[];
    dates?: Record<string, Timestamp>;
  };
  sso?: string; // e.g., "google"
  userType?: string; // e.g., "admin", "teacher", "student", "parent"
}

/**
 * Interface for documents in the `userClaims` collection.
 * Document ID: Firebase Auth UID (Assessment Project).
 */
export interface UserClaimsDoc {
  claims?: {
    adminOrgs?: {
      groups?: string[];
      classes?: string[];
      schools?: string[];
      districts?: string[];
    };
    adminUid?: string; // UID in Admin project
    assessmentUid?: string; // UID in Assessment project (should match doc ID)
    minimalAdminOrgs?: {
      groups?: string[];
      classes?: string[];
      schools?: string[];
      districts?: string[];
    };
    roarUid?: string;
    super_admin?: boolean;
  };
  lastUpdated?: number; // Milliseconds since epoch
  testData?: boolean;
}

// --- Organization Data --- interfaces

/**
 * Interface for documents in the `classes` collection.
 */
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

/**
 * Interface for documents in the `districts` collection.
 */
interface District {
  archived: boolean;
  createdAt: Timestamp;
  createdBy: string; // User UID
  updatedAt: Timestamp;
  name: string;
  tags: string[];
  subGroups: string[];
}

/**
 * Interface for documents in the `groups` collection.
 */
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

/**
 * Interface for documents in the `schools` collection.
 */
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
 * Interface for documents in the `guests/{guestId}/runs` subcollection.
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
 * Interface for documents in the `guests/{guestId}/runs/{runId}/trials` subcollection.
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
