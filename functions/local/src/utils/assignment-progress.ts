export type AssignmentProgressStatus = "assigned" | "started" | "completed";

export type AssignmentAssessment = {
  taskId?: unknown;
  optional?: unknown;
  startedOn?: unknown;
  completedOn?: unknown;
  runId?: unknown;
};

export type AssessmentValidation = {
  assessments: AssignmentAssessment[];
  repairable: boolean;
  reason: string;
};

const STATUS_RANK: Record<AssignmentProgressStatus, number> = {
  assigned: 0,
  started: 1,
  completed: 2,
};

export function progressKeyFromTaskId(taskId: string): string {
  return taskId.replace(/-/g, "_");
}

export function validateAssignmentAssessments(
  value: unknown
): AssessmentValidation {
  if (!Array.isArray(value)) {
    return {
      assessments: [],
      repairable: false,
      reason: "assessments is not an array",
    };
  }

  const assessments = value as AssignmentAssessment[];
  const taskIds = assessments.map((assessment) => assessment.taskId);
  if (
    taskIds.some(
      (taskId) => typeof taskId !== "string" || taskId.trim().length === 0
    )
  ) {
    return {
      assessments,
      repairable: false,
      reason: "one or more assessments have an invalid taskId",
    };
  }

  if (new Set(taskIds).size !== taskIds.length) {
    return {
      assessments,
      repairable: false,
      reason: "duplicate assessment taskIds",
    };
  }

  if (assessments.length === 0) {
    return {
      assessments,
      repairable: false,
      reason: "assignment has no assessments",
    };
  }

  return { assessments, repairable: true, reason: "" };
}

function isProgressStatus(value: unknown): value is AssignmentProgressStatus {
  return value === "assigned" || value === "started" || value === "completed";
}

function assessmentProgress(
  assessment: AssignmentAssessment
): AssignmentProgressStatus {
  if (assessment.completedOn) return "completed";
  if (assessment.startedOn || assessment.runId) return "started";
  return "assigned";
}

function mergeProgress(
  current: unknown,
  derived: AssignmentProgressStatus
): AssignmentProgressStatus {
  if (!isProgressStatus(current)) return derived;
  return STATUS_RANK[current] >= STATUS_RANK[derived] ? current : derived;
}

export function rebuildAssignmentProgress(
  assessments: AssignmentAssessment[],
  currentProgress: Record<string, unknown>
): Record<string, AssignmentProgressStatus> {
  const rebuilt: Record<string, AssignmentProgressStatus> = {};

  for (const assessment of assessments) {
    if (
      typeof assessment.taskId !== "string" ||
      assessment.taskId.length === 0
    ) {
      continue;
    }

    const key = progressKeyFromTaskId(assessment.taskId);
    rebuilt[key] = mergeProgress(
      currentProgress[key],
      assessmentProgress(assessment)
    );
  }

  return rebuilt;
}

export function expectedAssignmentCompleted(
  assessments: AssignmentAssessment[]
): boolean {
  if (assessments.length === 0) return false;
  return assessments.every(
    (assessment) =>
      Boolean(assessment.completedOn) || assessment.optional === true
  );
}

export function sortedProgressKeys(
  progress: Record<string, unknown>
): string[] {
  return Object.keys(progress).sort();
}

export function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const leftKeys = sortedProgressKeys(left);
  const rightKeys = sortedProgressKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(
    (key, index) => key === rightKeys[index] && left[key] === right[key]
  );
}
