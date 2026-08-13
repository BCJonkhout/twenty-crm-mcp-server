// @twenty-crm/core — shared Twenty CRM client kernel.
//
// This is the single API/filter/SQL layer reused by every entrypoint in this
// monorepo (the MCP server in `mcp/`, the `cato` CLI in `cli/`). Nothing in
// here knows about MCP or about terminal output — keep it that way.

export {
  createRestClient,
  buildListQuery,
  iterRecords,
  type RestClient,
  type RestClientOptions,
  type RequestOptions,
  type ListQueryParams,
  type TwentyRecord,
} from "./rest.ts";

export {
  escapeFilterValue,
  clause,
  andExpr,
  orExpr,
  combineWithSoftDelete,
  searchExpr,
  searchExprForType,
  requireSearchExpr,
  isSearchableObject,
  SEARCHABLE_FIELDS,
  UnsearchableObjectError,
  type SearchableObject,
  type FilterValue,
} from "./filter.ts";

export { graphqlRequest } from "./graphql.ts";

export { runReadonlySql, buildWrappedSql, psqlDefaults } from "./psql.ts";

export {
  transformPersonData,
  transformCompanyData,
  transformBodyField,
  createTargetsForRecord,
  extractId,
  type PersonInput,
  type CompanyInput,
  type BodyInput,
} from "./transforms.ts";
