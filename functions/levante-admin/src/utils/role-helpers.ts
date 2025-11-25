import _uniqBy from "lodash-es/uniqBy.js";

export interface RoleDefinition {
  siteId: string;
  role: string;
  siteName: string;
}

export interface RoleClaimsStructure {
  roles: RoleDefinition[];
  rolesSet: string[];
  siteRoles: Record<string, string[]>;
  siteNames: Record<string, string>;
}

export const sanitizeRoles = (roles: RoleDefinition[] = []) =>
  _uniqBy(
    roles
      .map(({ siteId, role, siteName }) => ({
        siteId: String(siteId ?? "").trim(),
        role: String(role ?? "").trim(),
        siteName: String(siteName ?? "").trim(),
      }))
      .filter(({ siteId, role }) => siteId.length > 0 && role.length > 0)
      .map((role) => ({
        ...role,
        siteName: role.siteName.length > 0 ? role.siteName : role.siteId,
      })),
    (role) => `${role.siteId}::${role.role}`
  );

export const buildRoleClaimsStructure = (
  roles: RoleDefinition[]
): RoleClaimsStructure => {
  const sanitizedRoles = sanitizeRoles(roles);

  const rolesSet = Array.from(
    new Set(sanitizedRoles.map((role) => role.role))
  ) as string[];

  const siteRoles: Record<string, string[]> = {};
  const siteNames: Record<string, string> = {};

  for (const role of sanitizedRoles) {
    if (!siteRoles[role.siteId]) {
      siteRoles[role.siteId] = [];
    }

    if (!siteRoles[role.siteId].includes(role.role)) {
      siteRoles[role.siteId].push(role.role);
    }

    if (!siteNames[role.siteId]) {
      siteNames[role.siteId] = role.siteName || role.siteId;
    }
  }

  return {
    roles: sanitizedRoles,
    rolesSet,
    siteRoles,
    siteNames,
  };
};

export const extractRolesFromClaims = (
  claims: Record<string, unknown> = {}
): RoleDefinition[] => {
  const siteRoles = (claims as { siteRoles?: unknown }).siteRoles ?? {};
  const siteNames = (claims as { siteNames?: unknown }).siteNames ?? {};

  const rolesFromSiteRoles = Object.entries(
    siteRoles as Record<string, unknown>
  )
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    .flatMap(([siteId, roleList]) =>
      roleList.map((role) => ({
        siteId,
        role,
        siteName:
          typeof (siteNames as Record<string, unknown>)[siteId] === "string"
            ? String((siteNames as Record<string, unknown>)[siteId]).trim()
            : siteId,
      }))
    );

  if (rolesFromSiteRoles.length > 0) {
    return sanitizeRoles(rolesFromSiteRoles);
  }

  const legacyRoles = (claims as { roles?: unknown }).roles;
  if (Array.isArray(legacyRoles)) {
    return sanitizeRoles(
      legacyRoles.map((role) => ({
        siteId: (role as Record<string, unknown>)?.siteId,
        role: (role as Record<string, unknown>)?.role,
        siteName: (role as Record<string, unknown>)?.siteName,
      })) as RoleDefinition[]
    );
  }

  return [];
};

export const mergeRoleClaimsIntoClaims = <T extends Record<string, unknown>>(
  claims: T
) => {
  const roleDefinitions = extractRolesFromClaims(claims);
  const roleClaims = buildRoleClaimsStructure(roleDefinitions);

  return {
    roleClaims,
    claims: {
      ...claims,
      ...roleClaims,
      roles: roleClaims.roles,
    } as T & RoleClaimsStructure & { roles: RoleDefinition[] },
  };
};
