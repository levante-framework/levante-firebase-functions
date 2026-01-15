#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { readFile } from "node:fs/promises";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";
import Papa from "papaparse";

type AnyObject = Record<string, unknown>;
type RoleEntry = Record<string, unknown> & {
  siteId?: unknown;
  role?: unknown;
  siteName?: unknown;
};

interface CsvRow {
  id: string;
  email?: string;
  name?: string;
  role: string;
}

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const claimsWithinLimit = (claims: AnyObject): boolean => {
  try {
    const str = JSON.stringify(claims);
    return Buffer.byteLength(str, "utf8") <= 1000;
  } catch {
    return false;
  }
};

const updateRoleEntries = (
  rolesValue: unknown,
  newRole: string,
): { updatedRoles: unknown[]; changed: boolean; siteIds: string[] } => {
  if (!Array.isArray(rolesValue)) {
    return { updatedRoles: [], changed: false, siteIds: [] };
  }

  let changed = false;
  const siteIds: string[] = [];
  const updatedRoles = rolesValue.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const roleEntry = entry as RoleEntry;
    const siteId =
      typeof roleEntry.siteId === "string" ? roleEntry.siteId.trim() : "";
    if (siteId.length > 0) {
      siteIds.push(siteId);
    }

    if (typeof roleEntry.role !== "string") {
      return entry;
    }

    const currentRole = roleEntry.role.trim();
    if (currentRole !== newRole || roleEntry.role !== newRole) {
      changed = true;
      return { ...roleEntry, role: newRole };
    }

    return entry;
  });

  return { updatedRoles, changed, siteIds };
};

const extractSiteIds = (rolesValue: unknown): string[] => {
  if (!Array.isArray(rolesValue)) {
    return [];
  }

  const siteIds: string[] = [];
  for (const entry of rolesValue) {
    if (!entry || typeof entry !== "object") continue;
    const siteId = (entry as RoleEntry).siteId;
    if (typeof siteId === "string" && siteId.trim().length > 0) {
      siteIds.push(siteId.trim());
    }
  }

  return siteIds;
};

const updateClaimsRoles = (
  claims: AnyObject | undefined,
  newRole: string,
): { updatedClaims?: AnyObject; changed: boolean } => {
  if (!claims || typeof claims !== "object") {
    return { updatedClaims: undefined, changed: false };
  }

  let changed = false;
  const updatedClaims: AnyObject = { ...claims };

  if (Array.isArray(claims.roles)) {
    const { updatedRoles, changed: rolesChanged } = updateRoleEntries(
      claims.roles,
      newRole,
    );
    if (rolesChanged) {
      updatedClaims.roles = updatedRoles;
      changed = true;
    }
  }

  if (Array.isArray(claims.rolesSet)) {
    const rolesSet = (claims.rolesSet as unknown[]).filter(
      (role): role is string => typeof role === "string",
    );
    if (rolesSet.length > 0) {
      const nextRolesSet = [newRole];
      if (JSON.stringify(rolesSet) !== JSON.stringify(nextRolesSet)) {
        updatedClaims.rolesSet = nextRolesSet;
        changed = true;
      }
    }
  }

  if (claims.siteRoles && typeof claims.siteRoles === "object") {
    const siteRoles = claims.siteRoles as Record<string, unknown>;
    let siteRolesChanged = false;
    const updatedSiteRoles: Record<string, unknown> = { ...siteRoles };

    for (const [siteId, rolesValue] of Object.entries(siteRoles)) {
      if (!Array.isArray(rolesValue)) {
        continue;
      }

      const roleStrings = rolesValue.filter(
        (role): role is string => typeof role === "string",
      );

      if (roleStrings.length === 0) {
        continue;
      }

      const nextRoles = [newRole];
      if (JSON.stringify(roleStrings) !== JSON.stringify(nextRoles)) {
        updatedSiteRoles[siteId] = nextRoles;
        siteRolesChanged = true;
      }
    }

    if (siteRolesChanged) {
      updatedClaims.siteRoles = updatedSiteRoles;
      changed = true;
    }
  }

  return { updatedClaims, changed };
};

const updateAdministrators = (
  administratorsValue: unknown,
  adminUid: string,
  newRole: string,
): { updated: Array<Record<string, unknown>>; changed: boolean; matched: boolean } => {
  if (!Array.isArray(administratorsValue)) {
    return { updated: [], changed: false, matched: false };
  }

  let changed = false;
  let matched = false;
  const updated = administratorsValue.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry as Record<string, unknown>;
    }

    const record = entry as Record<string, unknown>;
    if (record.adminUid !== adminUid) {
      return record;
    }

    matched = true;
    if (record.role !== newRole) {
      changed = true;
      return { ...record, role: newRole };
    }

    return record;
  });

  return { updated, changed, matched };
};

const loadCsvAssignments = async (
  csvPath: string,
): Promise<{ assignments: Map<string, CsvRow>; skippedMissingRole: number }> => {
  const content = await readFile(csvPath, "utf8");
  const normalized = content.replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Record<string, unknown>>(normalized, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    console.warn("CSV parse warnings:");
    for (const err of parsed.errors) {
      console.warn(`- ${err.message}`);
    }
  }

  const fields = parsed.meta.fields ?? [];
  const requiredFields = ["id", "role"];
  const missingFields = requiredFields.filter((field) => !fields.includes(field));
  if (missingFields.length > 0) {
    throw new Error(`CSV is missing required columns: ${missingFields.join(", ")}`);
  }

  const assignments = new Map<string, CsvRow>();
  const conflicts: string[] = [];
  let skippedMissingRole = 0;

  for (const row of parsed.data) {
    const id = normalizeString(row.id);
    const role = normalizeString(row.role);
    const email = normalizeString(row.email);
    const name = normalizeString(row.name);

    if (!id) {
      console.warn(`Skipping row with missing id: ${JSON.stringify(row)}`);
      continue;
    }

    if (!role) {
      skippedMissingRole++;
      console.warn(`Skipping row with missing role for id ${id}`);
      continue;
    }

    const existing = assignments.get(id);
    if (existing && existing.role !== role) {
      conflicts.push(id);
      continue;
    }

    assignments.set(id, { id, email, name, role });
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Conflicting roles for the same id in CSV: ${conflicts.join(", ")}`,
    );
  }

  return { assignments, skippedMissingRole };
};

const parsedArgs = yargs(hideBin(process.argv))
  .option("d", {
    alias: "database",
    describe: "Database: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "dev",
  })
  .option("csv", {
    describe: "Path to input CSV file",
    type: "string",
    demandOption: true,
  })
  .option("dry-run", {
    describe: "Run without making changes to Firestore or Auth",
    type: "boolean",
    default: true,
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const dryRun = parsedArgs["dry-run"] as boolean;
const csvPath = parsedArgs.csv as string;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);

const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;
if (!adminCredentialFile) {
  console.error(
    `Missing required environment variable:
    - LEVANTE_ADMIN_FIREBASE_CREDENTIALS
    Please set this environment variable using
    export LEVANTE_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);
const auth = getAuth(adminApp);

async function updateUserRolesFromCsv() {
  try {
    const { assignments, skippedMissingRole } = await loadCsvAssignments(csvPath);

    if (assignments.size === 0) {
      console.log("No valid rows found in CSV.");
      return;
    }

    console.log(`Loaded ${assignments.size} user(s) from CSV.\n`);

    const progressBar = new cliProgress.SingleBar({
      format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });
    progressBar.start(assignments.size, 0);

    const stats = {
      processed: 0,
      skippedMissingRole,
      missingUsers: 0,
      missingUserClaims: 0,
      missingAuth: 0,
      missingDistricts: 0,
      userDocsUpdated: 0,
      userClaimsUpdated: 0,
      authUpdated: 0,
      districtsUpdated: 0,
      adminEntriesMissing: 0,
      noRoleArray: 0,
      errors: 0,
    };

    for (const [uid, assignment] of assignments.entries()) {
      const newRole = assignment.role;
      try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) {
          console.warn(`User doc not found for uid ${uid}`);
          stats.missingUsers++;
          stats.processed++;
          progressBar.update(stats.processed);
          continue;
        }

        const userData = userDoc.data() ?? {};
        const { updatedRoles, changed: rolesChanged, siteIds } =
          updateRoleEntries(userData.roles, newRole);

        if (assignment.email) {
          const docEmail = normalizeString((userData as AnyObject).email);
          if (docEmail && docEmail.toLowerCase() !== assignment.email.toLowerCase()) {
            console.warn(
              `Email mismatch for uid ${uid}: CSV=${assignment.email} doc=${docEmail}`,
            );
          }
        }

        const districtIds = Array.from(
          new Set(
            (siteIds.length > 0 ? siteIds : extractSiteIds(userData.roles)).filter(
              (siteId) => siteId && siteId !== "any",
            ),
          ),
        );

        const batch = db.batch();
        let hasBatchUpdates = false;

        if (rolesChanged) {
          batch.update(userDoc.ref, { roles: updatedRoles });
          hasBatchUpdates = true;
          stats.userDocsUpdated++;
        } else if (!Array.isArray(userData.roles)) {
          stats.noRoleArray++;
        }

        const userClaimsRef = db.collection("userClaims").doc(uid);
        const userClaimsSnap = await userClaimsRef.get();
        if (userClaimsSnap.exists) {
          const claimsData = userClaimsSnap.data()?.claims as AnyObject | undefined;
          const { updatedClaims, changed: claimsChanged } =
            updateClaimsRoles(claimsData, newRole);
          if (claimsChanged && updatedClaims) {
            batch.set(userClaimsRef, { claims: updatedClaims }, { merge: true });
            hasBatchUpdates = true;
            stats.userClaimsUpdated++;
          }
        } else {
          stats.missingUserClaims++;
        }

        for (const districtId of districtIds) {
          const districtRef = db.collection("districts").doc(districtId);
          const districtSnap = await districtRef.get();
          if (!districtSnap.exists) {
            stats.missingDistricts++;
            continue;
          }

          const { updated, changed, matched } = updateAdministrators(
            districtSnap.data()?.administrators,
            uid,
            newRole,
          );

          if (!matched) {
            stats.adminEntriesMissing++;
            continue;
          }

          if (changed) {
            batch.update(districtRef, {
              administrators: updated,
              updatedAt: FieldValue.serverTimestamp(),
            });
            hasBatchUpdates = true;
            stats.districtsUpdated++;
          }
        }

        if (!dryRun && hasBatchUpdates) {
          await batch.commit();
        }

        try {
          const authRecord = await auth.getUser(uid);
          const currentClaims = (authRecord.customClaims ?? {}) as AnyObject;
          const { updatedClaims, changed: claimsChanged } =
            updateClaimsRoles(currentClaims, newRole);
          if (claimsChanged && updatedClaims) {
            if (!claimsWithinLimit(updatedClaims)) {
              console.error(`Skipping auth claims for ${uid}: claims exceed size limit`);
            } else if (!dryRun) {
              await auth.setCustomUserClaims(uid, updatedClaims);
              stats.authUpdated++;
            } else {
              stats.authUpdated++;
            }
          }
        } catch (authError: unknown) {
          const authCode = (authError as { code?: string })?.code;
          if (authCode === "auth/user-not-found") {
            stats.missingAuth++;
          } else {
            console.error(`Auth error for ${uid}:`, authError);
            stats.errors++;
          }
        }
      } catch (error) {
        console.error(`Error processing uid ${uid}:`, error);
        stats.errors++;
      }

      stats.processed++;
      progressBar.update(stats.processed);
    }

    progressBar.stop();

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Environment: ${isDev ? "development" : "production"}`);
    console.log(`Dry run: ${dryRun ? "YES (no changes made)" : "NO (changes applied)"}`);
    console.log(`Total users processed: ${stats.processed}`);
    console.log(`CSV rows skipped (missing role): ${stats.skippedMissingRole}`);
    console.log(`User docs updated: ${stats.userDocsUpdated}`);
    console.log(`userClaims updated: ${stats.userClaimsUpdated}`);
    console.log(`Auth claims updated: ${stats.authUpdated}`);
    console.log(`Districts updated: ${stats.districtsUpdated}`);
    console.log(`Missing user docs: ${stats.missingUsers}`);
    console.log(`Missing userClaims docs: ${stats.missingUserClaims}`);
    console.log(`Missing Auth users: ${stats.missingAuth}`);
    console.log(`Missing districts: ${stats.missingDistricts}`);
    console.log(`Admins missing in district arrays: ${stats.adminEntriesMissing}`);
    console.log(`Users missing roles array: ${stats.noRoleArray}`);
    console.log(`Errors: ${stats.errors}`);
    console.log("========================================\n");

    if (dryRun) {
      console.log("Dry run complete. Run with --dry-run=false to apply changes.");
    }
  } catch (fatalError) {
    console.error("Fatal error:", fatalError);
    process.exit(1);
  } finally {
    try {
      await admin.deleteApp(adminApp);
    } catch {
      // no-op
    }
  }
}

updateUserRolesFromCsv();
