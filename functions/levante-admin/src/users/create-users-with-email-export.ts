import { getAuth } from "firebase-admin/auth";
import {
  getFirestore,
  FieldValue,
  type Timestamp,
} from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { logger } from "firebase-functions/v2";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import type { InputUser, ReturnUserData } from "./create-users.js";
import { _createUsers } from "./create-users.js";
import { assertCallerMayCreateUsers } from "./create-users-permissions.js";
import { getFunctionUrl, isEmulated } from "../utils/utils.js";

export const createUsersExportSmtpPass = defineSecret(
  "CREATE_USERS_EXPORT_SMTP_PASS"
);
export const createUsersExportSmtpHost = defineString(
  "CREATE_USERS_EXPORT_SMTP_HOST",
  { default: "" }
);
export const createUsersExportSmtpPort = defineString(
  "CREATE_USERS_EXPORT_SMTP_PORT",
  { default: "587" }
);
export const createUsersExportSmtpUser = defineString(
  "CREATE_USERS_EXPORT_SMTP_USER",
  { default: "" }
);
export const createUsersExportMailFrom = defineString(
  "CREATE_USERS_EXPORT_MAIL_FROM",
  { default: "" }
);

export const CREATE_USERS_EMAIL_JOBS_COLLECTION = "createUsersEmailJobs";

const TASK_FUNCTION_NAME = "createUsersWithEmailExportTask";

export type CreateUsersCallableResult = {
  status: "success";
  message: string;
  data: ReturnUserData[];
};

export type CreateUsersWithEmailExportPollResponse =
  | { status: "pending"; jobId: string }
  | CreateUsersCallableResult
  | { status: "failed"; jobId: string; message: string }
  | { status: "rolled_back"; jobId: string; message: string };

type CreateUsersWithEmailExportRequestData = {
  jobId?: string;
  users?: InputUser[];
  siteId?: string;
  districtId?: string;
};

type JobDocument = {
  requestingUid: string;
  requesterEmail: string;
  siteId?: string | null;
  users: InputUser[];
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  result?: CreateUsersCallableResult;
  errorMessage?: string;
  rolledBack?: boolean;
  rolledBackAt?: Timestamp;
};

function errorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    return String((e as { code: unknown }).code);
  }
  return undefined;
}

function isFirestoreNotFound(e: unknown): boolean {
  const code = errorCode(e);
  if (code === "5" || code === "not-found" || code === "NOT_FOUND") {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /not found/i.test(msg);
}

async function deleteParticipantUserByUid(uid: string): Promise<string[]> {
  const db = getFirestore();
  const auth = getAuth();
  const failures: string[] = [];

  try {
    await db.recursiveDelete(db.collection("users").doc(uid));
  } catch (e) {
    if (!isFirestoreNotFound(e)) {
      failures.push(
        `users/${uid}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  try {
    await db.recursiveDelete(db.collection("userClaims").doc(uid));
  } catch (e) {
    if (!isFirestoreNotFound(e)) {
      failures.push(
        `userClaims/${uid}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  try {
    await auth.deleteUser(uid);
  } catch (e) {
    const code = errorCode(e);
    if (code !== "auth/user-not-found") {
      failures.push(
        `auth/${uid}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return failures;
}

async function buildReturnUserDataWorkbook(rows: ReturnUserData[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Created users");
  sheet.columns = [
    { header: "uid", key: "uid", width: 40 },
    { header: "email", key: "email", width: 36 },
    { header: "password", key: "password", width: 18 },
  ];
  for (const row of rows) {
    sheet.addRow({
      uid: row.uid,
      email: row.email,
      password: row.password,
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function sendExportEmail(params: {
  to: string;
  xlsxBuffer: Buffer;
  userCount: number;
}) {
  const host = createUsersExportSmtpHost.value();
  const port = Number.parseInt(createUsersExportSmtpPort.value(), 10) || 587;
  const smtpUser = createUsersExportSmtpUser.value();
  const from = createUsersExportMailFrom.value();
  const smtpPass = smtpUser ? createUsersExportSmtpPass.value() : "";

  if (!host || !from) {
    throw new Error(
      "Email is not configured: set CREATE_USERS_EXPORT_SMTP_HOST and CREATE_USERS_EXPORT_MAIL_FROM"
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
  });

  await transporter.sendMail({
    from,
    to: params.to,
    subject: `Levante: credentials for ${params.userCount} created user(s)`,
    text: "Attached is an Excel file with uid, email, and temporary password for each created account.",
    attachments: [
      {
        filename: "created-users.xlsx",
        content: params.xlsxBuffer,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  });
}

/**
 * Claims a pending job in a single Firestore transaction so only one worker runs it.
 * Firebase Auth and mixed Firestore writes inside _createUsers are not one global transaction;
 * this job is all-or-nothing at the Firestore job level (completed vs failed) and email is
 * only sent after _createUsers returns successfully.
 */
export async function processCreateUsersEmailExportJob(jobId: string) {
  const db = getFirestore();
  const ref = db.collection(CREATE_USERS_EMAIL_JOBS_COLLECTION).doc(jobId);

  const claimed = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      return false;
    }
    const data = snap.data() as JobDocument;
    if (data.status !== "pending") {
      return false;
    }
    transaction.update(ref, {
      status: "processing",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!claimed) {
    logger.info(
      "createUsers email export job skipped (not pending or missing)",
      {
        jobId,
      }
    );
    return;
  }

  const snap = await ref.get();
  const job = snap.data() as JobDocument;

  try {
    const createResult = await _createUsers(job.requestingUid, job.users);
    if (createResult.status !== "success" || !createResult.data) {
      throw new Error("Unexpected create users result");
    }

    const xlsxBuffer = await buildReturnUserDataWorkbook(createResult.data);
    await sendExportEmail({
      to: job.requesterEmail,
      xlsxBuffer,
      userCount: createResult.data.length,
    });

    await db.runTransaction(async (transaction) => {
      const cur = await transaction.get(ref);
      if (!cur.exists) {
        return;
      }
      const curData = cur.data() as JobDocument;
      if (curData.status !== "processing") {
        return;
      }
      transaction.update(ref, {
        status: "completed",
        result: {
          status: "success",
          message: createResult.message,
          data: createResult.data,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("createUsers email export job failed", { jobId, error });
    await ref.update({
      status: "failed",
      errorMessage: message,
      updatedAt: FieldValue.serverTimestamp(),
    });
    throw error;
  }
}

async function enqueueCreateUsersEmailExportTask(jobId: string) {
  const queue = getFunctions().taskQueue(TASK_FUNCTION_NAME);
  const targetUri = await getFunctionUrl(TASK_FUNCTION_NAME);
  if (!targetUri) {
    throw new Error("Could not resolve task function URL for enqueue");
  }
  await queue.enqueue(
    { jobId },
    {
      dispatchDeadlineSeconds: 60 * 30,
      uri: targetUri,
    }
  );
}

export async function handleCreateUsersWithEmailExportRequest(
  request: CallableRequest<CreateUsersWithEmailExportRequestData>
): Promise<CreateUsersWithEmailExportPollResponse> {
  const requestingUid = request.auth?.uid;
  if (!requestingUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const jobIdRaw = request.data?.jobId;
  const jobId =
    typeof jobIdRaw === "string" && jobIdRaw.length > 0 ? jobIdRaw : undefined;

  const db = getFirestore();

  if (jobId) {
    const ref = db.collection(CREATE_USERS_EMAIL_JOBS_COLLECTION).doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Job not found");
    }
    const doc = snap.data() as JobDocument;
    if (doc.requestingUid !== requestingUid) {
      throw new HttpsError("permission-denied", "You cannot access this job");
    }

    if (doc.rolledBack) {
      return {
        status: "rolled_back",
        jobId,
        message:
          "This job was rolled back; created accounts were removed from Auth and Firestore.",
      };
    }

    if (doc.status === "pending" || doc.status === "processing") {
      return { status: "pending", jobId };
    }
    if (doc.status === "failed") {
      return {
        status: "failed",
        jobId,
        message: doc.errorMessage || "Job failed",
      };
    }
    if (doc.status === "completed" && doc.result) {
      return doc.result;
    }
    throw new HttpsError("internal", "Job is in an unexpected state");
  }

  const userData = request.data?.users;
  if (!Array.isArray(userData) || userData.length === 0) {
    throw new HttpsError("invalid-argument", "users must be a non-empty array");
  }

  const siteId = (request.data?.siteId || request.data?.districtId) as
    | string
    | undefined;

  try {
    await assertCallerMayCreateUsers({ requestingUid, siteId });
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  const auth = getAuth();
  const requesterRecord = await auth.getUser(requestingUid);
  const requesterEmail = requesterRecord.email;
  if (!requesterEmail) {
    throw new HttpsError(
      "failed-precondition",
      "Your account must have an email address to receive the export"
    );
  }

  const jobRef = db.collection(CREATE_USERS_EMAIL_JOBS_COLLECTION).doc();
  const newJobId = jobRef.id;

  await jobRef.set({
    requestingUid,
    requesterEmail,
    siteId: siteId ?? null,
    users: userData as InputUser[],
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (isEmulated()) {
    void processCreateUsersEmailExportJob(newJobId).catch((err) => {
      logger.error("Emulator: createUsers email export job error", {
        jobId: newJobId,
        err,
      });
    });
  } else {
    await enqueueCreateUsersEmailExportTask(newJobId);
  }

  return { status: "pending", jobId: newJobId };
}

export type RollbackCreateUsersEmailExportResult = {
  status: "success";
  message: string;
  deletedCount: number;
};

export async function handleRollbackCreateUsersEmailExportRequest(
  request: CallableRequest<{ jobId?: string }>
): Promise<RollbackCreateUsersEmailExportResult> {
  const requestingUid = request.auth?.uid;
  if (!requestingUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const jobIdRaw = request.data?.jobId;
  if (typeof jobIdRaw !== "string" || jobIdRaw.length === 0) {
    throw new HttpsError("invalid-argument", "jobId is required");
  }

  const db = getFirestore();
  const ref = db.collection(CREATE_USERS_EMAIL_JOBS_COLLECTION).doc(jobIdRaw);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Job not found");
  }

  const doc = snap.data() as JobDocument;
  if (doc.requestingUid !== requestingUid) {
    throw new HttpsError("permission-denied", "You cannot roll back this job");
  }

  if (doc.rolledBack) {
    return {
      status: "success",
      message: "Job was already rolled back",
      deletedCount: doc.result?.data?.length ?? 0,
    };
  }

  if (doc.status !== "completed" || !doc.result?.data?.length) {
    throw new HttpsError(
      "failed-precondition",
      "Only completed jobs with created users can be rolled back"
    );
  }

  const siteId = doc.siteId ?? undefined;
  try {
    await assertCallerMayCreateUsers({ requestingUid, siteId });
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  const uids = doc.result.data.map((row) => row.uid);
  const allFailures: string[] = [];

  for (const uid of uids) {
    const failures = await deleteParticipantUserByUid(uid);
    allFailures.push(...failures);
  }

  if (allFailures.length > 0) {
    logger.error("rollbackCreateUsersEmailExport partial failure", {
      jobId: jobIdRaw,
      failures: allFailures,
    });
    throw new HttpsError(
      "internal",
      `Rollback incomplete: ${allFailures.slice(0, 5).join("; ")}${
        allFailures.length > 5 ? ` (+${allFailures.length - 5} more)` : ""
      }`
    );
  }

  await ref.update({
    rolledBack: true,
    rolledBackAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    status: "success",
    message: "Rolled back created users for this job",
    deletedCount: uids.length,
  };
}
