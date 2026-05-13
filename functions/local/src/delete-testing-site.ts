// districts/{siteId}

import * as adminApp from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { createInterface } from "readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .options({
    env: {
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    siteId: {
      description: "Firestore document ID of the site to delete",
      type: "string",
      demandOption: true,
    },
    apply: {
      description: "Apply the deletion; omit to preview what would be deleted",
      type: "boolean",
      default: false,
    },
  })
  .help()
  .alias("help", "h").argv as {
  env: "dev" | "prod";
  siteId: string;
  apply: boolean;
};

function initializeApp() {
  const projectId =
    argv.env === "prod" ? "hs-levante-admin-prod" : "hs-levante-admin-dev";
  return adminApp.initializeApp(
    { credential: adminApp.applicationDefault(), projectId },
    "admin"
  );
}

import { Timestamp } from "firebase-admin/firestore";

function fmtTimestamp(ts: Timestamp | undefined): string {
  return ts
    ? ts.toDate().toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "unknown";
}

interface DocInfo {
  id: string;
  name: string;
  updatedAt: string;
}

interface DeletionPlan {
  site: DocInfo;
  schools: DocInfo[];
  classes: DocInfo[];
  cohorts: DocInfo[];
  assignments: DocInfo[];
  usersToDelete: Array<{ uid: string; updatedAt: string }>;
  usersToDisassociate: Array<{ uid: string; updatedAt: string }>;
}

async function buildPlan(
  db: FirebaseFirestore.Firestore,
  siteId: string
): Promise<DeletionPlan> {
  const siteDoc = await db.collection("districts").doc(siteId).get();
  if (!siteDoc.exists) {
    throw new Error(`Site "${siteId}" not found in districts collection.`);
  }
  const site = {
    id: siteId,
    name: siteDoc.get("name") ?? siteId,
    updatedAt: fmtTimestamp(siteDoc.get("updatedAt")),
  };

  const [
    schoolsSnap,
    classesSnap,
    cohortsSnap,
    assignBySiteId,
    assignByDistricts,
    usersSnap,
  ] = await Promise.all([
    db.collection("schools").where("districtId", "==", siteId).get(),
    db.collection("classes").where("districtId", "==", siteId).get(),
    db.collection("groups").where("parentOrgId", "==", siteId).get(),
    db.collection("administrations").where("siteId", "==", siteId).get(),
    db
      .collection("administrations")
      .where("districts", "array-contains", siteId)
      .get(),
    db
      .collection("users")
      .where(new FieldPath("districts", "current"), "array-contains", siteId)
      .get(),
  ]);

  const toEntry = (d: FirebaseFirestore.QueryDocumentSnapshot): DocInfo => ({
    id: d.id,
    name: d.get("name") ?? d.id,
    updatedAt: fmtTimestamp(d.get("updatedAt")),
  });

  const schools = schoolsSnap.docs.map(toEntry);
  const classes = classesSnap.docs.map(toEntry);
  const cohorts = cohortsSnap.docs.map(toEntry);

  // Deduplicate assignments that appear in both queries
  const assignmentMap = new Map<string, DocInfo>();
  for (const d of [...assignBySiteId.docs, ...assignByDistricts.docs]) {
    assignmentMap.set(d.id, toEntry(d));
  }
  const assignments = Array.from(assignmentMap.values());

  const usersToDelete: Array<{ uid: string; updatedAt: string }> = [];
  const usersToDisassociate: Array<{ uid: string; updatedAt: string }> = [];

  for (const userDoc of usersSnap.docs) {
    const districtsData = userDoc.get("districts");
    const currentDistricts: string[] = districtsData?.current ?? [];
    const entry = {
      uid: userDoc.id,
      updatedAt: fmtTimestamp(userDoc.get("updatedAt")),
    };
    if (currentDistricts.length <= 1) {
      usersToDelete.push(entry);
    } else {
      usersToDisassociate.push(entry);
    }
  }

  return {
    site,
    schools,
    classes,
    cohorts,
    assignments,
    usersToDelete,
    usersToDisassociate,
  };
}

function printPlan(plan: DeletionPlan, siteId: string) {
  const hr = "=".repeat(60);
  console.log(`\n${hr}`);
  console.log(`DELETION PLAN — site "${plan.site.name}" (${siteId})`);
  console.log(hr);

  const docRows = [
    {
      collection: "districts",
      id: plan.site.id,
      name: plan.site.name,
      updatedAt: plan.site.updatedAt,
    },
    ...plan.schools.map((s) => ({
      collection: "schools",
      id: s.id,
      name: s.name,
      updatedAt: s.updatedAt,
    })),
    ...plan.classes.map((c) => ({
      collection: "classes",
      id: c.id,
      name: c.name,
      updatedAt: c.updatedAt,
    })),
    ...plan.cohorts.map((c) => ({
      collection: "groups",
      id: c.id,
      name: c.name,
      updatedAt: c.updatedAt,
    })),
    ...plan.assignments.map((a) => ({
      collection: "administrations (+subcollections)",
      id: a.id,
      name: a.name,
      updatedAt: a.updatedAt,
    })),
  ];
  console.log("\nDocuments to DELETE:");
  console.table(docRows);

  if (plan.usersToDelete.length > 0) {
    console.log("Users to DELETE (+ runs/trials + Auth):");
    console.table(plan.usersToDelete);
  }

  if (plan.usersToDisassociate.length > 0) {
    console.log("Users to DISASSOCIATE (belong to other sites too):");
    console.table(plan.usersToDisassociate);
    console.log(
      "  NOTE: Run 'rebuild-custom-claims' after to refresh userClaims for these users."
    );
  }

  console.log("Summary:");
  console.table({
    Schools: plan.schools.length,
    Classes: plan.classes.length,
    Cohorts: plan.cohorts.length,
    Assignments: plan.assignments.length,
    "Users deleted": plan.usersToDelete.length,
    "Users disassociated": plan.usersToDisassociate.length,
  });
  console.log(hr);
}

async function confirmLive(siteId: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\nALERT: This will permanently delete site "${siteId}" and all associated data from PRODUCTION.\n   Type "yes" to proceed: `,
      (answer) => {
        rl.close();
        resolve(answer.trim() === "yes");
      }
    );
  });
}

/**
 * Partition refs into those safe to batch-delete (no subcollections) and those
 * that need recursiveDelete. Logs a warning for any unexpected subcollections so
 * the schema assumption is validated against the real database on every run.
 */
async function partitionBySubcollections(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<{
  batchRefs: FirebaseFirestore.DocumentReference[];
  recursiveRefs: FirebaseFirestore.DocumentReference[];
}> {
  const batchRefs: FirebaseFirestore.DocumentReference[] = [];
  const recursiveRefs: FirebaseFirestore.DocumentReference[] = [];

  await Promise.all(
    refs.map(async (ref) => {
      const subcollections = await ref.listCollections();
      if (subcollections.length > 0) {
        console.warn(
          `  WARNING: Unexpected subcollections on ${
            ref.path
          }: [${subcollections
            .map((c) => c.id)
            .join(", ")}] — using recursiveDelete`
        );
        recursiveRefs.push(ref);
      } else {
        batchRefs.push(ref);
      }
    })
  );

  return { batchRefs, recursiveRefs };
}

async function executeDeletion(
  db: FirebaseFirestore.Firestore,
  auth: ReturnType<typeof getAuth>,
  plan: DeletionPlan,
  siteId: string
) {
  // Schools, classes, cohorts, and the district doc are expected to be flat,
  // but we verify against the real documents before choosing delete strategy.
  const orgRefs = [
    ...plan.schools.map((s) => db.collection("schools").doc(s.id)),
    ...plan.classes.map((c) => db.collection("classes").doc(c.id)),
    ...plan.cohorts.map((c) => db.collection("groups").doc(c.id)),
    db.collection("districts").doc(siteId),
  ];

  const { batchRefs, recursiveRefs } = await partitionBySubcollections(
    db,
    orgRefs
  );

  const BATCH_LIMIT = 500;
  for (let i = 0; i < batchRefs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    batchRefs.slice(i, i + BATCH_LIMIT).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  for (const ref of recursiveRefs) {
    await db.recursiveDelete(ref);
  }
  console.log(`Deleted ${orgRefs.length} org documents.`);

  // Assignments have subcollections (assignedOrgs, readOrgs, stats)
  for (const assignment of plan.assignments) {
    await db.recursiveDelete(
      db.collection("administrations").doc(assignment.id)
    );
  }
  console.log(`Deleted ${plan.assignments.length} assignments.`);

  // Users: delete Firestore (recursive) + userClaims + Auth
  for (const { uid } of plan.usersToDelete) {
    await db.recursiveDelete(db.collection("users").doc(uid));
    // Best-effort: userClaims may not exist for every user
    await db
      .collection("userClaims")
      .doc(uid)
      .delete()
      .catch(() => {});
    await auth.deleteUser(uid).catch(() => {});
  }
  console.log(`Deleted ${plan.usersToDelete.length} users.`);

  // Disassociate multi-site users: strip site references from their Firestore doc
  if (plan.usersToDisassociate.length > 0) {
    const schoolSet = new Set(plan.schools.map((s) => s.id));
    const classSet = new Set(plan.classes.map((c) => c.id));
    const cohortSet = new Set(plan.cohorts.map((c) => c.id));

    const stripIds = (field: any, idsToRemove: Set<string>) => {
      if (!field) return field;
      const dates = { ...(field.dates ?? {}) };
      for (const id of idsToRemove) delete dates[id];
      return {
        ...field,
        all: (field.all ?? []).filter((id: string) => !idsToRemove.has(id)),
        current: (field.current ?? []).filter(
          (id: string) => !idsToRemove.has(id)
        ),
        dates,
      };
    };

    for (const { uid } of plan.usersToDisassociate) {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) continue;

      const data = userDoc.data()!;
      await userRef.update({
        districts: stripIds(data.districts, new Set([siteId])),
        schools: stripIds(data.schools, schoolSet),
        classes: stripIds(data.classes, classSet),
        groups: stripIds(data.groups, cohortSet),
        roles: (data.roles ?? []).filter((r: any) => r.siteId !== siteId),
      });
    }

    console.log(`Disassociated ${plan.usersToDisassociate.length} users.`);
    console.log(
      "NOTE: Run 'rebuild-custom-claims' to refresh userClaims for disassociated users."
    );
  }
}

async function main() {
  const { env, siteId, apply } = argv;

  console.log(
    `\ndelete-testing-site | env=${env} | siteId=${siteId} | apply=${apply}`
  );

  const app = initializeApp();
  const db = getFirestore(app);
  const auth = getAuth(app);

  console.log("Building deletion plan...");
  const plan = await buildPlan(db, siteId);

  printPlan(plan, siteId);

  if (!apply) {
    console.log("\nPreview only — no changes made. Pass --apply to execute.");
  } else {
    if (env === "prod") {
      const confirmed = await confirmLive(siteId);
      if (!confirmed) {
        console.log("Aborted.");
        await adminApp.deleteApp(app);
        return;
      }
    }

    console.log("\nExecuting deletion...");
    await executeDeletion(db, auth, plan, siteId);
    console.log("\nDeletion complete.");
  }

  await adminApp.deleteApp(app);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
