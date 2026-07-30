// Thin wrapper over POST {baseUrl}/graphql.
// The tool surfaces any GraphQL errors directly to the caller so Claude can
// iterate on the query.

import type { RestClient } from "./rest.ts";

export interface GraphQLRequestParams {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export async function graphqlRequest(
  client: RestClient,
  { query, variables = {}, operationName }: GraphQLRequestParams,
): Promise<unknown> {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const body: Record<string, unknown> = { query, variables };
  if (operationName) body.operationName = operationName;

  const result = await client.request("/graphql", { method: "POST", body });
  return result;
}
