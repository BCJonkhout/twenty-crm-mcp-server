import { buildListQuery, iterRecords, type RestClient } from "../rest.ts";
import { transformPersonData, transformCompanyData, type PersonInput, type CompanyInput } from "../transforms.ts";
import { combineWithSoftDelete } from "../filter.ts";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

const CONCURRENCY = 8;

interface PoolError {
  error: string;
}

type PoolResult<T> = T | PoolError;

async function parallelPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number = CONCURRENCY,
): Promise<Array<PoolResult<R>>> {
  const results = new Array<PoolResult<R>>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!, i);
      } catch (err) {
        results[i] = { error: (err as Error).message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

interface PersonRow { id: string; [k: string]: unknown }
interface CompanyRow { id: string; [k: string]: unknown }

interface PeopleListResponse { data?: { people?: PersonRow[] } }
interface CompaniesListResponse { data?: { companies?: CompanyRow[] } }

async function findPersonByEmail(client: RestClient, email: string | undefined): Promise<PersonRow | null> {
  if (!email) return null;
  const qs = buildListQuery({
    filter: `emails.primaryEmail[eq]:"${email.replace(/"/g, '\\"')}"`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request<PeopleListResponse>(`/rest/people${qs}`);
  return r?.data?.people?.[0] ?? null;
}

async function findPersonByNameAndCompany(
  client: RestClient,
  firstName: string | undefined,
  lastName: string | undefined,
  companyId: string | undefined,
): Promise<PersonRow | null> {
  if (!firstName || !lastName) return null;
  const clauses = [
    `name.firstName[eq]:"${firstName.replace(/"/g, '\\"')}"`,
    `name.lastName[eq]:"${lastName.replace(/"/g, '\\"')}"`,
  ];
  if (companyId) clauses.push(`companyId[eq]:"${companyId}"`);
  const qs = buildListQuery({
    filter: `and(${clauses.join(",")})`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request<PeopleListResponse>(`/rest/people${qs}`);
  return r?.data?.people?.[0] ?? null;
}

async function findCompanyByDomain(client: RestClient, domain: string | undefined): Promise<CompanyRow | null> {
  if (!domain) return null;
  const q = domain.replace(/^https?:\/\//, "").split("/")[0]!;
  const qs = buildListQuery({
    filter: `domainName.primaryLinkUrl[like]:"%${q.replace(/"/g, '\\"')}%"`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request<CompaniesListResponse>(`/rest/companies${qs}`);
  return r?.data?.companies?.[0] ?? null;
}

async function findCompanyByNameCity(client: RestClient, name: string | undefined, city: string | null | undefined): Promise<CompanyRow | null> {
  if (!name) return null;
  const clauses = [`name[eq]:"${name.replace(/"/g, '\\"')}"`];
  if (city) clauses.push(`address.addressCity[eq]:"${city.replace(/"/g, '\\"')}"`);
  const qs = buildListQuery({
    filter: clauses.length === 1 ? clauses[0]! : `and(${clauses.join(",")})`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request<CompaniesListResponse>(`/rest/companies${qs}`);
  return r?.data?.companies?.[0] ?? null;
}

export const definitions: Tool[] = [
  {
    name: "batch_upsert_people",
    description: `Upsert many people in parallel. Dedup order: (1) emails.primaryEmail, (2) firstName + lastName (+ companyId if given). Flat fields are auto-transformed (email → emails.primaryEmail, phone → phones.primaryPhoneNumber, etc.).

Returns { created: [ids], updated: [ids], errors: [{index, error}] }.

Example:
  people: [
    { firstName: "Alice", lastName: "Smith", email: "alice@example.com", jobTitle: "Architect", companyId: "<uuid>" },
    { firstName: "Bob", lastName: "Jones", email: "bob@example.com" }
  ]`,
    inputSchema: {
      type: "object",
      properties: {
        people: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Array of person records (same shape as create_person's input).",
        },
      },
      required: ["people"],
    },
  },
  {
    name: "batch_upsert_companies",
    description: `Upsert many companies in parallel. Dedup order: (1) domain substring, (2) name + address city, (3) name only.

Returns { created: [ids], updated: [ids], errors: [] }.

Example:
  companies: [
    { name: "Example BV", domainName: "example.nl", address: "Hoofdstraat 1" },
    { name: "Another Firm", domainName: "another.com" }
  ]`,
    inputSchema: {
      type: "object",
      properties: {
        companies: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Array of company records (same shape as create_company's input).",
        },
      },
      required: ["companies"],
    },
  },
  {
    name: "bulk_update_by_filter",
    description: `Patch every record matching a filter with the given patch object. Default dry-run returns the match count without writing.

Example — retag all architects to a new playbook:
  objectType: "people"
  filter: jobTitle[like]:"%architect%"
  patch: { prudaiMarketingPlaybook: "Architect outbound Q2" }
  dryRun: false

Example — assign every person at a given Company to its accountOwner (keeps RLS in sync after reassigning a Company):
  objectType: "people"
  filter: companyId[eq]:"<company-uuid>"
  patch: { assigneeId: "<new-owner-workspaceMember-uuid>" }

Example — bulk-assign a rep to every person at every Company they already own (does not touch already-assigned people):
  1. list_companies with filter: accountOwnerId[eq]:"<rep-wm-uuid>", collect ids into <companyIds>
  2. bulk_update_by_filter with
       objectType: "people"
       filter: and(companyId[in]:[<companyIds>],assigneeId[is]:NULL)
       patch: { assigneeId: "<rep-wm-uuid>" }
  Run with dryRun:true first to confirm the match count.`,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        filter: { type: "string" },
        patch: { type: "object", additionalProperties: true, description: "Field-level patch applied to every matching record." },
        dryRun: { type: "boolean", description: "Default true — returns match count only." },
        include_deleted: { type: "boolean" },
        max: { type: "number", description: "Hard cap on rows updated. Default 1000." },
      },
      required: ["objectType", "patch"],
    },
  },
];

interface UpsertResult {
  action: "created" | "updated";
  id: string | null;
  result?: unknown;
  note?: string;
}

interface BulkUpdateArgs {
  objectType?: string;
  filter?: string;
  patch?: Record<string, unknown>;
  dryRun?: boolean;
  include_deleted?: boolean;
  max?: number;
}

interface CreatePersonResponse {
  data?: { createPerson?: { id?: string }; id?: string };
}

interface CreateCompanyResponse {
  data?: { createCompany?: { id?: string }; id?: string };
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  // Twenty returns HTTP 400 "A duplicate entry was detected" when a unique
  // constraint is hit (e.g. primary email on person, domain on company).
  // With concurrent batch upserts this is a real race: two workers look
  // up "does this email exist?", both see no → both try POST → one 400s.
  // Catch that exact error, re-find the existing record, and PATCH it.
  const isDuplicateError = (err: unknown): boolean =>
    /duplicate entry was detected/i.test((err as Error)?.message ?? "");

  async function upsertPerson(input: PersonInput): Promise<UpsertResult> {
    const { firstName, lastName, email, companyId } = input as PersonInput & { companyId?: string };
    let existing: PersonRow | null = null;
    if (email) existing = await findPersonByEmail(client, email);
    if (!existing) existing = await findPersonByNameAndCompany(client, firstName, lastName, companyId);
    const body = transformPersonData(input);
    if (existing) {
      const updated = await client.request(`/rest/people/${existing.id}`, { method: "PATCH", body });
      return { action: "updated", id: existing.id, result: updated };
    }
    try {
      const created = await client.request<CreatePersonResponse>("/rest/people", { method: "POST", body });
      const id = created?.data?.createPerson?.id ?? created?.data?.id ?? null;
      return { action: "created", id, result: created };
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      // Race with another worker. Re-lookup and patch.
      let winner: PersonRow | null = null;
      if (email) winner = await findPersonByEmail(client, email);
      if (!winner) winner = await findPersonByNameAndCompany(client, firstName, lastName, companyId);
      if (!winner) throw err; // nothing to patch onto — surface original error
      const updated = await client.request(`/rest/people/${winner.id}`, { method: "PATCH", body });
      return { action: "updated", id: winner.id, result: updated, note: "duplicate-race recovered" };
    }
  }

  async function upsertCompany(input: CompanyInput): Promise<UpsertResult> {
    const { name, domainName, address } = input;
    const domainStr = typeof domainName === "string" ? domainName : undefined;
    const city = typeof address === "string" || !address ? null : (address as { addressCity?: string }).addressCity ?? null;
    let existing: CompanyRow | null = null;
    if (domainStr) existing = await findCompanyByDomain(client, domainStr);
    if (!existing && name) existing = await findCompanyByNameCity(client, name, city);
    const body = transformCompanyData(input);
    if (existing) {
      const updated = await client.request(`/rest/companies/${existing.id}`, { method: "PATCH", body });
      return { action: "updated", id: existing.id, result: updated };
    }
    try {
      const created = await client.request<CreateCompanyResponse>("/rest/companies", { method: "POST", body });
      const id = created?.data?.createCompany?.id ?? created?.data?.id ?? null;
      return { action: "created", id, result: created };
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      let winner: CompanyRow | null = null;
      if (domainStr) winner = await findCompanyByDomain(client, domainStr);
      if (!winner && name) winner = await findCompanyByNameCity(client, name, city);
      if (!winner) throw err;
      const updated = await client.request(`/rest/companies/${winner.id}`, { method: "PATCH", body });
      return { action: "updated", id: winner.id, result: updated, note: "duplicate-race recovered" };
    }
  }

  return {
    batch_upsert_people: async (args) => {
      const { people = [] } = args as { people?: PersonInput[] };
      if (!Array.isArray(people) || people.length === 0) throw new Error("people must be a non-empty array");
      const results = await parallelPool(people, upsertPerson);
      const created: Array<string | null> = [], updated: Array<string | null> = [], errors: Array<{ index: number; error: string }> = [];
      results.forEach((r, i) => {
        if (!r || (r as PoolError).error) errors.push({ index: i, error: (r as PoolError)?.error ?? "unknown error" });
        else if ((r as UpsertResult).action === "created") created.push((r as UpsertResult).id);
        else if ((r as UpsertResult).action === "updated") updated.push((r as UpsertResult).id);
      });
      return text("batch_upsert_people:", { created, updated, errors, total: people.length });
    },
    batch_upsert_companies: async (args) => {
      const { companies = [] } = args as { companies?: CompanyInput[] };
      if (!Array.isArray(companies) || companies.length === 0) throw new Error("companies must be a non-empty array");
      const results = await parallelPool(companies, upsertCompany);
      const created: Array<string | null> = [], updated: Array<string | null> = [], errors: Array<{ index: number; error: string }> = [];
      results.forEach((r, i) => {
        if (!r || (r as PoolError).error) errors.push({ index: i, error: (r as PoolError)?.error ?? "unknown error" });
        else if ((r as UpsertResult).action === "created") created.push((r as UpsertResult).id);
        else if ((r as UpsertResult).action === "updated") updated.push((r as UpsertResult).id);
      });
      return text("batch_upsert_companies:", { created, updated, errors, total: companies.length });
    },
    bulk_update_by_filter: async (args) => {
      const { objectType, filter, patch, dryRun = true, include_deleted = false, max = 1000 } = (args ?? {}) as BulkUpdateArgs;
      if (!objectType) throw new Error("objectType is required");
      if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);

      const matches: string[] = [];
      for await (const row of iterRecords(client, objectType, { filter: finalFilter, limit: 200, include_deleted: true })) {
        matches.push(row.id);
        if (matches.length >= max) break;
      }

      if (dryRun) {
        return text("bulk_update_by_filter (dryRun):", {
          objectType, filter: finalFilter, matchedCount: matches.length, truncated: matches.length >= max,
        });
      }

      const results = await parallelPool(matches, async (id) => {
        const updated = await client.request(`/rest/${objectType}/${id}`, { method: "PATCH", body: patch });
        return { id, ok: true, result: updated };
      });
      const updatedIds = results
        .filter((r): r is { id: string; ok: boolean; result: unknown } => Boolean(r && !(r as PoolError).error))
        .map((r) => r.id);
      const errors = results
        .map((r, i) => ((r as PoolError)?.error ? { id: matches[i]!, error: (r as PoolError).error } : null))
        .filter((e): e is { id: string; error: string } => Boolean(e));
      return text("bulk_update_by_filter:", {
        objectType, filter: finalFilter, matchedCount: matches.length, updatedCount: updatedIds.length, errors,
      });
    },
  };
}
