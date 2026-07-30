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
`;

export async function listRoles(transport: GraphQLTransport): Promise<Role[]> {
  const data = await transport(`query { getRoles { ${ROLE_FIELDS} } }`, {});
  return (data.getRoles ?? []) as Role[];
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

export function describeRolePower(role: Role): string {
  const powers: string[] = [];
  if (role.canReadAllObjectRecords) powers.push("read-all");
  if (role.canUpdateAllObjectRecords) powers.push("WRITE-all");
  if (role.canSoftDeleteAllObjectRecords) powers.push("DELETE-all");
  if (role.canDestroyAllObjectRecords) powers.push("DESTROY-all");
  if (role.canUpdateAllSettings) powers.push("ALL-SETTINGS");
  return powers.length ? powers.join(", ") : "scoped/none";
}

/** True only for a role that can read everything and change nothing. */
export function isReadOnlyRole(role: Role): boolean {
  return (
    role.canReadAllObjectRecords &&
    !role.canUpdateAllObjectRecords &&
    !role.canSoftDeleteAllObjectRecords &&
    !role.canDestroyAllObjectRecords &&
    !role.canUpdateAllSettings
  );
}
