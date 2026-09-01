// API-key lifecycle against Twenty's metadata GraphQL endpoint.
//
// Verified against the running fork (prudai/twenty:v1.19.0-marketing):
//   POST {baseUrl}/metadata
//     query    apiKeys { id name expiresAt revokedAt createdAt }
//     query    getRoles { id label canBeAssignedToApiKeys ... }
//     mutation createApiKey(input: {name, expiresAt, roleId}) -> ApiKey
//     mutation generateApiKeyToken(apiKeyId, expiresAt) -> { token }
//     mutation revokeApiKey(input: {id}) -> ApiKey
//
// Creating a usable key is TWO calls: createApiKey makes the record, then
// generateApiKeyToken mints the JWT. The token is returned exactly once and is
// never retrievable afterwards — Twenty stores no copy.

export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ObjectPermission {
  objectMetadataId: string;
  canReadObjectRecords: boolean | null;
  canUpdateObjectRecords: boolean | null;
  canSoftDeleteObjectRecords: boolean | null;
  canDestroyObjectRecords: boolean | null;
}

export interface Role {
  id: string;
  label: string;
  description?: string | null;
  canBeAssignedToApiKeys: boolean;
  canReadAllObjectRecords: boolean;
  canUpdateAllObjectRecords: boolean;
  canSoftDeleteAllObjectRecords: boolean;
  canDestroyAllObjectRecords: boolean;
  canUpdateAllSettings: boolean;
  /**
   * Per-object grants that sit ON TOP of the workspace-wide flags above. A role
   * can be read-only workspace-wide and still write one object — that is exactly
   * how the agent/QA keys are scoped — so any judgement about what a role may do
   * has to read this too. Absent on older reads; treat undefined as "none".
   */
  objectPermissions?: readonly ObjectPermission[] | null;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt?: string;
}

export function createGraphQLTransport(baseUrl: string, token: string): GraphQLTransport {
  return async (query, variables) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metadata`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body: { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`CATO metadata API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (body.errors?.length) {
      throw new Error(`CATO metadata API error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!res.ok) throw new Error(`CATO metadata API HTTP ${res.status}: ${text.slice(0, 300)}`);
    return body.data ?? {};
  };
}

const ROLE_FIELDS = `
  id
  label
  description
  canBeAssignedToApiKeys
  canReadAllObjectRecords
  canUpdateAllObjectRecords
  canSoftDeleteAllObjectRecords
  canDestroyAllObjectRecords
  canUpdateAllSettings
  objectPermissions {
    objectMetadataId
    canReadObjectRecords
    canUpdateObjectRecords
    canSoftDeleteObjectRecords
    canDestroyObjectRecords
  }
`;

export async function listRoles(transport: GraphQLTransport): Promise<Role[]> {
  const data = await transport(`query { getRoles { ${ROLE_FIELDS} } }`, {});
  return (data.getRoles ?? []) as Role[];
}

/**
 * objectMetadataId -> nameSingular, so per-object grants can be printed by name.
 * Best-effort: a workspace where this query is not permitted still gets its role
 * list, just with ids instead of names.
 */
export async function listObjectNames(transport: GraphQLTransport): Promise<Map<string, string>> {
  try {
    const data = await transport(`query { objects(paging: {first: 200}) { edges { node { id nameSingular } } } }`, {});
    const edges = (data.objects as { edges?: Array<{ node?: { id?: string; nameSingular?: string } }> } | undefined)?.edges ?? [];
    const map = new Map<string, string>();
    for (const edge of edges) {
      if (edge.node?.id && edge.node.nameSingular) map.set(edge.node.id, edge.node.nameSingular);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function listApiKeys(transport: GraphQLTransport): Promise<ApiKeyRecord[]> {
  const data = await transport(
    `query { apiKeys { id name expiresAt revokedAt createdAt } }`,
    {},
  );
  return (data.apiKeys ?? []) as ApiKeyRecord[];
}

export async function createApiKey(
  transport: GraphQLTransport,
  input: { name: string; expiresAt: string; roleId: string },
): Promise<ApiKeyRecord> {
  const data = await transport(
    `mutation CreateApiKey($input: CreateApiKeyInput!) {
       createApiKey(input: $input) { id name expiresAt revokedAt createdAt }
     }`,
    { input },
  );
  return data.createApiKey as ApiKeyRecord;
}

export async function generateApiKeyToken(
  transport: GraphQLTransport,
  args: { apiKeyId: string; expiresAt: string },
): Promise<string> {
  const data = await transport(
    `mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
       generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) { token }
     }`,
    args,
  );
  const result = data.generateApiKeyToken as { token?: string } | undefined;
  if (!result?.token) throw new Error("CATO returned no token for the new API key.");
  return result.token;
}

export async function revokeApiKey(
  transport: GraphQLTransport,
  id: string,
): Promise<ApiKeyRecord> {
  const data = await transport(
    `mutation RevokeApiKey($input: RevokeApiKeyInput!) {
       revokeApiKey(input: $input) { id name expiresAt revokedAt }
     }`,
    { input: { id } },
  );
  return data.revokeApiKey as ApiKeyRecord;
}

export interface CurrentWorkspace {
  id: string;
  displayName?: string | null;
}

export async function currentWorkspace(transport: GraphQLTransport): Promise<CurrentWorkspace | null> {
  const data = await transport(`query { currentWorkspace { id displayName } }`, {});
  return (data.currentWorkspace ?? null) as CurrentWorkspace | null;
}

// ---- token inspection ------------------------------------------------------

export interface TokenClaims {
  sub?: string;
  type?: string;
  workspaceId?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * Decode (NOT verify) a Twenty token so `auth status` can say what kind of
 * credential is loaded without a network round-trip. Verification is the
 * server's job; this is purely descriptive.
 */
export function decodeTokenClaims(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const claims = JSON.parse(json) as TokenClaims;
    return typeof claims === "object" && claims !== null ? claims : null;
  } catch {
    return null;
  }
}

/** The per-object grants that let this role change something, id -> verbs. */
export function writableObjects(role: Role): Array<{ objectMetadataId: string; verbs: string[] }> {
  const out: Array<{ objectMetadataId: string; verbs: string[] }> = [];
  for (const perm of role.objectPermissions ?? []) {
    const verbs: string[] = [];
    if (perm.canUpdateObjectRecords) verbs.push("write");
    if (perm.canSoftDeleteObjectRecords) verbs.push("delete");
    if (perm.canDestroyObjectRecords) verbs.push("destroy");
    if (verbs.length) out.push({ objectMetadataId: perm.objectMetadataId, verbs });
  }
  return out;
}

/**
 * `names` maps objectMetadataId -> nameSingular, so a scoped role reads as
 * "read-all, write:task,comment" instead of a row of UUIDs. Without it the ids
 * are printed — worse to read, but never wrong.
 */
export function describeRolePower(role: Role, names?: ReadonlyMap<string, string>): string {
  const powers: string[] = [];
  if (role.canReadAllObjectRecords) powers.push("read-all");
  if (role.canUpdateAllObjectRecords) powers.push("WRITE-all");
  if (role.canSoftDeleteAllObjectRecords) powers.push("DELETE-all");
  if (role.canDestroyAllObjectRecords) powers.push("DESTROY-all");
  if (role.canUpdateAllSettings) powers.push("ALL-SETTINGS");
  for (const { objectMetadataId, verbs } of writableObjects(role)) {
    powers.push(`${verbs.join("+")}:${names?.get(objectMetadataId) ?? objectMetadataId}`);
  }
  return powers.length ? powers.join(", ") : "scoped/none";
}

/**
 * True only for a role that can read everything and change nothing — including
 * through a per-object grant. Getting this wrong would print "read-only yes"
 * next to a key that can write, which is the one lie this command must not tell.
 */
export function isReadOnlyRole(role: Role): boolean {
  return (
    role.canReadAllObjectRecords &&
    !role.canUpdateAllObjectRecords &&
    !role.canSoftDeleteAllObjectRecords &&
    !role.canDestroyAllObjectRecords &&
    !role.canUpdateAllSettings &&
    writableObjects(role).length === 0
  );
}
