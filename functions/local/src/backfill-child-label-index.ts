#!/usr/bin/env node

/**
 * One-off backfill of childLabelIndex / lastChildLabelIndex for caregiver
 * links that existed before linkUsers started minting those fields.
 *
 * New links are minted by the deployed linkUsers callable; this script only
 * fills the gap on existing student/parent docs. It does not rewrite an
 * index that is already stored.
 *
 * userType here is the stored ROAR value (`student`, `parent`).
 *
 * Usage:
 * ```bash
 * npm run backfill-child-label-index
 * npm run backfill-child-label-index -- --apply
 * npm run backfill-child-label-index -- --env prod
 * npm run backfill-child-label-index -- --siteId SITE --apply
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { deleteApp } from "firebase-admin/app";
import {
  FieldPath,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import yargs from "yargs";
import { initAdmin } from "./utils/init-admin.js";

const PAGE_SIZE = 500;
const GET_ALL_CHUNK = 100;
const WRITE_CHUNK = 500;

/** Stored `users.userType` values (ROAR), matching levante-zod `UserSchema`. */
const ROAR_USER_TYPES = ["admin", "teacher", "student", "parent"] as const;
type RoarUserType = (typeof ROAR_USER_TYPES)[number];

function isRoarUserType(value: unknown): value is RoarUserType {
  return (
    typeof value === "string" &&
    (ROAR_USER_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Keep the child's current index if it already exceeds every caregiver's last
 * minted index; otherwise mint the next one above the highest caregiver index.
 */
function nextChildLabelIndex(
  existing: number | undefined,
  lastMinted: Array<number | undefined>
): number {
  const maxLast = Math.max(-1, ...lastMinted.map((n) => n ?? -1));
  return existing !== undefined && existing > maxLast ? existing : maxLast + 1;
}

interface BackfillUser {
  userType: RoarUserType;
  parentIds: string[];
  childLabelIndex?: number;
  lastChildLabelIndex?: number;
  siteIds: string[];
}

interface Args {
  environment: "dev" | "prod";
  envFile: string;
  siteId?: string;
  apply: boolean;
  outputFile: string;
  testSize?: number;
}

type ChildPlan = {
  uid: string;
  siteIds: string[];
  parentIds: string[];
  presentCaregiverUids: string[];
  missingCaregiverUids: string[];
  existing: number | undefined;
  planned: number | undefined;
  action: "set-child-label" | "keep" | "skip-no-caregivers";
};

type CaregiverPlan = {
  uid: string;
  existing: number | undefined;
  planned: number | undefined;
  action: "bump-last-index" | "keep" | "missing";
};

const CSV_COLUMNS = [
  "kind",
  "uid",
  "action",
  "siteIds",
  "parentIds",
  "existingChildLabelIndex",
  "plannedChildLabelIndex",
  "existingLastChildLabelIndex",
  "plannedLastChildLabelIndex",
  "missingCaregiverUids",
] as const;

const argv = yargs(process.argv.slice(2))
  .options({
    environment: {
      alias: ["e", "env"],
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    envFile: {
      alias: ["f", "env-file"],
      description: "Path to env file",
      type: "string",
      default: ".env.local",
    },
    siteId: {
      description: "Limit to users whose districts.current contains this site id",
      type: "string",
    },
    apply: {
      description: "Write changes (dry-run by default)",
      type: "boolean",
      default: false,
    },
    outputFile: {
      alias: "o",
      description: "CSV report path",
      type: "string",
      default: "backfill-child-label-index.csv",
    },
    testSize: {
      alias: "t",
      description: "Maximum user documents to load",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.length > 0
      )
    ),
  ];
}

function asIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function createdAtMs(value: unknown): number {
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis: () => number }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Read the fields this backfill needs. Returns null when userType isn't a
 * recognized stored value, which means the doc needs `normalize-user-type`
 * before it can be linked.
 */
function readUser(data: DocumentData): BackfillUser | null {
  const storedUserType: unknown = data.userType;
  if (!isRoarUserType(storedUserType)) return null;

  return {
    userType: storedUserType,
    parentIds: stringArray(data.parentIds),
    childLabelIndex: asIndex(data.childLabelIndex),
    lastChildLabelIndex: asIndex(data.lastChildLabelIndex),
    siteIds: stringArray(data.districts?.current),
  };
}

async function paginateQuery(
  buildPage: (
    last: QueryDocumentSnapshot | undefined,
    pageSize: number
  ) => Query,
  limit?: number
): Promise<QueryDocumentSnapshot[]> {
  const docs: QueryDocumentSnapshot[] = [];
  let last: QueryDocumentSnapshot | undefined;

  while (true) {
    const remaining = limit === undefined ? PAGE_SIZE : limit - docs.length;
    if (remaining <= 0) break;
    const pageSize = Math.min(PAGE_SIZE, remaining);
    const snap = await buildPage(last, pageSize).get();
    docs.push(...snap.docs);
    if (snap.docs.length < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }

  return docs;
}

/**
 * Load candidate child docs. A site filter can't be combined with the userType
 * filter without a composite index, so it loads every user in the site and
 * lets the caller drop the non-children.
 */
async function loadCandidateSnaps(
  db: Firestore,
  siteId: string | undefined,
  limit?: number
): Promise<QueryDocumentSnapshot[]> {
  return paginateQuery((last, pageSize) => {
    const users = db.collection("users");
    let query: Query = siteId
      ? users.where("districts.current", "array-contains", siteId)
      : users.where("userType", "==", "student");
    query = query.orderBy(FieldPath.documentId()).limit(pageSize);
    if (last) query = query.startAfter(last);
    return query;
  }, limit);
}

async function getAllDocs(
  db: Firestore,
  uids: string[]
): Promise<DocumentSnapshot[]> {
  const unique = [...new Set(uids)];
  const snaps: DocumentSnapshot[] = [];
  for (let i = 0; i < unique.length; i += GET_ALL_CHUNK) {
    const chunk = unique.slice(i, i + GET_ALL_CHUNK);
    snaps.push(
      ...(await db.getAll(
        ...chunk.map((uid) => db.collection("users").doc(uid))
      ))
    );
  }
  return snaps;
}

function bumpLast(
  lastByCaregiver: Map<string, number | undefined>,
  uid: string,
  index: number
) {
  const current = lastByCaregiver.get(uid);
  if (current === undefined || index > current) {
    lastByCaregiver.set(uid, index);
  }
}

function planBackfill(
  children: Array<{ uid: string; data: DocumentData; user: BackfillUser }>,
  caregivers: Map<string, { exists: boolean; last?: number }>
): { childPlans: ChildPlan[]; caregiverPlans: CaregiverPlan[] } {
  const lastByCaregiver = new Map<string, number | undefined>();
  for (const [uid, caregiver] of caregivers) {
    lastByCaregiver.set(uid, caregiver.exists ? caregiver.last : undefined);
  }

  const sorted = [...children].sort((a, b) => {
    const aHas = a.user.childLabelIndex !== undefined ? 0 : 1;
    const bHas = b.user.childLabelIndex !== undefined ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    const aIndex = a.user.childLabelIndex ?? Number.MAX_SAFE_INTEGER;
    const bIndex = b.user.childLabelIndex ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return createdAtMs(a.data.createdAt) - createdAtMs(b.data.createdAt);
  });

  const childPlans: ChildPlan[] = [];

  for (const child of sorted) {
    const { parentIds, siteIds, childLabelIndex: existing } = child.user;
    const presentCaregiverUids = parentIds.filter(
      (uid) => caregivers.get(uid)?.exists
    );
    const missingCaregiverUids = parentIds.filter(
      (uid) => !caregivers.get(uid)?.exists
    );

    if (presentCaregiverUids.length === 0) {
      childPlans.push({
        uid: child.uid,
        siteIds,
        parentIds,
        presentCaregiverUids,
        missingCaregiverUids,
        existing,
        planned: existing,
        action: "skip-no-caregivers",
      });
      continue;
    }

    if (existing !== undefined) {
      for (const uid of presentCaregiverUids) {
        bumpLast(lastByCaregiver, uid, existing);
      }
      childPlans.push({
        uid: child.uid,
        siteIds,
        parentIds,
        presentCaregiverUids,
        missingCaregiverUids,
        existing,
        planned: existing,
        action: "keep",
      });
      continue;
    }

    const planned = nextChildLabelIndex(
      undefined,
      presentCaregiverUids.map((uid) => lastByCaregiver.get(uid))
    );
    for (const uid of presentCaregiverUids) {
      bumpLast(lastByCaregiver, uid, planned);
    }
    childPlans.push({
      uid: child.uid,
      siteIds,
      parentIds,
      presentCaregiverUids,
      missingCaregiverUids,
      existing,
      planned,
      action: "set-child-label",
    });
  }

  const caregiverPlans: CaregiverPlan[] = [];
  for (const [uid, caregiver] of caregivers) {
    if (!caregiver.exists) {
      caregiverPlans.push({
        uid,
        existing: undefined,
        planned: undefined,
        action: "missing",
      });
      continue;
    }
    const planned = lastByCaregiver.get(uid);
    const existing = caregiver.last;
    const needsBump =
      planned !== undefined && (existing === undefined || planned > existing);
    caregiverPlans.push({
      uid,
      existing,
      planned,
      action: needsBump ? "bump-last-index" : "keep",
    });
  }

  return { childPlans, caregiverPlans };
}

function writeCsv(
  childPlans: ChildPlan[],
  caregiverPlans: CaregiverPlan[],
  outputFile: string
): string {
  const outputPath = path.resolve(process.cwd(), outputFile);
  const lines = [CSV_COLUMNS.join(",")];

  for (const row of childPlans) {
    lines.push(
      [
        "child",
        row.uid,
        row.action,
        row.siteIds.join("|"),
        row.parentIds.join("|"),
        row.existing ?? "",
        row.planned ?? "",
        "",
        "",
        row.missingCaregiverUids.join("|"),
      ]
        .map(toCsvCell)
        .join(",")
    );
  }

  for (const row of caregiverPlans) {
    lines.push(
      [
        "caregiver",
        row.uid,
        row.action,
        "",
        "",
        "",
        "",
        row.existing ?? "",
        row.planned ?? "",
        "",
      ]
        .map(toCsvCell)
        .join(",")
    );
  }

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

async function applyUpdates(
  db: Firestore,
  childPlans: ChildPlan[],
  caregiverPlans: CaregiverPlan[]
): Promise<number> {
  const updates: Array<{ uid: string; data: Record<string, number> }> = [];

  for (const child of childPlans) {
    if (child.action === "set-child-label" && child.planned !== undefined) {
      updates.push({
        uid: child.uid,
        data: { childLabelIndex: child.planned },
      });
    }
  }

  for (const caregiver of caregiverPlans) {
    if (
      caregiver.action === "bump-last-index" &&
      caregiver.planned !== undefined
    ) {
      updates.push({
        uid: caregiver.uid,
        data: { lastChildLabelIndex: caregiver.planned },
      });
    }
  }

  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const chunk = updates.slice(i, i + WRITE_CHUNK);
    const batch = db.batch();
    for (const update of chunk) {
      batch.update(db.collection("users").doc(update.uid), update.data);
    }
    await batch.commit();
  }

  return updates.length;
}

async function main(): Promise<void> {
  const siteId = argv.siteId?.trim() || undefined;

  console.log(`Environment: ${argv.environment}`);
  console.log(`Dry run: ${argv.apply ? "OFF" : "ON"}`);
  if (siteId) console.log(`Site filter: ${siteId}`);

  const { app, db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "backfill-child-label-index",
  });

  try {
    const candidateSnaps = await loadCandidateSnaps(db, siteId, argv.testSize);

    const children: Array<{
      uid: string;
      data: DocumentData;
      user: BackfillUser;
    }> = [];
    let unknownUserTypes = 0;

    for (const snap of candidateSnaps) {
      const data = snap.data();
      const user = readUser(data);
      if (!user) {
        unknownUserTypes += 1;
        continue;
      }
      if (user.userType !== "student") continue;
      if (user.parentIds.length === 0) continue;
      children.push({ uid: snap.id, data, user });
    }

    const caregiverUids = [
      ...new Set(children.flatMap((child) => child.user.parentIds)),
    ];
    const caregiverSnaps = await getAllDocs(db, caregiverUids);
    const caregivers = new Map<string, { exists: boolean; last?: number }>();
    const notCaregiverUids: string[] = [];

    for (const snap of caregiverSnaps) {
      const user = snap.exists ? readUser(snap.data() ?? {}) : null;
      // A parentIds entry pointing at a missing doc or a non-caregiver is
      // treated as stale, the same way linkUsers tolerates stale parentIds.
      if (!user || user.userType !== "parent") {
        if (snap.exists) notCaregiverUids.push(snap.id);
        caregivers.set(snap.id, { exists: false });
        continue;
      }
      caregivers.set(snap.id, {
        exists: true,
        last: user.lastChildLabelIndex,
      });
    }

    const { childPlans, caregiverPlans } = planBackfill(children, caregivers);
    const toSet = childPlans.filter((row) => row.action === "set-child-label");
    const toBump = caregiverPlans.filter(
      (row) => row.action === "bump-last-index"
    );
    const skipped = childPlans.filter(
      (row) => row.action === "skip-no-caregivers"
    );
    const outputPath = writeCsv(childPlans, caregiverPlans, argv.outputFile);

    console.log(`\nChildren with caregivers: ${children.length}`);
    if (unknownUserTypes > 0) {
      console.log(
        `Skipped docs with an unrecognized userType: ${unknownUserTypes}` +
          " (run normalize-user-type first)"
      );
    }
    if (notCaregiverUids.length > 0) {
      console.log(
        `Stale parentIds pointing at non-caregivers: ${notCaregiverUids.length}`
      );
    }
    console.log(`Set childLabelIndex: ${toSet.length}`);
    console.log(`Bump lastChildLabelIndex: ${toBump.length}`);
    console.log(`Skip (no living caregivers): ${skipped.length}`);
    console.log(`Report: ${outputPath}`);

    if (toSet.length > 0) {
      console.log("\nSample child updates:");
      console.table(
        toSet.slice(0, 20).map((row) => ({
          uid: row.uid,
          from: row.existing ?? "(missing)",
          to: row.planned,
          caregivers: row.presentCaregiverUids.join("|"),
        }))
      );
    }

    if (argv.apply) {
      const written = await applyUpdates(db, childPlans, caregiverPlans);
      console.log(`\nApplied ${written} document updates.`);
    } else {
      console.log("\nThis was a dry run. No changes were made.");
      console.log("Re-run with --apply to write updates.");
    }
  } finally {
    try {
      await deleteApp(app);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

main().catch((error) => {
  console.error("Error backfilling childLabelIndex:", error);
  process.exit(1);
});
