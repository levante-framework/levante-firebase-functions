import { type Firestore, type Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  AdminStatsBufferRegistry,
  syncOnAssignmentUpdated,
} from "../assignments/assignment-sync-in-transaction.js";
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

export async function reopenCaregiverSurveyAssignments(
  db: Firestore,
  caregiverUids: string[]
): Promise<void> {
  const now = new Date();
  const uniqueUids = [...new Set(caregiverUids)];
  if (uniqueUids.length === 0) return;

  for (const caregiverUid of uniqueUids) {
    const assignmentSnaps = await db
      .collection("users")
      .doc(caregiverUid)
      .collection("assignments")
      .get();

    for (const snap of assignmentSnaps.docs) {
      const preview = buildReopenedCaregiverSurveyUpdates(snap.data(), now);
      if (!preview) continue;

      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(snap.ref);
        const prevData = fresh.data();
        const updates = buildReopenedCaregiverSurveyUpdates(prevData, now);
        if (!prevData || !updates) return;

        const statsRegistry = new AdminStatsBufferRegistry(db);

        await syncOnAssignmentUpdated(
          db,
          transaction,
          caregiverUid,
          snap.id,
          prevData,
          { ...prevData, ...updates },
          statsRegistry.forAdministration(snap.id)
        );

        transaction.update(snap.ref, {
          completed: updates.completed,
          assessments: updates.assessments,
          progress: updates.progress,
        });

        statsRegistry.flush(transaction);

        logger.info(
          "Reopened caregiver survey assignment after new child link",
          {
            caregiverUid,
            administrationId: snap.id,
          }
        );
      });
    }
  }
}
