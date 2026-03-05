const path = require('path');
const fs = require('fs');

/**
 * Target for seed/clear scripts.
 * - No SEED_PROJECT → try projectId from firebaseconfig.js, else emulator.
 * - SEED_PROJECT=projectId → use that Firebase project (Auth + Firestore).
 */
function loadProjectIdFromFirebaseConfig() {
  const configPath = path.resolve(__dirname, '..', 'firebaseconfig.js');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/projectId:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getSeedConfig() {
  const forceEmulator =
    process.env.EMULATOR === '1' || process.env.USE_EMULATOR === '1';
  const projectId = forceEmulator
    ? null
    : process.env.SEED_PROJECT ||
      process.env.FIREBASE_PROJECT ||
      loadProjectIdFromFirebaseConfig();
  const isEmulator = forceEmulator || !projectId;

  return {
    projectId: projectId || 'demo-emulator',
    isEmulator,
  };
}

module.exports = { getSeedConfig };
