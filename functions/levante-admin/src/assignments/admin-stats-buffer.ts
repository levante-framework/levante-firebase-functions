/**
 * In-transaction accumulator for administration completion stats.
 * Buffers per-org and per-task increments and flushes them as merge writes to
 * `administrations/{id}/stats/{org}` within the calling transaction.
 */
import { logger } from "firebase-functions/v2";
import type {
  CollectionReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

type Status = "assigned" | "started" | "completed";

type OrgDelta = {
  assignment: Partial<Record<Status, number>>;
  tasks: Map<string, Partial<Record<Status, number>>>;
};

export type AdminStatsBuffer = {
  /**
   * Records a stat delta against each org in `orgList`. `incrementBy` may be
   * negative. When `updateAssignmentTotal` is true the org's assignment-level
   * counter for `status` is adjusted; the counter for each task in `taskIds` is
   * always adjusted. Nothing is written until {@link AdminStatsBuffer.flush}.
   */
  recordIncrements: (
    orgList: string[],
    status: Status,
    taskIds: string[],
    incrementBy: number,
    updateAssignmentTotal: boolean
  ) => void;
  /** Writes all buffered deltas as merge updates within `transaction`. */
  flush: (transaction: Transaction) => void;
};

/**
 * Creates a buffer that accumulates stat deltas and flushes them as merge
 * writes to docs under `completionCollectionRef` (one doc per org).
 */
export function createAdminStatsBuffer(
  completionCollectionRef: CollectionReference
): AdminStatsBuffer {
  const byOrg = new Map<string, OrgDelta>();

  const getOrgDelta = (org: string): OrgDelta => {
    let d = byOrg.get(org);
    if (!d) {
      d = { assignment: {}, tasks: new Map() };
      byOrg.set(org, d);
    }
    return d;
  };

  return {
    recordIncrements(
      orgList: string[],
      status: Status,
      taskIds: string[],
      incrementBy: number,
      updateAssignmentTotal: boolean
    ) {
      for (const org of orgList) {
        const orgDelta = getOrgDelta(org);
        if (updateAssignmentTotal) {
          orgDelta.assignment[status] =
            (orgDelta.assignment[status] ?? 0) + incrementBy;
        }
        for (const taskId of taskIds) {
          let taskDelta = orgDelta.tasks.get(taskId);
          if (!taskDelta) {
            taskDelta = {};
            orgDelta.tasks.set(taskId, taskDelta);
          }
          taskDelta[status] = (taskDelta[status] ?? 0) + incrementBy;
        }
      }
    },

    flush(transaction: Transaction) {
      for (const [org, delta] of byOrg) {
        const data: Record<string, unknown> = {};
        let hasIncrement = false;

        const assignmentPayload: Record<string, unknown> = {};
        for (const s of ["assigned", "started", "completed"] as const) {
          const n = delta.assignment[s];
          if (n !== undefined && n !== 0) {
            assignmentPayload[s] = FieldValue.increment(n);
            hasIncrement = true;
          }
        }
        if (Object.keys(assignmentPayload).length > 0) {
          data.assignment = assignmentPayload;
        }

        for (const [taskId, taskDelta] of delta.tasks) {
          const taskPayload: Record<string, unknown> = {};
          for (const s of ["assigned", "started", "completed"] as const) {
            const n = taskDelta[s];
            if (n !== undefined && n !== 0) {
              taskPayload[s] = FieldValue.increment(n);
              hasIncrement = true;
            }
          }
          if (Object.keys(taskPayload).length > 0) {
            data[taskId] = taskPayload;
          }
        }

        if (!hasIncrement) {
          continue;
        }

        data.updatedAt = FieldValue.serverTimestamp();
        const completionDocRef = completionCollectionRef.doc(org);
        const topLevelKeys = Object.keys(data);
        const taskKeyCount = [...delta.tasks.keys()].filter((tid) => {
          const td = delta.tasks.get(tid);
          return (
            td && Object.values(td).some((v) => v !== undefined && v !== 0)
          );
        }).length;
        const estimatedTransforms =
          1 +
          Object.keys(assignmentPayload).length +
          [...delta.tasks.values()].reduce(
            (acc, td) =>
              acc +
              (["assigned", "started", "completed"] as const).filter(
                (s) => td[s] !== undefined && td[s] !== 0
              ).length,
            0
          );
        if (org === "total" || taskKeyCount >= 200) {
          logger.info(
            "DIAG_STATS_MERGE: transaction.set merge on completion doc",
            {
              completionDocPath: completionDocRef.path,
              org,
              aggregatedFlush: true,
              taskKeyCount,
              topLevelFieldCount: topLevelKeys.length,
              estimatedFieldTransformsLowerBound: estimatedTransforms,
              firestoreFieldTransformLimit: 500,
            }
          );
        }

        transaction.set(completionDocRef, data, { merge: true });
      }
    },
  };
}

/**
 * Holds one {@link AdminStatsBuffer} per administration so stat deltas across
 * several administrations can be accumulated in a single transaction and
 * flushed together.
 */
export class AdminStatsBufferRegistry {
  private readonly db: Firestore;
  private readonly map = new Map<string, AdminStatsBuffer>();

  constructor(db: Firestore) {
    this.db = db;
  }

  /** Returns the buffer for an administration, creating it on first access. */
  forAdministration(administrationId: string): AdminStatsBuffer {
    let b = this.map.get(administrationId);
    if (!b) {
      b = createAdminStatsBuffer(
        this.db
          .collection("administrations")
          .doc(administrationId)
          .collection("stats")
      );
      this.map.set(administrationId, b);
    }
    return b;
  }

  /** Flushes every administration's buffer within `transaction`. */
  flush(transaction: Transaction): void {
    for (const b of this.map.values()) {
      b.flush(transaction);
    }
  }
}
