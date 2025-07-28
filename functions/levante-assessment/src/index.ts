import { createSoftDeleteCloudFunction } from "./utils/soft-delete";

export const softDeleteUser = createSoftDeleteCloudFunction(["users"]);
export const softDeleteUserRun = createSoftDeleteCloudFunction([
  "users",
  "runs",
]);
export const softDeleteUserTrial = createSoftDeleteCloudFunction([
  "users",
  "runs",
  "trials",
]);

export const softDeleteGuest = createSoftDeleteCloudFunction(["guests"]);
export const softDeleteGuestRun = createSoftDeleteCloudFunction([
  "guests",
  "runs",
]);
export const softDeleteGuestTrial = createSoftDeleteCloudFunction([
  "guests",
  "runs",
  "trials",
]);
