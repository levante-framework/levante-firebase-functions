import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { parseDeviceInfo, touchDevice } from "../utils/offline-devices.js";
import { assertSiteAccess, districtsOf } from "../utils/offline-permissions.js";

/**
 * Ingests one run (plus its trials) that the offline launcher collected on a
 * tablet and is now syncing. The launcher never authenticates children; the
 * caller is the proctor/site account that provisioned the device, so this
 * function checks that the caller may write on behalf of the child and then
 * writes the run with the Admin SDK into the same `users/{uid}/runs/{runId}`
 * shape firekit produces online. The existing `syncOnRunDocUpdate` trigger
 * then recomputes assignment progress/completion exactly as for online runs.
 *
 * Idempotency: the run id and trial ids are client-generated, so re-syncing the
 * same run overwrites the same documents instead of duplicating them.
 *
 * Time: trial/run timestamps are the device's clock, corrected by the offset
 * between the device clock and the server clock measured at sync time
 * (`clientNowMs`). Ingest time is kept separately in `serverTimestamp`.
 */

interface OfflineTrial {
  runId: string;
  trialIndex: number;
  clientTimestamp: string;
  clientTimestampMs: number;
  data: Record<string, unknown>;
}

interface OfflineRun {
  runId: string;
  packId: string;
  packBuiltAt: string;
  deviceId: string;
  appBuild: string;
  taskVersion: string;
  taskId: string;
  variantId: string | null;
  variantParams: Record<string, unknown>;
  administrationId: string | null;
  corpusSha256: string | null;
  bundleId?: string | null;
  child: {
    localId: string;
    uid: string | null;
    assessmentPid: string | null;
    birthMonth: number;
    birthYear: number;
  };
  timeStarted: string;
  timeStartedMs: number;
  timeFinished: string | null;
  timeFinishedMs: number | null;
  completed: boolean;
  aborted: boolean;
  stopReason: string | null;
  userData: Record<string, unknown>;
  startMetadata: Record<string, unknown>;
  finishMetadata: Record<string, unknown>;
  trialCount: number;
}

interface SyncOfflineRunsRequest {
  deviceId: string;
  platform?: string;
  clientNowMs: number;
  run: OfflineRun;
  trials: OfflineTrial[];
}

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRIALS = 5000;
const BATCH_LIMIT = 450;

export const syncOfflineRuns = onCall(async (request) => {
  const db = getFirestore();

  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const body = (request.data ?? {}) as Partial<SyncOfflineRunsRequest>;
  const run = validateRun(body.run);
  const trials = validateTrials(body.trials, run);

  const childUid = run.child.uid;
  if (!childUid) {
    throw new HttpsError(
      "failed-precondition",
      `Run ${run.runId} is not attributed to a provisioned child uid; reconcile the roster before syncing`
    );
  }

  const userRef = db.collection("users").doc(childUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError("not-found", `Child user ${childUid} does not exist`);
  }
  const childData = userSnap.data() ?? {};
  if (request.auth.uid !== childUid) {
    // The permissions matrix has no run-level resource. Syncing is gated on what a
    // research_assistant already holds for the child's site — assignments:read and
    // users:read — so the account that provisioned a device can also drain it; the run
    // itself is written with the Admin SDK, never by the caller.
    const sites = districtsOf(childData);
    await assertSiteAccess(
      request.auth.uid,
      sites,
      { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
      `sync runs for child ${childUid}`
    );
    await assertSiteAccess(
      request.auth.uid,
      sites,
      { resource: RESOURCES.USERS, action: ACTIONS.READ },
      `sync runs for child ${childUid}`
    );
  }

  const serverNowMs = Date.now();
  const clockOffsetMs =
    typeof body.clientNowMs === "number" && Number.isFinite(body.clientNowMs)
      ? serverNowMs - body.clientNowMs
      : 0;
  const corrected = (ms: number | null | undefined) =>
    typeof ms === "number" && Number.isFinite(ms)
      ? Timestamp.fromMillis(ms + clockOffsetMs)
      : null;

  // Copy the org context from the child's assignment, as firekit does at startRun.
  let assigningOrgs: unknown = null;
  let readOrgs: unknown = null;
  let orphan = true;
  if (run.administrationId) {
    const assignmentSnap = await userRef
      .collection("assignments")
      .doc(run.administrationId)
      .get();
    if (assignmentSnap.exists) {
      assigningOrgs = assignmentSnap.get("assigningOrgs") ?? null;
      readOrgs = assignmentSnap.get("readOrgs") ?? null;
      orphan = false;
    }
  }
  if (orphan) {
    logger.warn(
      "syncOfflineRuns: run has no matching assignment; ingesting as orphan",
      {
        runId: run.runId,
        childUid,
        administrationId: run.administrationId,
      }
    );
  }

  const runRef = userRef.collection("runs").doc(run.runId);

  // Trials first, in batches, so the run document (which fires the completion
  // trigger) is the last thing to land.
  let batch = db.batch();
  let ops = 0;
  for (const trial of trials) {
    const trialRef = runRef
      .collection("trials")
      .doc(trialDocId(trial.trialIndex));
    batch.set(trialRef, {
      ...trial.data,
      taskId: run.taskId,
      trialIndex: trial.trialIndex,
      clientTimestamp: corrected(trial.clientTimestampMs),
      deviceTimestamp: trial.clientTimestamp,
      serverTimestamp: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      offline: true,
    });
    ops++;
    if (ops >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
  }

  const runDoc = {
    id: run.runId,
    assignmentId: run.administrationId,
    assigningOrgs,
    readOrgs,
    taskId: run.taskId,
    taskVersion: run.taskVersion,
    variantId: run.variantId,
    variantParams: run.variantParams ?? {},
    completed: run.completed && !run.aborted,
    aborted: run.aborted,
    timeStarted: corrected(run.timeStartedMs),
    timeFinished: corrected(run.timeFinishedMs),
    reliable: false,
    stopReason: run.stopReason,
    scores: summarizeScores(trials),
    userData: {
      ...run.userData,
      assessmentPid: run.child.assessmentPid ?? childData.assessmentPid ?? null,
      birthMonth: run.child.birthMonth,
      birthYear: run.child.birthYear,
      variantId: run.variantId,
    },
    offline: {
      source: "offline-launcher",
      packId: run.packId,
      packBuiltAt: run.packBuiltAt,
      deviceId: run.deviceId,
      appBuild: run.appBuild,
      corpusSha256: run.corpusSha256,
      bundleId: run.bundleId ?? null,
      clockOffsetMs,
      deviceTimeStarted: run.timeStarted,
      deviceTimeFinished: run.timeFinished,
      trialCount: trials.length,
      orphan,
      syncedAt: FieldValue.serverTimestamp(),
      syncedBy: request.auth.uid,
    },
  };

  const finalBatch = db.batch();
  finalBatch.set(runRef, runDoc);
  finalBatch.update(userRef, {
    tasks: FieldValue.arrayUnion(run.taskId),
    ...(run.variantId
      ? { variants: FieldValue.arrayUnion(run.variantId) }
      : {}),
    lastUpdated: FieldValue.serverTimestamp(),
  });
  await finalBatch.commit();

  const device = parseDeviceInfo({
    deviceId: body.deviceId,
    platform: body.platform,
    appBuild: run.appBuild,
  });
  if (device) {
    await touchDevice(db, device, {
      lastSyncAt: FieldValue.serverTimestamp(),
      lastSyncBy: request.auth.uid,
      lastClockOffsetMs: clockOffsetMs,
      runsSynced: FieldValue.increment(1),
      trialsSynced: FieldValue.increment(trials.length),
    });
  }

  logger.info(request.auth.uid, "synced offline run", {
    runId: run.runId,
    childUid,
    taskId: run.taskId,
    trials: trials.length,
    clockOffsetMs,
    orphan,
  });

  return {
    status: "ok",
    runId: run.runId,
    trialsWritten: trials.length,
    clockOffsetMs,
    orphan,
  };
});

function validateRun(run: unknown): OfflineRun {
  if (!run || typeof run !== "object") {
    throw new HttpsError("invalid-argument", "run is required");
  }
  const r = run as OfflineRun;
  if (typeof r.runId !== "string" || !RUN_ID_PATTERN.test(r.runId)) {
    throw new HttpsError("invalid-argument", "run.runId must be a UUID");
  }
  if (typeof r.taskId !== "string" || !r.taskId) {
    throw new HttpsError("invalid-argument", "run.taskId is required");
  }
  if (!r.child || typeof r.child !== "object") {
    throw new HttpsError("invalid-argument", "run.child is required");
  }
  if (typeof r.timeStartedMs !== "number") {
    throw new HttpsError("invalid-argument", "run.timeStartedMs is required");
  }
  return r;
}

function validateTrials(trials: unknown, run: OfflineRun): OfflineTrial[] {
  if (!Array.isArray(trials)) {
    throw new HttpsError("invalid-argument", "trials must be an array");
  }
  if (trials.length > MAX_TRIALS) {
    throw new HttpsError(
      "invalid-argument",
      `too many trials (${trials.length} > ${MAX_TRIALS})`
    );
  }
  const seen = new Set<number>();
  for (const t of trials as OfflineTrial[]) {
    if (t.runId !== run.runId) {
      throw new HttpsError(
        "invalid-argument",
        "trial.runId does not match run.runId"
      );
    }
    if (
      !Number.isInteger(t.trialIndex) ||
      t.trialIndex < 0 ||
      seen.has(t.trialIndex)
    ) {
      throw new HttpsError(
        "invalid-argument",
        `invalid or duplicate trialIndex ${t.trialIndex}`
      );
    }
    seen.add(t.trialIndex);
    if (!t.data || typeof t.data !== "object") {
      throw new HttpsError(
        "invalid-argument",
        `trial ${t.trialIndex} has no data`
      );
    }
  }
  return trials as OfflineTrial[];
}

// Mirrors the `scores.raw.composite` counters firekit maintains per trial online.
function summarizeScores(trials: OfflineTrial[]) {
  const stages = {
    practice: "practice_response",
    test: "test_response",
  } as const;
  const raw: Record<
    string,
    {
      numAttempted: number;
      numCorrect: number;
      numIncorrect: number;
      thetaEstimate: number | null;
      thetaSE: number | null;
    }
  > = {};
  for (const [key, stage] of Object.entries(stages)) {
    const rows = trials.filter((t) => t.data.assessment_stage === stage);
    const numCorrect = rows.filter(
      (t) => t.data.correct === true || t.data.correct === 1
    ).length;
    // core-tasks attaches the running CAT estimate to each scored trial; keep the last one.
    const last = [...rows]
      .reverse()
      .find((t) => typeof t.data.thetaEstimate === "number");
    raw[key] = {
      numAttempted: rows.length,
      numCorrect,
      numIncorrect: rows.length - numCorrect,
      thetaEstimate: last ? (last.data.thetaEstimate as number) : null,
      thetaSE:
        last && typeof last.data.thetaSE === "number"
          ? (last.data.thetaSE as number)
          : null,
    };
  }
  return { raw: { composite: raw } };
}

function trialDocId(trialIndex: number) {
  return `t${String(trialIndex).padStart(5, "0")}`;
}
