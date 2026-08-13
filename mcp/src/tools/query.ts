import { andExpr, buildListQuery, type RestClient, SEARCHABLE_FIELDS, searchExprForType, requireSearchExpr, combineWithSoftDelete } from "@twenty-crm/core";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

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

export const definitions: Tool[] = [
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
        search: { type: "string", description: "Case-insensitive substring match on the object's identifying fields. Errors for object types without a verified field set — see search_records." },
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
    description:
      "Substring search across object types. Matches case-insensitively on each object's identifying fields " +
      `(${Object.entries(SEARCHABLE_FIELDS).map(([o, f]) => `${o}: ${f.join("/")}`).join("; ")}). ` +
      "Object types not listed there return an error rather than unfiltered results. " +
      "Use query_records+filter for anything more precise.",
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

interface QueryRecordsArgs {
  objectType?: string;
  filter?: string;
  order_by?: string;
  depth?: number;
  limit?: number;
  offset?: number;
  starting_after?: string;
  ending_before?: string;
  search?: string;
  include_deleted?: boolean;
}

interface CountRecordsArgs {
  objectType?: string;
  filter?: string;
  include_deleted?: boolean;
}

interface MetadataObjectsResponse {
  data?: { objects?: Array<{ id: string; nameSingular: string; namePlural?: string }> };
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    query_records: async (args) => {
      const {
        objectType, filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, include_deleted = false,
      } = (args ?? {}) as QueryRecordsArgs;
      if (!objectType) throw new Error("objectType is required");
      // AND-ed into the filter. searchExpr throws for an object type with no
      // verified searchable fields — better a loud error than the old silent
      // behaviour, where the ignored `search=` returned the whole table.
      const withSearch = andExpr(filter ?? null, search ? searchExprForType(objectType, search) : null);
      const finalFilter = combineWithSoftDelete(withSearch, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before,
        include_deleted: true,
      });
      const result = await client.request(`/rest/${objectType}${qs}`);
      return text(`${objectType}:`, result);
    },
    count_records: async (args) => {
      const { objectType, filter, include_deleted = false } = (args ?? {}) as CountRecordsArgs;
      if (!objectType) throw new Error("objectType is required");
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({ filter: finalFilter, limit: 1, include_deleted: true });
      const result = await client.request<{ totalCount?: number }>(`/rest/${objectType}${qs}`);
      return text(`count(${objectType}):`, {
        totalCount: result?.totalCount ?? null,
        filter: finalFilter,
      });
    },
    get_metadata_objects: async () => text("Metadata objects:", await client.request("/rest/metadata/objects")),
    get_object_metadata: async (args) => {
      const { objectName } = args as { objectName: string };
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectName);
      let objectId: string = objectName;
      if (!isUuid) {
        const allObjects = await client.request<MetadataObjectsResponse>("/rest/metadata/objects");
        const objects = allObjects?.data?.objects ?? [];
        const match = objects.find((o) => o.nameSingular === objectName || o.namePlural === objectName);
        if (!match) {
          return text("", `No metadata object named "${objectName}". Available: ${objects.map((o) => o.nameSingular).join(", ")}`);
        }
        objectId = match.id;
      }
      return text(`Metadata for ${objectName}:`, await client.request(`/rest/metadata/objects/${objectId}`));
    },
    search_records: async (args) => {
      const { query, objectTypes = ["people", "companies"], limit = 10 } = args as {
        query: string; objectTypes?: string[]; limit?: number;
      };
      const results: Record<string, unknown> = {};
      for (const objectType of objectTypes) {
        try {
          // Was `?search=<query>`, which Twenty ignores — every object type
          // returned its first N records regardless of the query. This throws
          // both for an unsupported object type and for a blank term, so
          // neither can degrade into an unfiltered list dressed up as results.
          const expr = requireSearchExpr(objectType, query);
          const qs = buildListQuery({
            filter: combineWithSoftDelete(expr, false),
            limit,
            include_deleted: true,
          });
          results[objectType] = await client.request(`/rest/${objectType}${qs}`);
        } catch (err) {
          results[objectType] = { error: (err as Error).message };
        }
      }
      return text(`Search "${query}":`, results);
    },
  };
}
