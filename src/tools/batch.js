import { buildListQuery, iterRecords } from "../rest.js";
import { transformPersonData, transformCompanyData } from "../transforms.js";
import { combineWithSoftDelete } from "../filter.js";
import { text } from "./_render.js";

const CONCURRENCY = 8;

async function parallelPool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function findPersonByEmail(client, email) {
  if (!email) return null;
  const qs = buildListQuery({
    filter: `emails.primaryEmail[eq]:"${email.replace(/"/g, '\\"')}"`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request(`/rest/people${qs}`);
  return r?.data?.people?.[0] ?? null;
}

async function findPersonByNameAndCompany(client, firstName, lastName, companyId) {
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
  const r = await client.request(`/rest/people${qs}`);
  return r?.data?.people?.[0] ?? null;
}

async function findCompanyByDomain(client, domain) {
  if (!domain) return null;
  const q = domain.replace(/^https?:\/\//, "").split("/")[0];
  const qs = buildListQuery({
    filter: `domainName.primaryLinkUrl[like]:"%${q.replace(/"/g, '\\"')}%"`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request(`/rest/companies${qs}`);
  return r?.data?.companies?.[0] ?? null;
}

async function findCompanyByNameCity(client, name, city) {
  if (!name) return null;
  const clauses = [`name[eq]:"${name.replace(/"/g, '\\"')}"`];
  if (city) clauses.push(`address.addressCity[eq]:"${city.replace(/"/g, '\\"')}"`);
  const qs = buildListQuery({
    filter: clauses.length === 1 ? clauses[0] : `and(${clauses.join(",")})`,
    limit: 1,
    include_deleted: true,
  });
  const r = await client.request(`/rest/companies${qs}`);
  return r?.data?.companies?.[0] ?? null;
}

export const definitions = [
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

export function createHandlers(client) {
  // Twenty returns HTTP 400 "A duplicate entry was detected" when a unique
  // constraint is hit (e.g. primary email on person, domain on company).
  // With concurrent batch upserts this is a real race: two workers look
  // up "does this email exist?", both see no → both try POST → one 400s.
  // Catch that exact error, re-find the existing record, and PATCH it.
  const isDuplicateError = (err) =>
    /duplicate entry was detected/i.test(err?.message ?? "");

  async function upsertPerson(input) {
    const { firstName, lastName, email, companyId } = input;
    let existing = null;
    if (email) existing = await findPersonByEmail(client, email);
    if (!existing) existing = await findPersonByNameAndCompany(client, firstName, lastName, companyId);
    const body = transformPersonData(input);
    if (existing) {
      const updated = await client.request(`/rest/people/${existing.id}`, { method: "PATCH", body });
      return { action: "updated", id: existing.id, result: updated };
    }
    try {
      const created = await client.request("/rest/people", { method: "POST", body });
      const id = created?.data?.createPerson?.id ?? created?.data?.id ?? null;
      return { action: "created", id, result: created };
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      // Race with another worker. Re-lookup and patch.
      let winner = null;
      if (email) winner = await findPersonByEmail(client, email);
      if (!winner) winner = await findPersonByNameAndCompany(client, firstName, lastName, companyId);
      if (!winner) throw err; // nothing to patch onto — surface original error
      const updated = await client.request(`/rest/people/${winner.id}`, { method: "PATCH", body });
      return { action: "updated", id: winner.id, result: updated, note: "duplicate-race recovered" };
    }
  }

  async function upsertCompany(input) {
    const { name, domainName, address } = input;
    const city = typeof address === "string" ? null : address?.addressCity;
    let existing = null;
    if (domainName) existing = await findCompanyByDomain(client, domainName);
    if (!existing && name) existing = await findCompanyByNameCity(client, name, city);
    const body = transformCompanyData(input);
    if (existing) {
      const updated = await client.request(`/rest/companies/${existing.id}`, { method: "PATCH", body });
      return { action: "updated", id: existing.id, result: updated };
    }
    try {
      const created = await client.request("/rest/companies", { method: "POST", body });
      const id = created?.data?.createCompany?.id ?? created?.data?.id ?? null;
      return { action: "created", id, result: created };
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      let winner = null;
      if (domainName) winner = await findCompanyByDomain(client, domainName);
      if (!winner && name) winner = await findCompanyByNameCity(client, name, city);
      if (!winner) throw err;
      const updated = await client.request(`/rest/companies/${winner.id}`, { method: "PATCH", body });
      return { action: "updated", id: winner.id, result: updated, note: "duplicate-race recovered" };
    }
  }

  return {
    batch_upsert_people: async ({ people = [] }) => {
      if (!Array.isArray(people) || people.length === 0) throw new Error("people must be a non-empty array");
      const results = await parallelPool(people, upsertPerson);
      const created = [], updated = [], errors = [];
      results.forEach((r, i) => {
        if (!r || r.error) errors.push({ index: i, error: r?.error ?? "unknown error" });
        else if (r.action === "created") created.push(r.id);
        else if (r.action === "updated") updated.push(r.id);
      });
      return text("batch_upsert_people:", { created, updated, errors, total: people.length });
    },
    batch_upsert_companies: async ({ companies = [] }) => {
      if (!Array.isArray(companies) || companies.length === 0) throw new Error("companies must be a non-empty array");
      const results = await parallelPool(companies, upsertCompany);
      const created = [], updated = [], errors = [];
      results.forEach((r, i) => {
        if (!r || r.error) errors.push({ index: i, error: r?.error ?? "unknown error" });
        else if (r.action === "created") created.push(r.id);
        else if (r.action === "updated") updated.push(r.id);
      });
      return text("batch_upsert_companies:", { created, updated, errors, total: companies.length });
    },
    bulk_update_by_filter: async ({ objectType, filter, patch, dryRun = true, include_deleted = false, max = 1000 }) => {
      if (!objectType) throw new Error("objectType is required");
      if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);

      const matches = [];
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
      const updated = results.filter((r) => r && !r.error).map((r) => r.id);
      const errors = results.map((r, i) => (r?.error ? { id: matches[i], error: r.error } : null)).filter(Boolean);
      return text("bulk_update_by_filter:", {
        objectType, filter: finalFilter, matchedCount: matches.length, updatedCount: updated.length, errors,
      });
    },
  };
}
