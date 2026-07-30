#!/usr/bin/env bun
// Generate cli/openapi/cato.yaml from the LIVE CATO OpenAPI document.
//
// Twenty already publishes a complete OpenAPI 3.1 document at
// GET {baseUrl}/rest/open-api/core (~700 kB, 242 paths, every object in the
// workspace including custom marketing tables). Hand-writing a spec against
// that would guarantee drift, so this script *narrows* the live document
// instead of re-describing it:
//
//   * keep only the four objects we want to expose to an external consumer
//     (people, companies, opportunities, notes);
//   * keep only GET operations — the resulting contract is read-only by
//     construction, not by convention;
//   * carry the transitive closure of every referenced component so the file
//     stays self-contained;
//   * drop batch/merge/duplicates/groupBy routes and every other object.
//
// Usage:
//   CATO_API_KEY=... bun run cli/scripts/generate-openapi.ts
//   CATO_API_KEY=... bun run cli/scripts/generate-openapi.ts --out other.yaml

import { DEFAULT_BASE_URL } from "../src/config.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const EXPOSED_OBJECTS = ["people", "companies", "opportunities", "notes"] as const;

/** Paths we keep, in output order. Everything else is dropped. */
function keptPaths(): string[] {
  return EXPOSED_OBJECTS.flatMap((o) => [`/${o}`, `/${o}/{id}`]);
}

const OVERVIEW = `Read-only view of PrudAI's Twenty CRM instance ("CATO").

This document is GENERATED from the live CATO OpenAPI document
(GET /rest/open-api/core) by cli/scripts/generate-openapi.ts. Field names,
enum values and composite shapes are therefore the real ones, not a copy that
drifts.

WHAT IS IN HERE
  people, companies, opportunities, notes — list + get, GET only.

WHAT IS DELIBERATELY LEFT OUT
  * every write verb (POST/PATCH/PUT/DELETE) on every object;
  * the /batch/*, /merge, /duplicates and /groupBy routes;
  * every other object in the workspace, including messages,
    messageParticipants, connectedAccounts, calendarEvents and the 13 custom
    marketing* tables — those carry e-mail content, mailbox metadata and
    campaign state that an external reader has no reason to see;
  * the metadata API (/rest/metadata/*) and the GraphQL endpoints;
  * the custom /rest/marketing/* controller (~47 routes).

AUTHENTICATION
  Bearer token in the Authorization header. The token is a Twenty API key.

  IMPORTANT — read this before issuing a key. In this Twenty build every API
  key must carry a role, and a role is only attachable to an API key when
  canBeAssignedToApiKeys is true. Today the ONLY such role in this workspace is
  Admin, which grants read, write, delete and all settings. This document
  describes a read-only surface, but the credential handed to a caller is not
  itself read-only until a dedicated read-only role is created and used.
  Verify with: cato auth roles`;

interface OpenApiDoc {
  openapi: string;
  info: Record<string, Json>;
  servers?: Json;
  paths: Record<string, Record<string, Json>>;
  components?: {
    schemas?: Record<string, Json>;
    parameters?: Record<string, Json>;
    responses?: Record<string, Json>;
    securitySchemes?: Record<string, Json>;
  };
  security?: Json;
  tags?: Json;
}

async function fetchLiveSpec(baseUrl: string, apiKey: string): Promise<OpenApiDoc> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/open-api/core`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch the live CATO OpenAPI document: HTTP ${res.status}`);
  }
  return (await res.json()) as OpenApiDoc;
}

/** Collect every "#/components/<kind>/<name>" reference reachable from `node`. */
function collectRefs(node: Json, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/")) {
      out.add(value);
    } else {
      collectRefs(value, out);
    }
  }
}

function resolveRef(doc: OpenApiDoc, ref: string): Json | undefined {
  const [, , kind, name] = ref.split("/");
  if (kind === "schemas") return doc.components?.schemas?.[name!];
  if (kind === "parameters") return doc.components?.parameters?.[name!];
  if (kind === "responses") return doc.components?.responses?.[name!];
  if (kind === "securitySchemes") return doc.components?.securitySchemes?.[name!];
  return undefined;
}

export function narrowSpec(live: OpenApiDoc, baseUrl: string): OpenApiDoc {
  const paths: Record<string, Record<string, Json>> = {};

  for (const path of keptPaths()) {
    const original = live.paths[path];
    if (!original) continue;
    const kept: Record<string, Json> = {};
    for (const [method, operation] of Object.entries(original)) {
      // Read-only by construction: only GET survives.
      if (method.toLowerCase() !== "get") continue;
      kept[method] = operation;
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }

  if (Object.keys(paths).length === 0) {
    throw new Error("Narrowing produced no paths — the live document layout changed. Inspect it before shipping.");
  }

  // Transitive $ref closure, so the generated file resolves standalone.
  const refs = new Set<string>();
  collectRefs(paths as unknown as Json, refs);
  let frontier = [...refs];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const ref of frontier) {
      const target = resolveRef(live, ref);
      if (target === undefined) continue;
      const found = new Set<string>();
      collectRefs(target, found);
      for (const f of found) {
        if (!refs.has(f)) { refs.add(f); next.push(f); }
      }
    }
    frontier = next;
  }

  const schemas: Record<string, Json> = {};
  const parameters: Record<string, Json> = {};
  const responses: Record<string, Json> = {};
  for (const ref of [...refs].sort()) {
    const [, , kind, name] = ref.split("/");
    const target = resolveRef(live, ref);
    if (target === undefined) {
      throw new Error(`Referenced component ${ref} is missing from the live document — refusing to emit a spec with a dangling $ref.`);
    }
    if (kind === "schemas") schemas[name!] = target;
    else if (kind === "parameters") parameters[name!] = target;
    else if (kind === "responses") responses[name!] = target;
  }

  return {
    openapi: live.openapi ?? "3.1.1",
    info: {
      title: "CATO — PrudAI CRM (read-only)",
      version: String(live.info?.version ?? "1.0.0"),
      description: OVERVIEW,
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, "")}/rest/`, description: "CATO production (read-only surface)" }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Twenty API key. See `cato auth roles` for what a key can actually do.",
        },
      },
      parameters,
      responses,
      schemas,
    },
  };
}

// ---- minimal deterministic YAML emitter -----------------------------------
// Avoids a dependency for a job that is JSON-in, YAML-out.

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/ ]*$/;

/** Literal block scalar, keeping the string's own relative indentation intact. */
function yamlBlock(value: string, indent: number): string {
  const pad = "  ".repeat(indent);
  const body = value.split("\n").map((l) => (l ? `${pad}${l}` : "")).join("\n");
  return `|-\n${body}`;
}

function yamlScalar(value: null | boolean | number | string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === "") return '""';
  const reserved = ["true", "false", "null", "yes", "no", "on", "off", "~"];
  if (PLAIN_SAFE.test(value) && !reserved.includes(value.toLowerCase()) && !/^\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function yamlKey(key: string): string {
  // Numeric-looking keys must stay strings: an HTTP status key emitted bare
  // parses as the integer 400, and `$ref: '#/components/responses/400'` then
  // dangles against a document whose key is a number.
  if (/^\d+$/.test(key)) return JSON.stringify(key);
  return PLAIN_SAFE.test(key) ? key : JSON.stringify(key);
}

export function toYaml(node: Json, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (node === null || typeof node !== "object") {
    if (typeof node === "string" && node.includes("\n")) return yamlBlock(node, indent);
    return yamlScalar(node);
  }

  if (Array.isArray(node)) {
    if (node.length === 0) return "[]";
    return node
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const rendered = toYaml(item, indent + 1);
          return `${pad}- ${rendered.slice((indent + 1) * 2)}`;
        }
        if (typeof item === "string" && item.includes("\n")) {
          return `${pad}- ${yamlBlock(item, indent + 1)}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }

  const entries = Object.entries(node);
  if (entries.length === 0) return "{}";
  return entries
    .map(([key, value]) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
        return `${pad}${yamlKey(key)}: {}`;
      }
      if (Array.isArray(value) && value.length === 0) {
        return `${pad}${yamlKey(key)}: []`;
      }
      if (value !== null && typeof value === "object") {
        return `${pad}${yamlKey(key)}:\n${toYaml(value, indent + 1)}`;
      }
      if (typeof value === "string" && value.includes("\n")) {
        return `${pad}${yamlKey(key)}: ${yamlBlock(value, indent + 1)}`;
      }
      return `${pad}${yamlKey(key)}: ${yamlScalar(value)}`;
    })
    .join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex === -1 ? new URL("../openapi/cato.yaml", import.meta.url).pathname : args[outIndex + 1]!;

  const apiKey = process.env.CATO_API_KEY;
  if (!apiKey) {
    console.error("CATO_API_KEY is required to read the live OpenAPI document from CATO.");
    process.exit(2);
  }
  const baseUrl = process.env.CATO_BASE_URL ?? DEFAULT_BASE_URL;

  const live = await fetchLiveSpec(baseUrl, apiKey);
  const narrowed = narrowSpec(live, baseUrl);
  const header = [
    "# GENERATED FILE — do not edit by hand.",
    "# Source : GET " + baseUrl.replace(/\/$/, "") + "/rest/open-api/core (live CATO instance)",
    "# Script : bun run cli/scripts/generate-openapi.ts",
    "# Regenerate after any CRM schema change; do not patch this file directly.",
    "",
  ].join("\n");

  await Bun.write(outPath, `${header}${toYaml(narrowed as unknown as Json)}\n`);
  const pathCount = Object.keys(narrowed.paths).length;
  const schemaCount = Object.keys(narrowed.components?.schemas ?? {}).length;
  console.log(`Wrote ${outPath}: ${pathCount} paths, ${schemaCount} schemas (from ${Object.keys(live.paths).length} live paths).`);
}
