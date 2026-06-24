const { GoogleAuth } = require("google-auth-library");

const FIRESTORE_BASE_URL = "https://firestore.googleapis.com/v1";

function firestoreValueToJs(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(firestoreValueToJs);
  }
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nestedValue]) => [
        key,
        firestoreValueToJs(nestedValue),
      ])
    );
  }
  return undefined;
}

function firestoreDocumentToJs(document) {
  return Object.fromEntries(
    Object.entries(document?.fields || {}).map(([key, value]) => [
      key,
      firestoreValueToJs(value),
    ])
  );
}

function parseDocumentId(documentName) {
  const parts = String(documentName || "").split("/");
  return parts[parts.length - 1];
}

async function requestWithAuth({ authClient, url, method = "GET", body }) {
  const token = await authClient.getAccessToken();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.token || token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${url} failed: ${response.status} ${JSON.stringify(
        responseBody
      )}`
    );
  }

  return responseBody;
}

async function fetchRegisteredTasks({ sourceProjectId, authClient }) {
  const url = `${FIRESTORE_BASE_URL}/projects/${sourceProjectId}/databases/(default)/documents:runQuery`;
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: "tasks" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "registered" },
          op: "EQUAL",
          value: { booleanValue: true },
        },
      },
    },
  };

  const rows = await requestWithAuth({
    authClient,
    url,
    method: "POST",
    body: queryBody,
  });

  return rows
    .filter((row) => row.document)
    .map((row) => ({
      id: parseDocumentId(row.document.name),
      data: firestoreDocumentToJs(row.document),
    }));
}

async function fetchRegisteredVariants({
  sourceProjectId,
  taskId,
  authClient,
}) {
  const url = `${FIRESTORE_BASE_URL}/projects/${sourceProjectId}/databases/(default)/documents/tasks/${encodeURIComponent(
    taskId
  )}/variants?pageSize=1000`;

  const body = await requestWithAuth({ authClient, url, method: "GET" });
  const variants = body.documents || [];

  return variants
    .map((document) => ({
      id: parseDocumentId(document.name),
      data: firestoreDocumentToJs(document),
    }))
    .filter((variant) => variant.data.registered === true);
}

async function seedRegisteredTasksFromProject({
  targetApp,
  sourceProjectId = "hs-levante-admin-dev",
  verbose = true,
}) {
  if (!targetApp) throw new Error("targetApp is required");

  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const authClient = await auth.getClient();

  if (verbose) {
    console.log(
      `  Copying registered tasks/variants from ${sourceProjectId}...`
    );
  }

  const db = targetApp.firestore();
  const tasks = await fetchRegisteredTasks({ sourceProjectId, authClient });

  let variantsWritten = 0;

  for (const task of tasks) {
    const taskRef = db.collection("tasks").doc(task.id);
    await taskRef.set(task.data, { merge: true });

    const variants = await fetchRegisteredVariants({
      sourceProjectId,
      taskId: task.id,
      authClient,
    });

    for (const variant of variants) {
      await taskRef.collection("variants").doc(variant.id).set(variant.data, {
        merge: true,
      });
      variantsWritten++;
    }
  }

  const summary = {
    sourceProjectId,
    tasksWritten: tasks.length,
    variantsWritten,
  };

  if (verbose) {
    console.log(
      `  ✅ Copied ${summary.tasksWritten} registered tasks and ${summary.variantsWritten} registered variants`
    );
  }

  return summary;
}

module.exports = { seedRegisteredTasksFromProject };
