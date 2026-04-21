import { buildListQuery } from "../rest.js";
import { transformCompanyData } from "../transforms.js";
import { combineWithSoftDelete } from "../filter.js";
import { text, ok } from "./_render.js";

const LIST_DESCRIPTION = `List companies with rich filtering, ordering, and cursor pagination.

Filter grammar (same as list_people):
  Operators:  [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
              [gt] [gte] [lt] [lte] [is]
  ⚠ [like] is CASE-SENSITIVE — use [ilike] for case-insensitive match.
  Composition: and(...), or(...)
  Composite fields:
    address.addressCity, address.addressPostcode, address.addressCountry, address.addressState
    domainName.primaryLinkUrl, domainName.primaryLinkLabel
    linkedinLink.primaryLinkUrl, xLink.primaryLinkUrl
    annualRecurringRevenue.amountMicros
  PrudAI custom fields on company (prudaiMarketing*):
    prudaiMarketingSourceSystem, prudaiMarketingSourceSegment,
    prudaiMarketingSourceContext, prudaiMarketingProductInterestSummary,
    isEnriched

Examples:
  • Companies in Twente (12 municipalities):
      filter: address.addressCity[in]:["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"]
      limit: 200
  • Architect firms in Twente (prudaiMarketingSourceSystem is the authoritative tag):
      filter: and(prudaiMarketingSourceSystem[eq]:"architectenregister",address.addressCity[in]:["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"])
      limit: 200
  • By domain substring (case-insensitive):
      filter: domainName.primaryLinkUrl[ilike]:"%prudai.com%"
  • City starts with "En":
      filter: address.addressCity[startsWith]:"En"
  • Recently updated ICPs:
      filter: and(idealCustomerProfile[eq]:true,updatedAt[gte]:"2026-04-01")
      order_by: updatedAt[DescNullsFirst]`;

export const definitions = [
  {
    name: "create_company",
    description: "Create a company. domainName/address/linkedinUrl/xUrl/annualRecurringRevenue are flat-input wrappers transformed to composites.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        domainName: { type: "string" },
        address: { type: "string" },
        employees: { type: "number" },
        linkedinUrl: { type: "string" },
        xUrl: { type: "string" },
        annualRecurringRevenue: { type: "number" },
        idealCustomerProfile: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_company",
    description: "Get a company by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "update_company",
    description: "Patch a company.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        domainName: { type: "string" },
        address: { type: "string" },
        employees: { type: "number" },
        linkedinUrl: { type: "string" },
        annualRecurringRevenue: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_companies",
    description: LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
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
    },
  },
  {
    name: "delete_company",
    description: "Soft-delete a company.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

export function createHandlers(client) {
  return {
    create_company: async (args) => {
      const body = transformCompanyData(args);
      const result = await client.request("/rest/companies", { method: "POST", body });
      return text("Created company:", result);
    },
    get_company: async ({ id }) => {
      const result = await client.request(`/rest/companies/${id}`);
      return text("Company:", result);
    },
    update_company: async ({ id, ...rest }) => {
      const body = transformCompanyData(rest);
      const result = await client.request(`/rest/companies/${id}`, { method: "PATCH", body });
      return text("Updated company:", result);
    },
    list_companies: async (args = {}) => {
      const { filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, include_deleted = false } = args;
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before, search,
        include_deleted: true,
      });
      const result = await client.request(`/rest/companies${qs}`);
      return text("Companies:", result);
    },
    delete_company: async ({ id }) => {
      await client.request(`/rest/companies/${id}`, { method: "DELETE" });
      return ok(`Deleted company ${id}`);
    },
  };
}
