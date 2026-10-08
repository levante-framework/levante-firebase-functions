import {
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  type Timestamp,
  type Transaction,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { AdminStatsBufferRegistry } from "../assignments/admin-stats-buffer.js";
import { recordAssignmentUpdatedStats } from "../assignments/assignment-sync-in-transaction.js";
import { findSurveyAssessmentIndex } from "../save-survey-results.js";
import { progressKeyFromTaskId } from "../utils/assignment.js";
import { parseTimestamp } from "../utils/utils.js";

interface Assessment {
  taskId: string;
  completedOn?: unknown;
  startedOn?: unknown;
  [key: string]: unknown;
}

export interface Assignment {
  dateOpened?: Date | Timestamp | null;
  dateClosed?: Date | Timestamp | null;
  completed?: boolean;
  assessments?: Assessment[];
  progress?: Record<string, unknown>;
  [key: string]: unknown;
}

export function isAssignmentOpen(data: Assignment, now: Date): boolean {
  const opened = parseTimestamp(data.dateOpened ?? null);
  const closed = parseTimestamp(data.dateClosed ?? null);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(closed.getTime())) {
    return false;
  }
  return opened <= now && closed >= now;
}

/**
 * If this open assignment's caregiver survey is marked complete, return the
 * fields that reopen it so a newly linked child can take the specific survey.
 */
export function buildReopenedCaregiverSurveyUpdates(
  data: Assignment | undefined,
  now: Date
): Partial<Assignment> | undefined {
  if (!data || !isAssignmentOpen(data, now)) return undefined;

  const assessments = data.assessments ?? [];
  const surveyIndex = findSurveyAssessmentIndex(assessments, "caregiver");
  if (surveyIndex === -1) return undefined;

  const surveyAssessment = assessments[surveyIndex];
  if (!surveyAssessment?.taskId || !surveyAssessment?.completedOn) {
    return undefined;
  }

  const reopenedAssessments = assessments.map((assessment, index) => {
    if (index !== surveyIndex) return assessment;
    const next = { ...assessment };
    delete next.completedOn;
    return next;
  });

  const progressKey = progressKeyFromTaskId(surveyAssessment.taskId);

  return {
    completed: false,
    assessments: reopenedAssessments,
    progress: {
      ...(data.progress ?? {}),
      [progressKey]: "started",
    },
  };
}

/**
 * Reopen completed caregiver surveys on `transaction`.
 * Reads assignment docs, so call this before any writes in that transaction.
 * Returns, per caregiver, the user-doc status fields to clear. The caller
 * merges them into its own write so that user doc is written only once.
 */
export async function reopenCaregiverSurveyAssignments(
  db: Firestore,
  transaction: Transaction,
  caregiverUids: string[],
  now: Date = new Date()
): Promise<Map<string, Record<string, unknown>>> {
  const userUpdates = new Map<string, Record<string, unknown>>();
  const uniqueUids = [...new Set(caregiverUids)];
  if (uniqueUids.length === 0) return userUpdates;

  const statsRegistry = new AdminStatsBufferRegistry(db);
  const toReopen: {
    caregiverUid: string;
    snap: QueryDocumentSnapshot;
    updates: Partial<Assignment>;
  }[] = [];

  for (const caregiverUid of uniqueUids) {
    const assignmentSnaps = await transaction.get(
      db.collection("users").doc(caregiverUid).collection("assignments")
    );
    for (const snap of assignmentSnaps.docs) {
      const updates = buildReopenedCaregiverSurveyUpdates(snap.data(), now);
      if (!updates) continue;
      toReopen.push({ caregiverUid, snap, updates });
    }
  }

  const completedIds = new Map<string, string[]>();

  for (const { caregiverUid, snap, updates } of toReopen) {
    const prevData = snap.data();
    recordAssignmentUpdatedStats(
      prevData,
      { ...prevData, ...updates },
      statsRegistry.forAdministration(snap.id)
    );

    transaction.update(snap.ref, {
      completed: updates.completed,
      assessments: updates.assessments,
      progress: updates.progress,
    });

    if (prevData.completed) {
      const ids = completedIds.get(caregiverUid) ?? [];
      ids.push(snap.id);
      completedIds.set(caregiverUid, ids);
    }

    logger.info("Reopened caregiver survey assignment after new child link", {
      caregiverUid,
      administrationId: snap.id,
    });
  }

  for (const [caregiverUid, ids] of completedIds) {
    const update: Record<string, unknown> = {
      "assignments.completed": FieldValue.arrayRemove(...ids),
    };
    for (const id of ids) {
      update[`assignmentsCompleted.${id}`] = FieldValue.delete();
    }
    userUpdates.set(caregiverUid, update);
  }

  statsRegistry.flush(transaction);
  return userUpdates;
}
