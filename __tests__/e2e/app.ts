import { initializeApp as initClientApp, deleteApp } from "firebase/app";
import {
  getAuth as getClientAuth,
  connectAuthEmulator,
  signInWithCustomToken,
} from "firebase/auth";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { initializeApp as initAdminApp, getApps } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "demo-emulator";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8180";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9199";

if (!getApps().length) initAdminApp({ projectId: PROJECT_ID });

export const adminAuth = getAdminAuth();
export const adminDb = getFirestore();

export function getClient() {
  const app = initClientApp(
    { projectId: PROJECT_ID, apiKey: "fake-api-key" },
    `e2e-${Date.now()}`
  );
  const auth = getClientAuth(app);
  const functions = getFunctions(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5002);
  return {
    app,
    auth,
    call: <I, O>(name: string) => httpsCallable<I, O>(functions, name),
    cleanup: () => deleteApp(app),
  };
}

export async function signInAs(
  client: ReturnType<typeof getClient>,
  uid: string,
  claims: Record<string, unknown>
) {
  await adminAuth.createUser({ uid }).catch((e) => {
    if (e.code !== "auth/uid-already-exists") throw e;
  });
  await adminAuth.setCustomUserClaims(uid, claims);
  const token = await adminAuth.createCustomToken(uid, claims);
  await signInWithCustomToken(client.auth, token);
}

export async function clearFirestore() {
  const res = await fetch(
    `http://127.0.0.1:8180/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

export async function clearAuth() {
  await fetch(
    `http://127.0.0.1:9199/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: "DELETE" }
  );
}

// Note: the Functions emulator caches the loaded matrix in-process for its lifetime.
// Reseeding here updates Firestore but won't replace what already-running handlers see.
// Fine while every test uses DEFAULT_PERMISSION_MATRIX; revisit if matrix variants are needed.
export async function seedSystemPermissions() {
  const { DEFAULT_PERMISSION_MATRIX } = await import(
    "@levante-framework/permissions-core"
  );
  await adminDb.doc("system/permissions").set({
    permissions: DEFAULT_PERMISSION_MATRIX,
    version: "1.1.0",
    updatedAt: new Date().toISOString(),
  });
}
