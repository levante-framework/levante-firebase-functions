import * as dotenv from "dotenv";

dotenv.config();

export const config = {
  useEmulator: process.env.USE_EMULATOR === "true",
  projectId: process.env.FIREBASE_PROJECT_ID || "demo-emulator",
  emulatorPorts: {
    firestore: parseInt(process.env.FIRESTORE_EMULATOR_PORT || "8080"),
    auth: parseInt(process.env.AUTH_EMULATOR_PORT || "9099"),
  },
};
