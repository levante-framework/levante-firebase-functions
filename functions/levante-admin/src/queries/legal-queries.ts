import { getFirestore } from "firebase-admin/firestore";

export const getLegalDocs = async () => {
  const db = getFirestore();
  const snapshot = await db.collection("legal").get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const lastUpdated = doc.createTime?.toDate().toLocaleString();
    return {
      type: doc.id.charAt(0).toUpperCase() + doc.id.slice(1),
      fileName: data.fileName,
      gitHubOrg: data.gitHubOrg,
      gitHubRepository: data.gitHubRepository,
      currentCommit: data.currentCommit,
      lastUpdated,
      params: data.params,
    };
  });
};
