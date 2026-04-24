import { graphqlRequest } from "../graphql.ts";
import type { RestClient } from "../rest.ts";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

const DESCRIPTION = `Run an arbitrary GraphQL query or mutation against Twenty's /graphql endpoint. Use this for things the REST API cannot express cleanly (connection-style pagination, aggregates, nested relation selection).

Examples:
  • Introspect the schema:
      query: "{ __schema { queryType { name } types { name kind } } }"
  • Fetch 5 people (note the capital 'P' on the singular type):
      query: "{ people(first: 5) { edges { node { id name { firstName lastName } emails { primaryEmail } } } } }"
  • Mutate (use with care):
      query: "mutation($id: UUID!, $data: PersonUpdateInput!) { updatePerson(id: $id, data: $data) { id } }"
      variables: { "id": "<uuid>", "data": { "jobTitle": "Senior Architect" } }`;

export const definitions: Tool[] = [
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

interface GraphQLArgs {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    graphql_query: async (args) => {
      const { query, variables, operationName } = args as unknown as GraphQLArgs;
      try {
        const result = await graphqlRequest(client, { query, variables, operationName });
        return text("GraphQL result:", result);
      } catch (err) {
        const e = err as Error;
        if (/HTTP 404/.test(e.message)) {
          throw new Error("GraphQL endpoint is not enabled on this Twenty instance (/graphql → 404).");
        }
        throw err;
      }
    },
  };
}
