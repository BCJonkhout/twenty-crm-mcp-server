import { graphqlRequest } from "../graphql.js";
import { text } from "./_render.js";

const DESCRIPTION = `Run an arbitrary GraphQL query or mutation against Twenty's /graphql endpoint. Use this for things the REST API cannot express cleanly (connection-style pagination, aggregates, nested relation selection).

Examples:
  • Introspect the schema:
      query: "{ __schema { queryType { name } types { name kind } } }"
  • Fetch 5 people (note the capital 'P' on the singular type):
      query: "{ people(first: 5) { edges { node { id name { firstName lastName } emails { primaryEmail } } } } }"
  • Mutate (use with care):
      query: "mutation($id: UUID!, $data: PersonUpdateInput!) { updatePerson(id: $id, data: $data) { id } }"
      variables: { "id": "<uuid>", "data": { "jobTitle": "Senior Architect" } }`;

export const definitions = [
  {
    name: "graphql_query",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        variables: { type: "object", additionalProperties: true },
        operationName: { type: "string" },
      },
      required: ["query"],
    },
  },
];

export function createHandlers(client) {
  return {
    graphql_query: async ({ query, variables, operationName }) => {
      try {
        const result = await graphqlRequest(client, { query, variables, operationName });
        return text("GraphQL result:", result);
      } catch (err) {
        if (/HTTP 404/.test(err.message)) {
          throw new Error("GraphQL endpoint is not enabled on this Twenty instance (/graphql → 404).");
        }
        throw err;
      }
    },
  };
}
