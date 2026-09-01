import { describe, expect, it } from "bun:test";
import {
  applyProfile, AuthError, buildStatus, defaultExpiry, executeCreate, executeRevoke,
  normalizeExpiry, planCreate, renderCreateDryRun, renderCreatedKey, renderRoles,
} from "../src/commands/auth.ts";
import {
  decodeTokenClaims, describeRolePower, isReadOnlyRole, writableObjects,
  type GraphQLTransport, type Role,
} from "../src/auth-api.ts";
import { maskSecret, resolveCredentials, type CredentialsFile } from "../src/config.ts";

// Roles as they really are in the CATO workspace today (verified 2026-07-30).
const ADMIN: Role = {
  id: "fa2c4823-0337-47cb-9b00-35437439ed38",
  label: "Admin",
  canBeAssignedToApiKeys: true,
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: true,
  canSoftDeleteAllObjectRecords: true,
  canDestroyAllObjectRecords: true,
  canUpdateAllSettings: true,
};
const MEMBER: Role = { ...ADMIN, id: "member-id", label: "Member", canBeAssignedToApiKeys: false, canUpdateAllSettings: false };
const READ_ONLY: Role = {
  id: "readonly-id",
  label: "Read only (hypothetical)",
  canBeAssignedToApiKeys: true,
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
};
// The role that actually carries the agent/QA keys (created 2026-09-01): read
// everything workspace-wide, write nothing workspace-wide, and a per-object
// grant on task + comment. Every workspace-wide flag is identical to READ_ONLY,
// so this fixture is exactly the case the old flag-only logic got wrong.
const TASK_WRITER: Role = {
  ...READ_ONLY,
  id: "0a7eba3e-b6d5-45f2-ba20-c0ca4181b776",
  label: "Agent — lezen + taken",
  objectPermissions: [
    { objectMetadataId: "task-id", canReadObjectRecords: true, canUpdateObjectRecords: true, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
    { objectMetadataId: "comment-id", canReadObjectRecords: true, canUpdateObjectRecords: true, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
  ],
};

/** Records every call so we can assert that a dry run made none. */
function mockTransport(responses: Record<string, unknown>): GraphQLTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport: GraphQLTransport = async (query: string) => {
    const name = query.match(/(?:mutation|query)\s+(\w+)/)?.[1]
      ?? query.match(/\{\s*(\w+)/)?.[1]
      ?? "unknown";
    calls.push(name);
    return (responses[name] ?? {}) as Record<string, unknown>;
  };
  return Object.assign(transport, { calls });
}

describe("planCreate", () => {
  it("requires a name", () => {
    expect(() => planCreate({}, [ADMIN])).toThrow(/requires --name/);
  });

  it("requires a role id and lists the assignable roles", () => {
    try {
      planCreate({ name: "bas" }, [ADMIN, MEMBER]);
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as AuthError).message;
      expect(message).toContain("requires --role-id");
      expect(message).toContain("Admin");
      expect(message).not.toContain("Member"); // Member is not assignable to an API key
    }
  });

  it("refuses a role that CATO cannot attach to an API key", () => {
    expect(() => planCreate({ name: "bas", roleId: MEMBER.id }, [ADMIN, MEMBER]))
      .toThrow(/canBeAssignedToApiKeys=false/);
  });

  it("refuses a role id that does not exist", () => {
    expect(() => planCreate({ name: "bas", roleId: "nope" }, [ADMIN])).toThrow(/does not exist/);
  });

  it("warns loudly when the chosen role can write", () => {
    const plan = planCreate({ name: "bas", roleId: ADMIN.id }, [ADMIN]);
    expect(plan.privilegeWarning).toContain("NOT read-only");
    expect(plan.privilegeWarning).toContain("WRITE-all");
  });

  it("does not warn for a genuinely read-only role", () => {
    const plan = planCreate({ name: "bas", roleId: READ_ONLY.id }, [READ_ONLY]);
    expect(plan.privilegeWarning).toBeNull();
  });

  it("defaults the expiry to 90 days out", () => {
    const now = new Date("2026-07-30T00:00:00.000Z");
    const plan = planCreate({ name: "bas", roleId: ADMIN.id }, [ADMIN], now);
    expect(plan.expiresAt).toBe("2026-10-28T00:00:00.000Z");
  });
});

describe("normalizeExpiry", () => {
  it("expands a bare date to midnight UTC", () => {
    expect(normalizeExpiry("2026-10-31")).toBe("2026-10-31T00:00:00.000Z");
  });
  it("rejects a date in the past", () => {
    expect(() => normalizeExpiry("2020-01-01T00:00:00Z")).toThrow(/in the past/);
  });
  it("rejects nonsense", () => {
    expect(() => normalizeExpiry("volgende week")).toThrow(/not a valid date/);
  });
  it("defaults 90 days ahead of the given clock", () => {
    expect(defaultExpiry(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("create/revoke against a mocked CATO", () => {
  it("issues exactly createApiKey then generateApiKeyToken", async () => {
    const transport = mockTransport({
      CreateApiKey: { createApiKey: { id: "key-1", name: "bas", expiresAt: "2026-10-31T00:00:00.000Z" } },
      GenerateApiKeyToken: { generateApiKeyToken: { token: "tok_abcdef1234567890" } },
    });
    const plan = planCreate({ name: "bas", roleId: ADMIN.id, expires: "2026-10-31" }, [ADMIN]);
    const created = await executeCreate(transport, plan);

    expect(transport.calls).toEqual(["CreateApiKey", "GenerateApiKeyToken"]);
    expect(created.token).toBe("tok_abcdef1234567890");
    expect(created.record.id).toBe("key-1");
  });

  it("shows the token once, with the never-again warning and the privilege warning", () => {
    const plan = planCreate({ name: "bas", roleId: ADMIN.id }, [ADMIN]);
    const text = renderCreatedKey(
      { record: { id: "key-1", name: "bas", expiresAt: "2026-10-31T00:00:00.000Z" }, token: "tok_secret" },
      plan,
    );
    expect(text).toContain("SHOWN ONCE");
    expect(text).toContain("CATO stores no copy of this token");
    expect(text).toContain("NOT read-only");
    expect(text).toContain("tok_secret");
  });

  it("a dry-run render never touches the transport", () => {
    const transport = mockTransport({});
    const plan = planCreate({ name: "bas", roleId: ADMIN.id }, [ADMIN]);
    const text = renderCreateDryRun(plan);
    expect(transport.calls).toEqual([]);
    expect(text).toContain("DRY RUN — no API key was created.");
    expect(text).toContain("--no-dry-run --yes");
  });

  it("revoke sends the RevokeApiKey mutation", async () => {
    const transport = mockTransport({
      RevokeApiKey: { revokeApiKey: { id: "key-1", name: "bas", expiresAt: "x", revokedAt: "2026-07-30T00:00:00.000Z" } },
    });
    const revoked = await executeRevoke(transport, "key-1");
    expect(transport.calls).toEqual(["RevokeApiKey"]);
    expect(revoked.revokedAt).toBe("2026-07-30T00:00:00.000Z");
  });
});

describe("renderRoles", () => {
  it("flags that every assignable role grants workspace-wide write", () => {
    const text = renderRoles([ADMIN, MEMBER]);
    expect(text).toContain("Every role that can be attached to an API key also grants workspace-wide WRITE");
  });

  it("points at the least-privilege role once one exists", () => {
    const text = renderRoles([ADMIN, TASK_WRITER]);
    expect(text).not.toContain("Every role that can be attached to an API key also grants");
    expect(text).toContain("Least-privilege option for a new key: 'Agent — lezen + taken'");
  });

  it("names the objects a scoped role can write instead of printing raw ids", () => {
    const names = new Map([["task-id", "task"], ["comment-id", "comment"]]);
    const text = renderRoles([TASK_WRITER], names);
    expect(text).toContain("read-all, write:task, write:comment");
    expect(text).not.toContain("task-id");
  });

  it("falls back to ids when the object names could not be fetched", () => {
    expect(renderRoles([TASK_WRITER])).toContain("write:task-id");
  });
});

describe("describeRolePower", () => {
  it("no longer calls a role with per-object grants 'scoped/none'", () => {
    // Regression: the Sales Rep role writes five objects and was rendered as
    // "scoped/none", i.e. the output claimed it could do nothing.
    const salesRep: Role = {
      ...READ_ONLY, id: "sales-rep", label: "Sales Rep", canReadAllObjectRecords: false,
      objectPermissions: [
        { objectMetadataId: "person-id", canReadObjectRecords: true, canUpdateObjectRecords: true, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
      ],
    };
    expect(describeRolePower(salesRep)).not.toBe("scoped/none");
    expect(describeRolePower(salesRep, new Map([["person-id", "person"]]))).toBe("write:person");
  });

  it("still says scoped/none for a role that really can do nothing", () => {
    expect(describeRolePower({ ...READ_ONLY, canReadAllObjectRecords: false })).toBe("scoped/none");
  });

  it("reports delete and destroy grants separately from write", () => {
    const destroyer: Role = {
      ...READ_ONLY,
      objectPermissions: [
        { objectMetadataId: "task-id", canReadObjectRecords: true, canUpdateObjectRecords: true, canSoftDeleteObjectRecords: true, canDestroyObjectRecords: true },
      ],
    };
    expect(describeRolePower(destroyer, new Map([["task-id", "task"]]))).toContain("write+delete+destroy:task");
  });
});

describe("writableObjects", () => {
  it("ignores a read-only per-object grant", () => {
    const readGrant: Role = {
      ...READ_ONLY,
      objectPermissions: [
        { objectMetadataId: "task-id", canReadObjectRecords: true, canUpdateObjectRecords: false, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
      ],
    };
    expect(writableObjects(readGrant)).toEqual([]);
  });
});

describe("isReadOnlyRole", () => {
  it("is false for anything that can write, delete or change settings", () => {
    expect(isReadOnlyRole(ADMIN)).toBe(false);
    expect(isReadOnlyRole({ ...READ_ONLY, canSoftDeleteAllObjectRecords: true })).toBe(false);
    expect(isReadOnlyRole({ ...READ_ONLY, canUpdateAllSettings: true })).toBe(false);
  });
  it("is true only for read-all + nothing else", () => {
    expect(isReadOnlyRole(READ_ONLY)).toBe(true);
  });
  it("is false for a role that writes through a per-object grant", () => {
    // Every workspace-wide flag on TASK_WRITER matches READ_ONLY, so this is
    // false only if the per-object grants are actually consulted.
    expect(isReadOnlyRole(TASK_WRITER)).toBe(false);
  });
  it("treats a missing objectPermissions field as no grants", () => {
    expect(isReadOnlyRole({ ...READ_ONLY, objectPermissions: undefined })).toBe(true);
    expect(isReadOnlyRole({ ...READ_ONLY, objectPermissions: null })).toBe(true);
  });
});

describe("applyProfile", () => {
  const empty: CredentialsFile = { version: 1, profiles: {} };

  it("refuses to store an empty profile", () => {
    expect(() => applyProfile(empty, { profileName: "bas" })).toThrow(/needs --api-key/);
  });

  it("stores a key under a named profile", () => {
    const file = applyProfile(empty, { profileName: "bas", apiKey: "tok" });
    expect(file.profiles.bas!.apiKey).toBe("tok");
    expect(file.defaultProfile).toBeUndefined();
  });

  it("merges into an existing profile without dropping the other secret", () => {
    const first = applyProfile(empty, { profileName: "bas", apiKey: "tok" });
    const second = applyProfile(first, { profileName: "bas", userToken: "usr" });
    expect(second.profiles.bas).toEqual({ apiKey: "tok", userToken: "usr" });
  });

  it("sets the default profile only when asked", () => {
    const file = applyProfile(empty, { profileName: "bas", apiKey: "tok", setDefault: true });
    expect(file.defaultProfile).toBe("bas");
  });
});

describe("credential precedence", () => {
  const file: CredentialsFile = {
    version: 1,
    defaultProfile: "default",
    profiles: {
      default: { apiKey: "from-default-profile" },
      bas: { apiKey: "from-bas-profile" },
    },
  };

  it("puts --profile above the environment", () => {
    const r = resolveCredentials({ profileFlag: "bas", env: { CATO_API_KEY: "from-env" }, file });
    expect(r.apiKey).toBe("from-bas-profile");
    expect(r.source).toBe("flag-profile");
  });

  it("puts the environment above the default profile", () => {
    const r = resolveCredentials({ env: { CATO_API_KEY: "from-env" }, file });
    expect(r.apiKey).toBe("from-env");
    expect(r.source).toBe("env");
  });

  it("falls back to the default profile", () => {
    const r = resolveCredentials({ env: {}, file });
    expect(r.apiKey).toBe("from-default-profile");
    expect(r.source).toBe("profile");
  });

  it("honours $CATO_PROFILE over the file's defaultProfile", () => {
    const r = resolveCredentials({ env: { CATO_PROFILE: "bas" }, file });
    expect(r.apiKey).toBe("from-bas-profile");
  });

  it("reports 'none' when nothing is configured", () => {
    const r = resolveCredentials({ env: {}, file: { version: 1, profiles: {} } });
    expect(r.source).toBe("none");
    expect(r.apiKey).toBeUndefined();
  });

  it("errors helpfully on an unknown --profile", () => {
    expect(() => resolveCredentials({ profileFlag: "nope", env: {}, file }))
      .toThrow(/Profile 'nope' not found/);
  });

  it("defaults the base URL to the production instance", () => {
    expect(resolveCredentials({ env: {}, file }).baseUrl).toBe("https://crm.prudai.com");
  });
});

describe("secret handling", () => {
  it("never returns the full secret from maskSecret", () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const masked = maskSecret(secret);
    expect(masked).not.toContain("payload");
    expect(masked).toContain("(len 38)");
  });

  it("masks a short secret entirely", () => {
    expect(maskSecret("short")).toBe("****");
  });

  it("decodes an API-key JWT without verifying it", () => {
    const payload = Buffer.from(JSON.stringify({ type: "API_KEY", workspaceId: "ws-1", exp: 4928550356 }))
      .toString("base64url");
    const claims = decodeTokenClaims(`header.${payload}.sig`)!;
    expect(claims.type).toBe("API_KEY");
    expect(claims.workspaceId).toBe("ws-1");
  });

  it("returns null for something that is not a JWT", () => {
    expect(decodeTokenClaims("not-a-token")).toBeNull();
  });
});

describe("buildStatus", () => {
  it("reports that marketing is unavailable with only an API key", () => {
    const status = buildStatus({
      apiKey: "eyJhbGciOiJIUzI1NiJ9.SECRETPAYLOAD.SIGNATUREVALUE",
      baseUrl: "https://crm.prudai.com",
      profileName: "default",
      source: "profile",
    });
    expect(status.marketingCapable).toBe(false);
    expect(status.apiKey).not.toContain("SECRETPAYLOAD");
  });

  it("reports marketing as available once a user token is present", () => {
    const status = buildStatus({
      apiKey: "a.b.c",
      userToken: "user-session-token-value",
      baseUrl: "https://crm.prudai.com",
      profileName: "default",
      source: "profile",
    });
    expect(status.marketingCapable).toBe(true);
  });
});
