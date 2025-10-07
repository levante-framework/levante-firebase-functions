import { LOG_SIZE } from "./constants.js";
import { removeUndefinedFields } from "./utils.js";
import type { IOrgsList } from "../interfaces.js";
import type { DocumentData } from "firebase-admin/firestore";

const LOG_SAMPLE_SIZE = LOG_SIZE;

export const summarizeIdListForLog = (
  ids: string[] = [],
  sampleSize = LOG_SAMPLE_SIZE
) => ({
  count: ids.length,
  sample: ids.slice(0, sampleSize),
  truncated: ids.length > sampleSize,
});

export const summarizeOrgsForLog = (
  orgs: IOrgsList = {},
  sampleSize = LOG_SAMPLE_SIZE
) =>
  Object.fromEntries(
    Object.entries(orgs ?? {}).map(([orgType, orgIds]) => {
      const safeOrgIds = Array.isArray(orgIds) ? orgIds : [];
      return [
        orgType,
        {
          count: safeOrgIds.length,
          sample: safeOrgIds.slice(0, sampleSize),
          truncated: safeOrgIds.length > sampleSize,
        },
      ];
    })
  );

export const summarizeAdministrationsForLog = (
  administrations: Array<string | { id: string }> = [],
  sampleSize = LOG_SAMPLE_SIZE
) =>
  summarizeIdListForLog(
    administrations.map((administration) =>
      typeof administration === "string" ? administration : administration.id
    ),
    sampleSize
  );

type AssessmentForLog = {
  taskId: string;
  optional?: boolean;
  variantId?: string;
  variantName?: string;
};

export const summarizeAssessmentsForLog = (
  assessments: AssessmentForLog[] = [],
  sampleSize = LOG_SAMPLE_SIZE
) => ({
  count: assessments.length,
  sample: assessments.slice(0, sampleSize).map((assessment) => ({
    taskId: assessment.taskId,
    optional: assessment.optional ?? false,
    variantId: assessment.variantId,
    variantName: assessment.variantName,
  })),
  truncated: assessments.length > sampleSize,
});

type AssignmentDataForLog = {
  id?: string;
  started?: boolean;
  completed?: boolean;
  sequential?: boolean;
  assessments?: AssessmentForLog[];
  assigningOrgs?: IOrgsList;
  readOrgs?: IOrgsList;
  progress?: Record<string, string | undefined>;
};

export const summarizeAssignmentForLog = (
  assignmentData?: AssignmentDataForLog
) => {
  if (!assignmentData) {
    return undefined;
  }

  const assessments = assignmentData.assessments ?? [];
  const assigningOrgs = assignmentData.assigningOrgs ?? {};
  const readOrgs = assignmentData.readOrgs ?? {};
  const progress = assignmentData.progress ?? undefined;
  const progressKeys = progress ? Object.keys(progress) : [];

  return removeUndefinedFields({
    id: assignmentData.id,
    started: assignmentData.started,
    completed: assignmentData.completed,
    sequential: assignmentData.sequential,
    assessmentSummary: summarizeAssessmentsForLog(assessments),
    assigningOrgSummary: summarizeOrgsForLog(assigningOrgs),
    readOrgSummary: summarizeOrgsForLog(readOrgs),
    progressSummary: progress
      ? {
          count: progressKeys.length,
          sample: progressKeys.slice(0, LOG_SAMPLE_SIZE).map((key) => ({
            taskId: key,
            status: progress[key],
          })),
          truncated: progressKeys.length > LOG_SAMPLE_SIZE,
        }
      : undefined,
  });
};

type RunRecordForLog = {
  id: string;
  data: DocumentData;
};

const toIsoString = (value: unknown): string | undefined => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }

  if (typeof (value as { toDate?: () => Date })?.toDate === "function") {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return date.toISOString();
    } catch (error) {
      return undefined;
    }
  }

  return undefined;
};

export const summarizeRunsForLog = (
  runs: RunRecordForLog[] = [],
  sampleSize = LOG_SAMPLE_SIZE
) => ({
  count: runs.length,
  sample: runs.slice(0, sampleSize).map((run) => {
    const data = run.data ?? {};
    const compositeTest = (data?.scores as Record<string, unknown>) ?? {};
    const testScores = (compositeTest as any)?.raw?.composite?.test ?? {};

    return removeUndefinedFields({
      id: run.id,
      completed: data?.completed,
      timeStarted: toIsoString(data?.timeStarted),
      timeFinished: toIsoString(data?.timeFinished),
      numAttempted: (testScores as Record<string, unknown>)?.numAttempted,
      thetaSE: (testScores as Record<string, unknown>)?.thetaSE,
    });
  }),
  truncated: runs.length > sampleSize,
});
