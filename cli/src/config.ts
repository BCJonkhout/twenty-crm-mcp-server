// Credential resolution for the `cato` CLI.
//
// Precedence (highest first) — this order is contractual, documented in the
// README and covered by tests:
//   1. --profile <name>            → that profile in the credentials file
//   2. $CATO_API_KEY               → env
//   3. default profile / $CATO_PROFILE in the credentials file
//   4. OpenBao (kv/prod/cato-cli/app), when $CATO_BAO_TOKEN is present
//
// Rationale for putting an explicit --profile above the env var: an operator
// who names a profile is being specific, and a stale exported CATO_API_KEY in
// the shell must not silently hijack it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://crm.prudai.com";

/**
 * Where the CLI's own credentials live in OpenBao. The convention in this
 * workspace is kv/prod/<service>/app (see /root/bin/bao-fetch). Provisioned
 * 2026-08-13 and holding CATO_API_KEY — set CATO_BAO_TOKEN and the CLI reads
 * it from here.
 * kv/prod/prudai-twenty/app is deliberately NOT reused: bao-fetch renders that
 * whole path into the Twenty server's .env, so a client key stored there would
 * be injected into the CRM container's environment.
 */
export const DEFAULT_BAO_PATH = "kv/prod/cato-cli/app";
export const DEFAULT_BAO_ADDR = "https://secrets.prudai.com";

export interface Profile {
  /** Twenty API key (a JWT with type=API_KEY). Grants whatever its role grants. */
  apiKey?: string;
  /**
   * A *user* session access token. Required for `cato marketing`: the marketing
   * module resolves permissions from a workspace member, and an API key has
   * none (marketing-access.service.ts: authContext.type !== 'user' → 'none').
   */
  userToken?: string;
  baseUrl?: string;
  /** Free-text note, e.g. who this profile belongs to and when it expires. */
  note?: string;
}

export interface CredentialsFile {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export type CredentialSource =
  | "flag-profile"
  | "env"
  | "profile"
  | "openbao"
  | "none";

export interface ResolvedCredentials {
  apiKey?: string;
  userToken?: string;
  baseUrl: string;
  profileName: string;
  source: CredentialSource;
}

export function credentialsPath(): string {
  const override = process.env.CATO_CREDENTIALS_FILE;
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "cato", "credentials.json");
}

export function readCredentials(path = credentialsPath()): CredentialsFile {
  if (!existsSync(path)) return { version: 1, profiles: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Credentials file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Credentials file ${path} must contain a JSON object.`);
  }
  const file = parsed as Partial<CredentialsFile>;
  return { version: 1, defaultProfile: file.defaultProfile, profiles: file.profiles ?? {} };
}

/** Writes 0600. The directory is created 0700 — a secret file in a 0755 dir is still a leak. */
export function writeCredentials(file: CredentialsFile, path = credentialsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface ResolveOptions {
  profileFlag?: string;
  baseUrlFlag?: string;
  env?: NodeJS.ProcessEnv;
  file?: CredentialsFile;
}

/** Pure resolution — no I/O when `file` and `env` are supplied. Unit-testable. */
export function resolveCredentials(opts: ResolveOptions = {}): ResolvedCredentials {
  const env = opts.env ?? process.env;
  const file = opts.file ?? readCredentials();
  const baseUrlFromFlag = opts.baseUrlFlag;

  const finish = (
    profileName: string,
    source: CredentialSource,
    profile: Profile,
  ): ResolvedCredentials => ({
    apiKey: profile.apiKey,
    userToken: profile.userToken,
    baseUrl: baseUrlFromFlag ?? profile.baseUrl ?? env.CATO_BASE_URL ?? DEFAULT_BASE_URL,
    profileName,
    source,
  });

  // 1. Explicit --profile wins outright.
  if (opts.profileFlag) {
    const profile = file.profiles[opts.profileFlag];
    if (!profile) {
      throw new Error(
        `Profile '${opts.profileFlag}' not found in ${credentialsPath()}. ` +
          `Known profiles: ${Object.keys(file.profiles).join(", ") || "(none)"}. ` +
          `Create one with: cato auth set --profile ${opts.profileFlag}`,
      );
    }
    return finish(opts.profileFlag, "flag-profile", profile);
  }

  // 2. Environment.
  if (env.CATO_API_KEY || env.CATO_USER_TOKEN) {
    return finish("(env)", "env", {
      apiKey: env.CATO_API_KEY,
      userToken: env.CATO_USER_TOKEN,
      baseUrl: env.CATO_BASE_URL,
    });
  }

  // 3. Default profile from the credentials file.
  const defaultName = env.CATO_PROFILE ?? file.defaultProfile ?? "default";
  const defaultProfile = file.profiles[defaultName];
  if (defaultProfile) return finish(defaultName, "profile", defaultProfile);

  // 4. Nothing local — the caller may still try OpenBao.
  return {
    baseUrl: baseUrlFromFlag ?? env.CATO_BASE_URL ?? DEFAULT_BASE_URL,
    profileName: defaultName,
    source: "none",
  };
}

export interface BaoOptions {
  addr?: string;
  path?: string;
  token?: string;
  key?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Read the API key from OpenBao (KV v2). Returns null when no token is
 * available — the CLI then reports the full precedence chain rather than
 * failing with a bare 403.
 */
export async function readKeyFromOpenBao(opts: BaoOptions = {}): Promise<string | null> {
  const token = opts.token ?? process.env.CATO_BAO_TOKEN ?? process.env.BAO_TOKEN ?? process.env.VAULT_TOKEN;
  if (!token) return null;

  const addr = opts.addr ?? process.env.CATO_BAO_ADDR ?? process.env.BAO_ADDR ?? DEFAULT_BAO_ADDR;
  const path = opts.path ?? process.env.CATO_BAO_PATH ?? DEFAULT_BAO_PATH;
  const key = opts.key ?? process.env.CATO_BAO_KEY ?? "CATO_API_KEY";
  const doFetch = opts.fetchImpl ?? fetch;

  // kv/prod/cato-cli/app -> kv/data/prod/cato-cli/app
  const [mount, ...rest] = path.split("/");
  const dataPath = `${mount}/data/${rest.join("/")}`;

  const res = await doFetch(`${addr.replace(/\/$/, "")}/v1/${dataPath}`, {
    headers: { "X-Vault-Token": token },
  });
  if (!res.ok) {
    throw new Error(`OpenBao read ${path} failed: HTTP ${res.status}. Check CATO_BAO_TOKEN and the policy on that path.`);
  }
  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data?.[key] ?? null;
}

/** Never print a key. This is what `auth status`/`auth list` may show instead. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 12) return "****";
  return `${secret.slice(0, 6)}…${secret.slice(-4)} (len ${secret.length})`;
}
