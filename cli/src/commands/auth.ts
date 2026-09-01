// `cato auth ...` — API-key lifecycle and local profile management.
//
// Two hard rules encoded here:
//  1. Creating or revoking a key is a production change: dry-run is the default
//     and the caller must pass BOTH --no-dry-run and --yes.
//  2. A key is printed exactly once, never written to a log, and never stored
//     in this repo. `auth set` puts it in ~/.config/cato/credentials.json (0600).

import {
  createApiKey, decodeTokenClaims, describeRolePower, generateApiKeyToken,
  isReadOnlyRole, listApiKeys, listObjectNames, listRoles, revokeApiKey, writableObjects,
  type ApiKeyRecord, type GraphQLTransport, type Role,
} from "../auth-api.ts";
import { maskSecret, type CredentialsFile, type Profile, type ResolvedCredentials } from "../config.ts";

export const DEFAULT_EXPIRY_DAYS = 90;

export class AuthError extends Error {}

export function defaultExpiry(now: Date = new Date(), days = DEFAULT_EXPIRY_DAYS): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function normalizeExpiry(value: string | undefined, now: Date = new Date()): string {
  if (!value) return defaultExpiry(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AuthError(`--expires: '${value}' is not a valid date. Use YYYY-MM-DD or an ISO timestamp.`);
  }
  if (d.getTime() <= now.getTime()) {
    throw new AuthError(`--expires: ${d.toISOString()} is in the past.`);
  }
  return d.toISOString();
}

export interface CreatePlan {
  name: string;
  expiresAt: string;
  roleId: string;
  role: Role | null;
  /** Set when the chosen role can do more than read — the caller must surface it. */
  privilegeWarning: string | null;
}

/**
 * Validate a `auth create` request against the roles that actually exist.
 * Pure apart from the roles it is handed, so the warning logic is testable.
 */
export function planCreate(
  input: { name?: string; expires?: string; roleId?: string },
  roles: readonly Role[],
  now: Date = new Date(),
): CreatePlan {
  if (!input.name) throw new AuthError("auth create requires --name.");

  const assignable = roles.filter((r) => r.canBeAssignedToApiKeys);
  if (!input.roleId) {
    const options = assignable.length
      ? assignable.map((r) => `  ${r.id}  ${r.label}  [${describeRolePower(r)}]`).join("\n")
      : "  (none — no role in this workspace has canBeAssignedToApiKeys=true)";
    throw new AuthError(
      `auth create requires --role-id. CATO requires every API key to carry a role.\nRoles that can be attached to an API key:\n${options}`,
    );
  }

  const role = roles.find((r) => r.id === input.roleId) ?? null;
  if (roles.length > 0 && !role) {
    throw new AuthError(`--role-id ${input.roleId} does not exist in this workspace. Run 'cato auth roles'.`);
  }
  if (role && !role.canBeAssignedToApiKeys) {
    throw new AuthError(
      `Role '${role.label}' has canBeAssignedToApiKeys=false — CATO will refuse to attach it to an API key.`,
    );
  }

  let privilegeWarning: string | null = null;
  if (role && !isReadOnlyRole(role)) {
    const scoped = writableObjects(role);
    const workspaceWide = role.canUpdateAllObjectRecords || role.canSoftDeleteAllObjectRecords
      || role.canDestroyAllObjectRecords || role.canUpdateAllSettings;
    // A key that may only touch `task` is a different animal from an Admin key,
    // and saying "can change or delete production CRM data" about both trains
    // the reader to skip the warning. Say which one it is.
    privilegeWarning = workspaceWide
      ? `Role '${role.label}' is NOT read-only: ${describeRolePower(role)}. `
        + `Anyone holding this key can change or delete production CRM data.`
      : `Role '${role.label}' reads everything and writes ${scoped.map((o) => o.verbs.join("+")).join(", ")} `
        + `on ${scoped.length} object(s). Anyone holding this key can change those records in production.`;
  }

  return {
    name: input.name,
    expiresAt: normalizeExpiry(input.expires, now),
    roleId: input.roleId,
    role,
    privilegeWarning,
  };
}

export function renderCreateDryRun(plan: CreatePlan): string {
  const lines = [
    "DRY RUN — no API key was created.",
    "",
    `Name      : ${plan.name}`,
    `Expires   : ${plan.expiresAt}`,
    `Role      : ${plan.role ? `${plan.role.label} (${plan.roleId})` : plan.roleId}`,
    `Powers    : ${plan.role ? describeRolePower(plan.role) : "(unknown — role not resolved)"}`,
  ];
  if (plan.privilegeWarning) lines.push("", `!! ${plan.privilegeWarning}`);
  lines.push(
    "",
    "This would run two mutations against CATO:",
    "  1. createApiKey(input: {name, expiresAt, roleId})",
    "  2. generateApiKeyToken(apiKeyId, expiresAt)  -> the token, shown once",
    "",
    "To actually create it: re-run with --no-dry-run --yes",
  );
  return lines.join("\n");
}

export interface CreatedKey {
  record: ApiKeyRecord;
  token: string;
}

export async function executeCreate(transport: GraphQLTransport, plan: CreatePlan): Promise<CreatedKey> {
  const record = await createApiKey(transport, {
    name: plan.name,
    expiresAt: plan.expiresAt,
    roleId: plan.roleId,
  });
  const token = await generateApiKeyToken(transport, {
    apiKeyId: record.id,
    expiresAt: plan.expiresAt,
  });
  return { record, token };
}

export function renderCreatedKey(created: CreatedKey, plan: CreatePlan): string {
  const lines = [
    "API key created.",
    "",
    `Id      : ${created.record.id}`,
    `Name    : ${created.record.name}`,
    `Expires : ${created.record.expiresAt}`,
    `Role    : ${plan.role ? plan.role.label : plan.roleId}`,
  ];
  if (plan.privilegeWarning) lines.push("", `!! ${plan.privilegeWarning}`);
  lines.push(
    "",
    "==================== SHOWN ONCE ====================",
    created.token,
    "====================================================",
    "",
    "CATO stores no copy of this token. If you lose it, revoke the key and make a new one.",
    "Store it now:  cato auth set --profile <name> --stdin",
    "Do NOT paste it into a chat, a ticket, or a git repo.",
  );
  return lines.join("\n");
}

// ---- revoke ---------------------------------------------------------------

export function renderRevokeDryRun(id: string, key: ApiKeyRecord | undefined): string {
  const lines = ["DRY RUN — nothing was revoked.", "", `Key id : ${id}`];
  if (key) {
    lines.push(`Name   : ${key.name}`, `Expires: ${key.expiresAt}`, `Revoked: ${key.revokedAt ?? "no"}`);
  } else {
    lines.push("Name   : (not found in the active key list — it may already be revoked)");
  }
  lines.push("", "Any integration still using this key will start failing immediately once revoked.",
    "", "To actually revoke it: re-run with --no-dry-run --yes");
  return lines.join("\n");
}

export async function executeRevoke(transport: GraphQLTransport, id: string): Promise<ApiKeyRecord> {
  return revokeApiKey(transport, id);
}

// ---- list / roles ---------------------------------------------------------

export async function runList(transport: GraphQLTransport): Promise<ApiKeyRecord[]> {
  return listApiKeys(transport);
}

export async function runRoles(transport: GraphQLTransport): Promise<Role[]> {
  return listRoles(transport);
}

export async function runObjectNames(transport: GraphQLTransport): Promise<Map<string, string>> {
  return listObjectNames(transport);
}

export function renderRoles(roles: readonly Role[], names?: ReadonlyMap<string, string>): string {
  const lines = ["Roles in this CATO workspace:", ""];
  for (const role of roles) {
    lines.push(
      `${role.label}`,
      `  id               ${role.id}`,
      `  api-key usable   ${role.canBeAssignedToApiKeys ? "yes" : "NO"}`,
      `  powers           ${describeRolePower(role, names)}`,
      `  read-only        ${isReadOnlyRole(role) ? "yes" : "no"}`,
      "",
    );
  }
  const assignable = roles.filter((r) => r.canBeAssignedToApiKeys);
  const leastPrivilege = assignable.filter(
    (r) => r.canReadAllObjectRecords && !r.canUpdateAllObjectRecords
      && !r.canSoftDeleteAllObjectRecords && !r.canDestroyAllObjectRecords && !r.canUpdateAllSettings,
  );
  if (leastPrivilege.length === 0) {
    lines.push(
      "!! Every role that can be attached to an API key also grants workspace-wide WRITE.",
      "   Fix: create a role with canReadAllObjectRecords=true, all update/delete/settings",
      "   flags false, and canBeAssignedToApiKeys=true; then grant writes per object with",
      "   upsertObjectPermissions (system objects such as taskTarget reject that call, but",
      "   inherit from the object they hang off — a `task` grant is enough to link a task).",
    );
  } else {
    lines.push(
      `Least-privilege option for a new key: ${leastPrivilege.map((r) => `'${r.label}'`).join(", ")}.`,
      "Prefer that over Admin unless the key genuinely needs workspace-wide write.",
    );
  }
  return lines.join("\n");
}

// ---- set ------------------------------------------------------------------

export interface SetProfileInput {
  profileName: string;
  apiKey?: string;
  userToken?: string;
  baseUrl?: string;
  note?: string;
  setDefault?: boolean;
}

/** Pure merge so the credentials-file mutation can be asserted without disk I/O. */
export function applyProfile(file: CredentialsFile, input: SetProfileInput): CredentialsFile {
  if (!input.apiKey && !input.userToken) {
    throw new AuthError("auth set needs --api-key, --user-token or --stdin.");
  }
  const existing: Profile = file.profiles[input.profileName] ?? {};
  const profile: Profile = {
    ...existing,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.userToken ? { userToken: input.userToken } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const profiles = { ...file.profiles, [input.profileName]: profile };
  return {
    version: 1,
    defaultProfile: input.setDefault ? input.profileName : file.defaultProfile,
    profiles,
  };
}

// ---- status ---------------------------------------------------------------

export interface StatusReport {
  profileName: string;
  source: string;
  baseUrl: string;
  apiKey: string;
  userToken: string;
  tokenType: string | null;
  workspaceId: string | null;
  expiresAt: string | null;
  expired: boolean | null;
  marketingCapable: boolean;
}

export function buildStatus(creds: ResolvedCredentials, now: Date = new Date()): StatusReport {
  const claims = creds.apiKey ? decodeTokenClaims(creds.apiKey) : null;
  const exp = claims?.exp ? new Date(claims.exp * 1000).toISOString() : null;
  return {
    profileName: creds.profileName,
    source: creds.source,
    baseUrl: creds.baseUrl,
    apiKey: maskSecret(creds.apiKey),
    userToken: maskSecret(creds.userToken),
    tokenType: claims?.type ?? null,
    workspaceId: claims?.workspaceId ?? null,
    expiresAt: exp,
    expired: claims?.exp ? claims.exp * 1000 < now.getTime() : null,
    // The marketing module resolves permissions from a workspace member, which
    // an API key does not have. Only a user session token reaches it.
    marketingCapable: Boolean(creds.userToken),
  };
}

export function renderStatus(status: StatusReport, roleLine: string | null): string {
  const lines = [
    `Profile      : ${status.profileName}`,
    `Source       : ${status.source}`,
    `Base URL     : ${status.baseUrl}`,
    `API key      : ${status.apiKey}`,
    `Token type   : ${status.tokenType ?? "(not a decodable JWT)"}`,
    `Workspace    : ${status.workspaceId ?? "(unknown)"}`,
    `Key expires  : ${status.expiresAt ?? "(unknown)"}${status.expired === true ? "  ** EXPIRED **" : ""}`,
    `User token   : ${status.userToken}`,
    `Marketing    : ${status.marketingCapable ? "available (user token present)" : "UNAVAILABLE — needs a user session token, an API key is refused by the marketing module"}`,
  ];
  if (roleLine) lines.push(`Role         : ${roleLine}`);
  return lines.join("\n");
}
