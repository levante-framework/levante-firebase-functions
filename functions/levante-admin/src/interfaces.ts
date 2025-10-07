import type { DocumentReference, FieldPath } from "firebase-admin/firestore";
import type { Condition } from "./administrations/conditions.js";

export const ORG_NAMES = [
  "districts",
  "schools",
  "classes",
  "groups",
  "families",
];

/**
 * An interface representing the different types of educational organizations.
 */
export interface IEducationalOrgsList {
  /* An array of district IDs. */
  districts?: string[];
  /* An array of school IDs. */
  schools?: string[];
  /* An array of class IDs. */
  classes?: string[];
}

/**
 * An interface representing the different types of organizations.
 */
export interface IOrgsList extends IEducationalOrgsList {
  /* An array of family IDs. */
  families?: string[];
  /* An array of group IDs. */
  groups?: string[];
}

/**
 * An interface representing an assessment.
 */
export interface IAssessment {
  /* The task ID of the assessment. */
  taskId: string;
  /* The parameters for the assessment. */
  params: { [x: string]: unknown };
  /* The conditions for the assessment. */
  conditions?: {
    /* The conditions for assigning the assessment. */
    assigned?: Condition;
    /* The conditions for making the assessment optional. */
    optional?: Condition;
  };
  /* The ID of the variant of the assessment. */
  variantId: string;
  /* The name of the variant of the assessment. */
  variantName: string;
}

/**
 * An interface representing an administration.
 */
export interface IAdministration extends IOrgsList {
  /* The ID of the user who created the administration. */
  createdBy: string;
  /* The date the administration was created. */
  dateCreated: Date;
  /* The date the administration opens */
  dateOpened: Date;
  /* The date the administration closes. */
  dateClosed: Date;
  /* The array of assessments in this administration. */
  assessments: IAssessment[];
  /* A boolean indicating whether the assessments in the administration are sequential. */
  sequential: boolean;
  /* An interface representing the organizations that can read administration data. */
  readOrgs: IOrgsList;
  /* An interface representing only the top-level organizations that are assigned to this administration. */
  minimalOrgs: IOrgsList;
  /* An object with information about consent and assent forms for this administration. */
  legal?: { [key: string]: unknown };
  /* A string inidcating the name of the administration */
  name?: string;
  /* A string indicating the full, user-facing name of the administration */
  publicName?: string;
  /* A boolean indicating whether the administration contains test data. */
  testData?: boolean;
  /* A boolean indicating whether the administration contains demo data. */
  demoData?: boolean;
}

/**
 * An interface representing an assigned assessment.
 */
export interface IAssignedAssessment {
  /* The task ID of the assessment. */
  taskId: string;
  /* The ID of the run associated with the assessment. */
  runId: string;
  /* An array of all the run IDs associated with the assessment. */
  allRunIds: string[];
  /* The date the assessment was completed. */
  completedOn: Date;
  /* The date the assessment was started. */
  startedOn: Date;
  /* A boolean indicating whether the reward was shown for the assessment. */
  rewardShown: boolean;
}

export interface IExtendedAssignedAssessment extends IAssignedAssessment {
  optional?: boolean;
}

/**
 * An interface representing an assignment.
 *
 * An assignment is one user's view of an administration.
 */
export interface IAssignment {
  /* A boolean indicating whether the assignment has been started. */
  started: boolean;
  /* A boolean indicating whether the assignment has been completed. */
  completed: boolean;
  /* The date the assignment was assigned. */
  dateAssigned: Date;
  /* The date the assignment was opened. */
  dateOpened: Date;
  /* The date the assignment was closed. */
  dateClosed: Date;
  /* An interface representing the organizations that assigned the assignment to this user. */
  assigningOrgs: IOrgsList;
  /* An interface representing the organizations that can read the assignment. */
  readOrgs: IOrgsList;
  /* An array of assessments associated with the assignment. */
  assessments: IAssignedAssessment[];
}

/**
 * An interface representing the organizations that a user belongs to.
 */
export interface IOrgsMap {
  /* An array of the current organizations. */
  current: string[];
  /* An array of all the organizations, past and present */
  all: string[];
  /* An interface representing a map of start and stop dates for each organization. */
  dates: IOrgDateMap;
}

/**
 * An interface representing start and stop dates for an organization.
 */
export interface IOrgDateMap {
  /* The ID of the organization. */
  [x: string]: {
    /* The date the user joined the organization. */
    from: Date;
    /* The date the user left the organization, if applicable. */
    to?: Date;
  };
}

/**
 * An interface representing the input for creating a student.
 * This interface is used for input to the createStudent cloud function.
 * FamilyStudentDataInput does not require orgIds.
 */
export interface StudentDataInput extends FamilyStudentDataInput {
  /* An interface representing the IDs of the organizations this student will be assigned to. */
  orgIds: {
    /* The ID of the district, if applicable. */
    districts?: string[];
    /* The ID of the school, if applicable. */
    schools?: string[];
    /* The ID of the class, if applicable. */
    classes?: string[];
    /* The ID of the group, if applicable. */
    groups?: string[];
    /* The ID of the family, if applicable. */
    families?: string[];
  };
}

/**
 * An interface representing a person's name
 */
export interface IName {
  /* The first name of the student. */
  first: string;
  /* The middle name of the student. */
  middle?: string;
  /* The last name of the student. */
  last: string;
}

/**
 * An interface representing the input for creating a student within a family.
 * StudentDataInput is a modified version of IUserData.
 * It is used in the createStudent cloud function and contains all the
 * fields necessary for creating a student account and userdoc.
 */
export interface FamilyStudentDataInput {
  /* An interface representing the name of the student. */
  name?: IName;
  /* A boolean indicating whether the student should be created with test data. */
  testData?: boolean;
  /* The participant ID, a unique ID with a prefix that is human readable */
  assessmentPid?: string;
  /* The username for the student account. */
  username?: string;
  /* The email address of the student account. */
  email?: string;
  /* The password for the student account. */
  password?: string;
  /* An interface representing the student's personal information. */
  studentData: {
    /* The date of birth of the student. */
    dob: string;
    /* The English language learner status of the student. */
    ell_status?: string;
    /* The free/reduced lunch status of the student. */
    frl_status?: string;
    /* The gender of the student. */
    gender?: string;
    /* The grade level of the student. */
    grade: string;
    /* An array of the student's home languages. */
    home_language?: string[];
    /* The IEP status of the student. */
    iep_status?: string;
    /* An array of the student's races. */
    race?: string[];
    /* The Hispanic/Latino ethnicity of the student. */
    hispanic_ethnicity?: string;
  };
  /* An interface representing additional student data from external data sources. */
  externalData?: { [key: string]: unknown };
}

/**
 * An interface representing student data required for family creation.
 */
export interface IFamilyStudentData {
  /* The email address of the student account. */
  email: string;
  /* The password for the student account. */
  password: string;
  /* An interface representing the user data for the student account. */
  userData: FamilyStudentDataInput;
}

/**
 * An interface representing user data.
 */
export interface IUserData {
  /* An interface representing the name of the student. */
  name?: {
    /* The first name of the student. */
    first: string;
    /* The middle name of the student. */
    middle?: string;
    /* The last name of the student. */
    last: string;
  };
  /* An interface representing the districts that the user is associated with. */
  districts: IOrgsMap;
  /* An interface representing the schools that the user is associated with. */
  schools: IOrgsMap;
  /* An interface representing the classes that the user is associated with. */
  classes: IOrgsMap;
  /* An interface representing the groups that the user is associated with. */
  groups: IOrgsMap;
  /* An interface representing the families that the user is associated with. */
  families: IOrgsMap;
  /* The participant ID, a unique ID with a prefix that is human readable */
  assessmentPid?: string;
  /* A boolean indicating whether the student should be created with test data. */
  testData?: boolean;
  /* The userType (e.g., participant, educator, caregiver). */
  userType?: string;
  /* An interface representing the student's personal information. */
  studentData: { [key: string]: unknown };
  /* An interface representing additional student data from external data sources. */
  externalData?: { [key: string]: unknown };
  /* The birth month of the student. */
  birthMonth: number;
  /* The birth year of the student. */
  birthYear: number;
}

/**
 * An interface representing a parent data object.
 */
export interface IParentData {
  /* An interface representing the name of the parent. */
  name?: {
    /* The first name of the parent. */
    first: string;
    /* The last name of the parent. */
    last: string;
  };
  /* An interface representing the families that the parent is associated with. */
  families?: IOrgsMap;
  /* An interface representing the groups that the parent is associated with. */
  groups?: IOrgsMap;
  /* A boolean indicating whether the parent should be created with test data. */
  testData?: boolean;
}

/**
 * An interface representing the organizations that the user is an administrator for.
 */
export interface IAdminClaims {
  /* The IDs of the districts the user is an administrator for. */
  districts?: string[];
  /* The IDs of the schools the user is an administrator for. */
  schools?: string[];
  /* The IDs of the classes the user is an administrator for. */
  classes?: string[];
  /* The IDs of the families the user is an administrator for. */
  families?: string[];
  /* The IDs of the groups the user is an administrator for. */
  groups?: string[];
}

/**
 * An interface representing the various UIDs for a user.
 */
export interface IUids {
  /* The ROAR UID under which the user's data is stored in Firestore. */
  roarUid: string;
  /* The auth UID of the user in the admin Firebase project. */
  adminUid: string;
  /* The auth UID of the user in the assessment Firebase project. */
  assessmentUid: string;
}

/**
 * An interface representing the custom claims for a user.
 */
export interface ICustomClaims extends IUids {
  /* A boolean indicating whether the user is a super admin. */
  super_admin?: boolean;
  /* An interface representing the organizations that the user is an administrator for. */
  adminOrgs?: IAdminClaims;
  /* An interface representing only the non-dependent orgs that the user is an administrator for. */
  minimalAdminOrgs?: IAdminClaims;
  /* A boolean indicating whether the user is an administrator. */
  admin?: boolean;
}

/**
 * An interface representing base organization data.
 */
interface BaseOrgData {
  /* The name of the organization. */
  name: string;
  /* An array of the subgroups that are part of the organization. */
  subGroups: string[];
  /* Additional data for the organization. */
  [x: string]: unknown;
}

/**
 * An interface representing a district data object.
 */
export interface DistrictData extends BaseOrgData {
  /* An array of the schools that are part of the district. */
  schools: string[];
}

/**
 * An interface representing a school data object.
 */
export interface SchoolData extends BaseOrgData {
  /* The ID of the district that the school is part of. */
  districtId: string;
  /* An array of the classes that are part of the school. */
  classes: string[];
}

/**
 * An interface representing a class data object.
 */
export interface ClassData extends BaseOrgData {
  /* The ID of the school that the class is part of. */
  schoolId: string;
  /* The ID of the district that the class is part of. */
  districtId: string;
}

/**
 * An interface representing a group data object.
 */
export interface GroupData extends BaseOrgData {
  /* The type of the parent organization that the group is part of (e.g., district, school, etc.). */
  parentOrgType: string;
  /* The ID of the parent organization that the group is part of. */
  parentOrgId: string;
  /* The ID of the family that the group is part of. */
  familyId?: string;
}

export interface FamilyData extends BaseOrgData {}

/**
 * An interface representing a database transaction action.
 */
export interface IDbAction {
  /* The reference to the Firestore document where the action will be performed. */
  ref: DocumentReference;
  /* The data that will be used for the action. */
  data: { [key: string]: unknown };
  /* The action that will be performed on the document. */
  action: "set" | "update" | "delete";
  /* A boolean indicating whether the action should be performed as a merge operation. */
  merge?: boolean;
}

export type FieldPathsAndValues = [
  string | FieldPath,
  ...Array<unknown | string | FieldPath>
];

/** An interface representing additional student data from external data sources. */
export interface IExternalData {
  /** The unique identifier for the student in the external data source. */
  [key: string]: unknown;
}

/** An interface representing additional student data from external data sources. */
export interface IExternalStudentData {
  /** The unique identifier for the student in the external data source. */
  [key: string]: unknown;
}

export type OrgTypeString = "districts";
