const admin = require('firebase-admin');

function firestoreValueToJs(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nestedValue]) => [key, firestoreValueToJs(nestedValue)]),
    );
  }
  return undefined;
}

function createFunctionsSeedRuntime({ projectId, appName = 'functions-seed-validation' }) {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8180';
  const functionsOrigin =
    process.env.FUNCTIONS_EMULATOR_ORIGIN || `http://127.0.0.1:${process.env.FIREBASE_FUNCTIONS_EMULATOR_PORT || '5002'}`;
  const app = admin.initializeApp({ projectId }, appName);

  async function requestJson(url, options) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) {
        const error = new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } catch (error) {
      error.url = url;
      throw error;
    }
  }

  async function signIn({ email, password }) {
    const body = await requestJson(
      `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-key`,
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    );

    return {
      idToken: body.idToken,
      uid: body.localId,
    };
  }

  async function callFunction(name, data, idToken) {
    const url = `${functionsOrigin}/${projectId}/us-central1/${name}`;
    const startedAt = Date.now();

    while (true) {
      try {
        const body = await requestJson(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ data }),
        });
        return body.result;
      } catch (error) {
        const isFunctionsStartupRace = error.status === 404 || error.cause?.code === 'ECONNREFUSED';
        if (!isFunctionsStartupRace || Date.now() - startedAt > 60_000) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async function runFirestoreQuery(body, idToken) {
    return requestJson(
      `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      },
    );
  }

  async function getFirstVariant(taskId, idToken) {
    const body = await requestJson(
      `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/tasks/${encodeURIComponent(
        taskId,
      )}/variants?pageSize=1`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${idToken}` },
      },
    );

    const document = body.documents?.[0];
    if (!document) return null;

    return {
      variantId: document.name.split('/').pop(),
      variantName: firestoreValueToJs(document.fields?.name) || 'en',
      params: firestoreValueToJs(document.fields?.params) || {},
    };
  }

  async function getVariantsByTaskIds(taskIds, idToken) {
    const entries = await Promise.all(taskIds.map(async (taskId) => [taskId, await getFirstVariant(taskId, idToken)]));
    return Object.fromEntries(entries.filter(([, variant]) => Boolean(variant)));
  }

  async function countCollection(collectionId) {
    const snapshot = await app.firestore().collection(collectionId).get();
    return snapshot.size;
  }

  async function countAssignmentsForAdministration(administrationId) {
    const snapshot = await app.firestore().collectionGroup('assignments').where('id', '==', administrationId).get();
    return snapshot.size;
  }

  return {
    app,
    callFunction,
    countAssignmentsForAdministration,
    countCollection,
    firestoreHost,
    getVariantsByTaskIds,
    projectId,
    runFirestoreQuery,
    signIn,
  };
}

module.exports = { createFunctionsSeedRuntime, firestoreValueToJs };
