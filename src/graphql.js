// Thin wrapper over POST {baseUrl}/graphql.
// The tool surfaces any GraphQL errors directly to the caller so Claude can
// iterate on the query.

export async function graphqlRequest(client, { query, variables = {}, operationName }) {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const body = { query, variables };
  if (operationName) body.operationName = operationName;

  const result = await client.request("/graphql", { method: "POST", body });
  return result;
}
