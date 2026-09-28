import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Registry of offline-launcher devices: one document per device id, written by
 * `provisionOfflinePack` (what the device holds) and `syncOfflineRuns` (when it last
 * checked in). Device ids are minted by the launcher and are opaque; nothing here is
 * authoritative for data — it is the fleet view a site coordinator needs.
 */

export const OFFLINE_DEVICES_COLLECTION = "offlineDevices";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface DeviceInfo {
  deviceId: string;
  platform: string | null;
  appBuild: string | null;
}

/** Validates the optional device block a launcher sends; returns null when absent. */
export function parseDeviceInfo(value: unknown): DeviceInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.deviceId !== "string" || !DEVICE_ID_PATTERN.test(v.deviceId))
    return null;
  return {
    deviceId: v.deviceId,
    platform: typeof v.platform === "string" ? v.platform.slice(0, 64) : null,
    appBuild: typeof v.appBuild === "string" ? v.appBuild.slice(0, 64) : null,
  };
}

export async function touchDevice(
  db: Firestore,
  device: DeviceInfo,
  patch: Record<string, unknown>
): Promise<void> {
  await db
    .collection(OFFLINE_DEVICES_COLLECTION)
    .doc(device.deviceId)
    .set(
      {
        deviceId: device.deviceId,
        ...(device.platform ? { platform: device.platform } : {}),
        ...(device.appBuild ? { appBuild: device.appBuild } : {}),
        lastSeenAt: FieldValue.serverTimestamp(),
        ...patch,
      },
      { merge: true }
    );
}
