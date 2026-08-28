export type OrgType = "site" | "school";

export function orgCollectionFromOrgType(
  orgType: OrgType
): "districts" | "schools" {
  if (orgType === "site") return "districts";
  return "schools";
}

export function formIdFromOrgType(
  orgType: OrgType
): "siteInformation" | "schoolInformation" {
  if (orgType === "site") return "siteInformation";
  return "schoolInformation";
}
