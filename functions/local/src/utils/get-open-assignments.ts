import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { initAdmin } from "./init-admin.js";

export type GetOpenAdministrationsEnvironment = "dev" | "prod";

export interface OpenAdministrationSummary {
  id: string;
  siteId: string;
  assessments: { taskId?: unknown }[];
}

export interface GetOpenAdministrationsOptions {
  /**
   * When set, filter by taskId on `assessments`.
   * Default `all` = administration must include every listed taskId.
   * Use `any` when the administration only needs one of the tasks (e.g. survey tasks).
   */
  taskIds?: string[];
  taskIdsMatch?: "all" | "any";
  /** District/site document id (`administrations.siteId`). */
  siteId?: string;
  /** Firebase project environment. Defaults to `dev`. */
  environment?: GetOpenAdministrationsEnvironment;
  /** Env file passed through to `initAdmin` (default `.env.local`). */
  envFile?: string;
  /** Reuse an existing Firestore client instead of calling `initAdmin`. */
  db?: Firestore;
}

function isAdministrationOpen(
  dateOpened: Timestamp | undefined,
  dateClosed: Timestamp | undefined,
  now: Timestamp
): boolean {
  if (dateClosed && dateClosed.toMillis() < now.toMillis()) {
    return false;
  }
  if (dateOpened && dateOpened.toMillis() > now.toMillis()) {
    return false;
  }
  return true;
}

function administrationMatchesTaskIds(
  assessments: { taskId?: unknown }[],
  taskIds: string[],
  match: "all" | "any"
): boolean {
  const adminTaskIds = new Set(
    assessments
      .map((a) => (typeof a.taskId === "string" ? a.taskId.trim() : ""))
      .filter((id) => id.length > 0)
  );
  return match === "any"
    ? taskIds.some((taskId) => adminTaskIds.has(taskId))
    : taskIds.every((taskId) => adminTaskIds.has(taskId));
}

/**
 * Returns open administrations at call time, optionally filtered by site and taskIds.
 * An administration is open when `dateOpened` has passed and `dateClosed` is in the future.
 */
export async function getOpenAdministrations(
  options: GetOpenAdministrationsOptions = {}
): Promise<OpenAdministrationSummary[]> {
  const environment = options.environment ?? "dev";
  const db =
    options.db ??
    (
      await initAdmin({
        environment,
        envFile: options.envFile,
        appName: "get-open-administrations",
      })
    ).db;

  const taskIds = options.taskIds
    ?.map((id) => id.trim())
    .filter((id) => id.length > 0);
  const taskIdsMatch = options.taskIdsMatch ?? "all";
  const siteId = options.siteId?.trim();

  const now = Timestamp.now();
  const querySnap = await db
    .collection("administrations")
    .where("dateClosed", ">", now)
    .get();

  const administrations: OpenAdministrationSummary[] = [];

  for (const doc of querySnap.docs) {
    const data = doc.data();
    const dateOpened = data.dateOpened as Timestamp | undefined;
    const dateClosed = data.dateClosed as Timestamp | undefined;

    if (!isAdministrationOpen(dateOpened, dateClosed, now)) {
      continue;
    }

    const adminSiteId =
      typeof data.siteId === "string" ? data.siteId.trim() : "";

    if (siteId && adminSiteId !== siteId) {
      continue;
    }

    const assessments = Array.isArray(data.assessments)
      ? (data.assessments as { taskId?: unknown }[])
      : [];

    if (taskIds && taskIds.length > 0) {
      if (!administrationMatchesTaskIds(assessments, taskIds, taskIdsMatch)) {
        continue;
      }
    }

    administrations.push({
      id: doc.id,
      siteId: adminSiteId,
      assessments,
    });
  }

  return administrations;
}

/** Returns ids only; see `getOpenAdministrations` for full metadata. */
export async function getOpenAdministrationIds(
  options: GetOpenAdministrationsOptions = {}
): Promise<string[]> {
  const administrations = await getOpenAdministrations(options);
  return administrations.map((admin) => admin.id);
}
