import * as admin from "firebase-admin/app";
import { getFirestore, WriteResult } from "firebase-admin/firestore";

/**
 * This script will go through all assignment documents in the database and
 * add params to each assessment entry.
 */
const dryRun = false;

const adminCredentialFile = process.env.ROAR_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variables:
    - ROAR_ADMIN_FIREBASE_CREDENTIALS
    Please set these environment variables using
    export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId: "hs-levante-admin-dev",
  },
  "admin",
);

const db = getFirestore(adminApp);

const assignmentCollection = db.collectionGroup("assignments");

const assignmentQuery = assignmentCollection;
console.log("query", assignmentQuery);
const adminDict: { [x: string]: any } = {};

for await (const partition of assignmentQuery.getPartitions(100)) {
  const partitionedQuery = partition.toQuery();
  await partitionedQuery.get().then(async (querySnapshot) => {
    console.log(`Found ${querySnapshot.size} assignment documents.`);
    const promises: Promise<WriteResult>[] = [];
    for (const doc of querySnapshot.docs) {
      const docData = doc.data();
      const adminId = docData.id;
      let adminData: any | null = null;
      const updateDoc = docData;

      // Check the dictionary for this admininstration
      if (adminDict[adminId]) {
        // console.log(`Found admin ${adminId} in dictionary.`);
        adminData = adminDict[adminId];
      } else {
        console.log(`Fetching admin ${adminId} from Firestore.`);
        // Grab admin document at adminId
        if (adminId) {
          const adminDoc = await db
            .collection("administrations")
            .doc(adminId)
            .get();
          // console.log(`Admin ${adminId} exists: ${adminDoc.exists}`);
          if (adminDoc.exists) {
            const adminDocData = adminDoc.data();
            adminDict[adminId] = adminDocData;
            adminData = adminDocData;
            // console.log("setting up adminDict with adminData", adminDict);
          } else {
            console.log(
              `Admin ${adminId} does not exist. Looking at ${doc.ref.path}`,
            );
            continue;
          }
        } else {
          console.log(
            `Could not find admin ${adminId}. Looking at ${doc.ref.path}`,
          );
        }
      }

      // Now with adminData filled in, add params to each assessment
      if (adminData) {
        // Write name, publicName, sequential and dateCreated to each assessment
        updateDoc.name = adminData.name;
        updateDoc.publicName = adminData.publicName ?? adminData.name;
        updateDoc.dateCreated = adminData.dateCreated;
        updateDoc.sequential = adminData.sequential;
        updateDoc.createdBy = adminData.createdBy;

        // Now for each of the assessments, include the params from the administration doc
        for (const assessment of updateDoc.assessments) {
          // console.log("Assessment", assessment);
          const { taskId } = assessment;
          // console.log("TaskId", taskId);
          // console.log("AdminData", adminData);
          const adminAssessments = adminData.assessments;
          // console.log("Found admin Assessments", adminAssessments);
          const adminTask = adminAssessments.find((a) => a.taskId === taskId);
          if (adminTask && adminTask.params) {
            // console.log("params", adminTask.params);
            assessment.params = adminTask.params;
          } else {
            console.log(
              `No params found for taskId ${taskId} in administration ${adminId}`,
            );
          }
        }
        // All assessments should have been updated in the updateDoc object.
        if (!dryRun) {
          console.log(`Updating ${doc.ref.path} with updated assessments`);
          console.log(updateDoc);
          promises.push(doc.ref.update(updateDoc));
        } else {
          console.log(`Would update ${doc.ref.path} with updated assessments`);
          console.log(updateDoc);
          console.log("\n\n\n");
        }
      }
    }
    const results = await Promise.all(promises);
    console.log("Results", results);
  });
  console.log("Next partition...");
}
