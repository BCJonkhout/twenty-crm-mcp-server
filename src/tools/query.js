import { buildListQuery } from "../rest.js";
import { combineWithSoftDelete } from "../filter.js";
import { text } from "./_render.js";

const QUERY_DESCRIPTION = `Generic list for ANY Twenty object type — standard (people, companies, notes, tasks, noteTargets, taskTargets, opportunities, messageThreads, messages) and custom (e.g. at PrudAI the person/company records carry prudaiMarketing* fields). Use this when there is no dedicated list_* tool for the object type you need.

Uses the exact same filter grammar as list_people / list_companies.

⚠ [like] is case-sensitive. Use [ilike] for case-insensitive match.

Examples:
  • All opportunities in WON stage:
      objectType: "opportunities"
      filter: stage[eq]:"WON"
      order_by: closeDate[DescNullsFirst]
  • Pull every noteTarget for a company:
      objectType: "noteTargets"
      filter: targetCompanyId[eq]:"<uuid>"
      limit: 200
  • Paginate through architects in chunks of 200 (use endCursor from pageInfo):
      objectType: "people"
      filter: prudaiMarketingSourceSystem[eq]:"architectenregister"
      limit: 200
      starting_after: "<endCursor from previous page>"`;

const COUNT_DESCRIPTION = `Return the exact totalCount for an object type + filter.

Twenty REST returns totalCount on every list response, so this is a single cheap request — prefer it over calling list_* and counting rows.

⚠ [like] is case-sensitive. For "how many X" questions use [ilike] or the authoritative tag field (e.g. prudaiMarketingSourceSystem) — otherwise counts may dramatically under-represent.

Examples:
  • How many architects are in the CRM (authoritative tag, ≈13956):
      objectType: "people"
      filter: prudaiMarketingSourceSystem[eq]:"architectenregister"
  • Same via job title, case-INsensitive (≈10841):
      objectType: "people"
      filter: jobTitle[ilike]:"%architect%"
  • How many Twente-based companies:
      objectType: "companies"
      filter: address.addressCity[in]:["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"]`;

export const definitions = [
  {
    name: "query_records",
    description: QUERY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", description: "Plural REST name, e.g. 'people', 'companies', 'notes', 'opportunities'." },
        filter: { type: "string" },
        order_by: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        offset: { type: "number" },
        starting_after: { type: "string" },
        ending_before: { type: "string" },
        search: { type: "string" },
        include_deleted: { type: "boolean" },
      },
      required: ["objectType"],
    },
  },
  {
    name: "count_records",
    description: COUNT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        filter: { type: "string" },
        include_deleted: { type: "boolean" },
      },
      required: ["objectType"],
    },
  },
  {
    name: "get_metadata_objects",
    description: "Return all object types and their field schemas. Useful for discovering custom fields (e.g. PrudAI's prudaiMarketing* fields).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_object_metadata",
    description: "Return the schema for one object type. Accepts either a UUID or a name (e.g. 'note', 'person', 'noteTarget').",
    inputSchema: {
      type: "object",
      properties: { objectName: { type: "string" } },
      required: ["objectName"],
    },
  },
  {
    name: "search_records",
    description: "Full-text search across object types (uses the REST `search` param). Combine with query_records+filter for precision.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        objectTypes: { type: "array", items: { type: "string" }, description: "Default: ['people','companies']" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
];

export function createHandlers(client) {
  return {
    query_records: async (args = {}) => {
      const { objectType, filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, include_deleted = false } = args;
      if (!objectType) throw new Error("objectType is required");
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before, search,
        include_deleted: true,
      });
      const result = await client.request(`/rest/${objectType}${qs}`);
      return text(`${objectType}:`, result);
    },
    count_records: async ({ objectType, filter, include_deleted = false } = {}) => {
      if (!objectType) throw new Error("objectType is required");
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({ filter: finalFilter, limit: 1, include_deleted: true });
      const result = await client.request(`/rest/${objectType}${qs}`);
      return text(`count(${objectType}):`, {
        totalCount: result?.totalCount ?? null,
        filter: finalFilter,
      });
    },
    get_metadata_objects: async () => text("Metadata objects:", await client.request("/rest/metadata/objects")),
    get_object_metadata: async ({ objectName }) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectName);
      let objectId = objectName;
      if (!isUuid) {
        const allObjects = await client.request("/rest/metadata/objects");
        const objects = allObjects?.data?.objects ?? [];
        const match = objects.find((o) => o.nameSingular === objectName || o.namePlural === objectName);
        if (!match) {
          return text("", `No metadata object named "${objectName}". Available: ${objects.map((o) => o.nameSingular).join(", ")}`);
        }
        objectId = match.id;
      }
      return text(`Metadata for ${objectName}:`, await client.request(`/rest/metadata/objects/${objectId}`));
    },
    search_records: async ({ query, objectTypes = ["people", "companies"], limit = 10 }) => {
      const results = {};
      for (const objectType of objectTypes) {
        try {
          results[objectType] = await client.request(`/rest/${objectType}?search=${encodeURIComponent(query)}&limit=${limit}`);
        } catch (err) {
          results[objectType] = { error: err.message };
        }
      }
      return text(`Search "${query}":`, results);
    },
  };
}
