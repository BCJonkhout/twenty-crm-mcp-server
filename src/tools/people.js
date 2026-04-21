import { buildListQuery } from "../rest.js";
import { transformPersonData } from "../transforms.js";
import { combineWithSoftDelete } from "../filter.js";
import { text, ok } from "./_render.js";

const LIST_DESCRIPTION = `List people with rich filtering, ordering, and cursor pagination.

Filter grammar (Twenty native, verified against v1.19):
  Operators:  [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
              [gt] [gte] [lt] [lte] [is]
  ⚠ [like] is CASE-SENSITIVE — use [ilike] for case-insensitive match.
  [nilike] is not supported; compose with or(...) or [neq] instead.
  Composition: and(clause1,clause2,...)  or  or(clause1,clause2,...)
  Composite fields are reached by dot-notation:
    name.firstName / name.lastName
    emails.primaryEmail
    phones.primaryPhoneNumber
    linkedinLink.primaryLinkUrl
    city (top-level string on person)
  PrudAI custom fields on person (prefix prudaiMarketing*):
    prudaiMarketingSourceSystem, prudaiMarketingSourceSegment,
    prudaiMarketingProductTarget, prudaiMarketingPlaybook,
    prudaiMarketingOutreachState, prudaiMarketingSignalScore,
    prudaiMarketingTrialState, prudaiMarketingSendgridCategory,
    prudaiMarketingLastTouchAt

Pagination: use starting_after / ending_before (cursor) with pageInfo.endCursor
returned in the response. Offset works but is slower at scale.

Soft-deleted records are excluded by default (deletedAt IS NULL).

Examples:
  • ALL architects (authoritative — 13956 in the PrudAI CRM):
      filter: prudaiMarketingSourceSystem[eq]:"architectenregister"
      limit: 200
  • Architects by job title (case-INsensitive, ~10841 matches):
      filter: jobTitle[ilike]:"%architect%"
      limit: 200
  • Architects in Twente (authoritative; 2-step: first fetch Twente company ids,
    then filter people by companyId[in]):
      Step 1 — list_companies with filter:
        address.addressCity[in]:["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"]
      Step 2 — list_people with filter:
        and(prudaiMarketingSourceSystem[eq]:"architectenregister",companyId[in]:[<id1>,<id2>,...])
    (Or use run_sql_readonly for a single-shot JOIN — see its description.)
  • Everyone at one company:
      filter: companyId[eq]:"<uuid>"
  • Added since April, newest first:
      filter: createdAt[gte]:"2026-04-01T00:00:00Z"
      order_by: createdAt[DescNullsFirst]
  • Two first-name alternatives via or():
      filter: or(name.firstName[eq]:"Beau",name.firstName[eq]:"Test")

When a filter returns 0 results — investigate before retrying with
variations. Common root causes, in order of likelihood:

  1. CASE: [like] is case-sensitive. Try [ilike] for substring match.
  2. EMPTY COLUMN: the value may live in a JSONB column, not the flat
     top-level field you filtered on. Twenty's REST filter grammar does
     NOT support dotted paths into JSONB — switch to run_sql_readonly.
  3. WRONG OBJECT: the attribute may live on a related object. E.g. a
     person's workplace city is on the linked company's address, not
     on person itself.

Discovering where a value actually lives:

  Step 1 — fetch one sample record with get_person / list_people and
  scan its JSON for any field whose value looks like an object or
  array. Those are JSONB. Typical PrudAI names: prudaiMarketingSource
  Context, prudaiMarketingSuppressionFlags, prudaiMarketingPhoneNumbers.

  Step 2 — enumerate the JSONB keys with run_sql_readonly:
    SELECT DISTINCT jsonb_object_keys("<jsonbColumn>") AS k
    FROM <table> WHERE "<jsonbColumn>" IS NOT NULL LIMIT 50;

  Step 3 — filter via ->> (text) or -> (object):
    SELECT id, "nameFirstName", "nameLastName",
           "<jsonbColumn>"->>'<key>' AS value
    FROM person
    WHERE ("<jsonbColumn>"->>'<key>') ILIKE '%searchterm%'
      AND "deletedAt" IS NULL
    LIMIT 100;

Skip straight to SQL when:
  • The field you need is an object/array (JSONB).
  • The query needs a JOIN (e.g. person + company.address).
  • You're doing a count/aggregate over thousands of rows.`;

export const definitions = [
  {
    name: "create_person",
    description: "Create a new person in Twenty CRM. firstName/lastName/email/phone/linkedinUrl are flat-input convenience wrappers that are transformed into Twenty's composite fields on send.",
    inputSchema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        jobTitle: { type: "string" },
        companyId: { type: "string" },
        linkedinUrl: { type: "string" },
        city: { type: "string" },
        avatarUrl: { type: "string" },
      },
      required: ["firstName", "lastName"],
    },
  },
  {
    name: "get_person",
    description: "Get a person by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "update_person",
    description: "Patch a person. Flat fields (firstName, email, phone, linkedinUrl) are re-wrapped into composite fields automatically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        jobTitle: { type: "string" },
        companyId: { type: "string" },
        linkedinUrl: { type: "string" },
        city: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_people",
    description: LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Twenty native filter expression (see Examples in description)." },
        order_by: { type: "string", description: "e.g. createdAt[DescNullsFirst], name.lastName[AscNullsLast]" },
        depth: { type: "number", description: "0 = flat, 1 = include direct relations, 2 = include nested relations" },
        limit: { type: "number", description: "Default 20. Max per-page ~200." },
        offset: { type: "number", description: "Prefer starting_after for large sets." },
        starting_after: { type: "string", description: "Cursor from a prior pageInfo.endCursor to fetch the next page." },
        ending_before: { type: "string", description: "Cursor to fetch the previous page." },
        search: { type: "string", description: "Full-text search (name/email). Combine with filter for best results." },
        companyId: { type: "string", description: "Shortcut — equivalent to filter: companyId[eq]:<id>." },
        include_deleted: { type: "boolean", description: "If true, soft-deleted rows are returned. Default false." },
      },
    },
  },
  {
    name: "delete_person",
    description: "Soft-delete a person (Twenty marks deletedAt; can be restored).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

export function createHandlers(client) {
  return {
    create_person: async (args) => {
      const body = transformPersonData(args);
      const result = await client.request("/rest/people", { method: "POST", body });
      return text("Created person:", result);
    },
    get_person: async ({ id }) => {
      const result = await client.request(`/rest/people/${id}`);
      return text("Person:", result);
    },
    update_person: async ({ id, ...rest }) => {
      const body = transformPersonData(rest);
      const result = await client.request(`/rest/people/${id}`, { method: "PATCH", body });
      return text("Updated person:", result);
    },
    list_people: async (args = {}) => {
      const {
        filter, order_by, depth, limit = 20, offset,
        starting_after, ending_before, search, companyId, include_deleted = false,
      } = args;

      const clauses = [];
      if (filter) clauses.push(filter);
      if (companyId) clauses.push(`companyId[eq]:"${companyId}"`);
      const combined = clauses.length === 0
        ? null
        : clauses.length === 1 ? clauses[0] : `and(${clauses.join(",")})`;
      const finalFilter = combineWithSoftDelete(combined, include_deleted);

      const qs = buildListQuery({
        filter: finalFilter,
        order_by,
        depth,
        limit,
        offset,
        after: starting_after,
        before: ending_before,
        search,
        include_deleted: true, // combineWithSoftDelete already applied
      });
      const result = await client.request(`/rest/people${qs}`);
      return text("People:", result);
    },
    delete_person: async ({ id }) => {
      await client.request(`/rest/people/${id}`, { method: "DELETE" });
      return ok(`Deleted person ${id}`);
    },
  };
}
