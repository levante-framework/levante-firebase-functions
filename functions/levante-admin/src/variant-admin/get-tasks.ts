import { getFirestore } from "firebase-admin/firestore";
import type { TaskDoc } from "../../firestore-schema.js";

export interface TaskSummary extends TaskDoc {
  id: string;
}

export const getTasksHandler = async (): Promise<TaskSummary[]> => {
  const db = getFirestore();
  const snapshot = await db.collection("tasks").get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as TaskDoc),
  }));
};
