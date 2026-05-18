import {
  FieldPath,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export const normalizeToLowercase = (str = ""): string =>
  str
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

export interface DuplicateAdministrationNameCheckParams {
  siteId: string;
  name: string;
  excludeAdministrationId?: string;
}

export async function findConflictingAdministrationIdForNormalizedName(
  db: Firestore,
  params: DuplicateAdministrationNameCheckParams
): Promise<string | null> {
  const target = normalizeToLowercase(params.name);
  if (target.length === 0) {
    return null;
  }
  const { siteId, excludeAdministrationId } = params;
  let lastDoc: QueryDocumentSnapshot | undefined;

  // Loop through all administrations in the site
  // chunked by 500 at a time
  for (;;) {
    let query = db
      .collection("administrations")
      .where("siteId", "==", siteId)
      .orderBy(FieldPath.documentId())
      .select("name")
      .limit(500);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }
    const snap = await query.get();
    if (snap.empty) {
      break;
    }
    for (const doc of snap.docs) {
      if (doc.id === excludeAdministrationId) {
        continue;
      }
      const docName = doc.get("name") as string | undefined;
      if (normalizeToLowercase(docName) === target) {
        return doc.id;
      }
    }
    if (snap.docs.length < 500) {
      break;
    }
    lastDoc = snap.docs[snap.docs.length - 1];
  }
  return null;
}

export async function assertNoDuplicateAdministrationNameInSite(
  db: Firestore,
  params: DuplicateAdministrationNameCheckParams
): Promise<void> {
  const conflictId = await findConflictingAdministrationIdForNormalizedName(
    db,
    params
  );
  if (conflictId !== null) {
    throw new HttpsError(
      "already-exists",
      "Duplicate name: an administration with this name already exists for this site."
    );
  }
}
