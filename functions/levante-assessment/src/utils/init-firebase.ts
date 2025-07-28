import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { config } from "./config";

/**
 * Initializes the Firebase admin SDK with configuration from environment variables
 * Will connect to emulators if config.useEmulator is true
 */
export const initializeFirebase = (appName = "default") => {
  try {
    // Try to get an existing app instance
    return admin.getApp(appName);
  } catch (error) {
    // Initialize a new app
    const app = admin.initializeApp(
      {
        projectId: config.projectId,
      },
      appName
    );

    const db = getFirestore(app);
    const auth = getAuth(app);

    // Connect to emulators if configured
    if (config.useEmulator) {
      console.log(`Using Firebase emulators for ${appName}`);

      // Set environment variables for emulators
      process.env.FIRESTORE_EMULATOR_HOST = `localhost:${config.emulatorPorts.firestore}`;
      process.env.FIREBASE_AUTH_EMULATOR_HOST = `localhost:${config.emulatorPorts.auth}`;
    } else {
      console.log(`Using production Firebase for ${appName}`);
    }

    return app;
  }
};

/**
 * Gets initialized Firebase services
 */
export const getFirebaseServices = (appName = "default") => {
  const app = initializeFirebase(appName);
  return {
    app,
    db: getFirestore(app),
    auth: getAuth(app),
  };
};
