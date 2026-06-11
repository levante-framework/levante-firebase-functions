import { FieldPath, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { GetSyncStatusResult } from "@levante-framework/levante-zod";

/** Fetches the sync status counts for assignments and users in a site. */
export async function fetchSyncStatusCounts(
  db: Firestore,
  siteId: string
): Promise<GetSyncStatusResult> {
  // TODO(perf): this reads every matching doc and bucket in memory. If a site
  // grows large, replace these reads with getCountFromServer() aggregations
  // per bucket (pending/complete/failed × administrations/users). That would
  // require composite indexes on (siteId, syncStatus) for administrations and
  // (districts.current, archived, disabled, syncStatus) for users.
  const [assignmentsSnap, usersSnap] = await Promise.all([
    db
      .collection("administrations")
      .where("siteId", "==", siteId)
      .select("dateOpened", "dateClosed", "syncStatus")
      .get(),
    db
      .collection("users")
      .where(new FieldPath("districts", "current"), "array-contains", siteId)
      .where("archived", "==", false)
      .where("disabled", "==", false)
      .select("syncStatus")
      .get(),
  ]);

  const now = Timestamp.now();
  const assignments = { complete: 0, failed: 0, pending: 0 };
  for (const doc of assignmentsSnap.docs) {
    const opened = doc.get("dateOpened") as Timestamp | undefined;
    const closed = doc.get("dateClosed") as Timestamp | undefined;
    if (!opened || !closed || closed.toMillis() < now.toMillis()) continue;
    const status = doc.get("syncStatus") as
      | "complete"
      | "failed"
      | "pending"
      | undefined;
    if (status === "failed") assignments.failed++;
    else if (status === "pending") assignments.pending++;
    else assignments.complete++;
  }

  const users = { complete: 0, failed: 0, pending: 0 };
  for (const doc of usersSnap.docs) {
    const status = doc.get("syncStatus") as
      | "complete"
      | "failed"
      | "pending"
      | undefined;
    if (status === "failed") users.failed++;
    else if (status === "pending") users.pending++;
    else users.complete++;
  }

  return { assignments, users };
}
