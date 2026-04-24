import { buildListQuery, type RestClient } from "../rest.ts";
import { transformBodyField, createTargetsForRecord, extractId, type BodyInput } from "../transforms.ts";
import { combineWithSoftDelete } from "../filter.ts";
import { text, ok } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

const LIST_DESCRIPTION = `List notes with filtering, ordering, cursor pagination.

Filter grammar:
  Operators:  [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
              [gt] [gte] [lt] [lte] [is]
  ⚠ [like] is CASE-SENSITIVE — use [ilike] for case-insensitive match.
  Fields: title, position, createdAt, updatedAt, createdBy.source

Examples:
  • Notes created this month:
      filter: createdAt[gte]:"2026-04-01"
      order_by: createdAt[DescNullsFirst]
  • Notes with "escalation" in the title (case-insensitive):
      filter: title[ilike]:"%escalation%"`;

export const definitions: Tool[] = [
  {
    name: "create_note",
    description: "Create a note. body is converted to bodyV2 (BlockNote + markdown). targetPersonIds / targetCompanyIds auto-create noteTarget links.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        position: { type: "number" },
        targetPersonIds: { type: "array", items: { type: "string" } },
        targetCompanyIds: { type: "array", items: { type: "string" } },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "get_note",
    description: "Get a note by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_notes",
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
    name: "update_note",
    description: "Patch a note.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        position: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_note",
    description: "Soft-delete a note.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

interface CreateNoteArgs extends BodyInput {
  targetPersonIds?: string[];
  targetCompanyIds?: string[];
}

interface ListNotesArgs {
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

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    create_note: async (args) => {
      const { targetPersonIds, targetCompanyIds, ...noteData } = args as CreateNoteArgs;
      const body = transformBodyField(noteData);
      const result = await client.request("/rest/notes", { method: "POST", body });
      const noteId = extractId(result);
      let targets: unknown[] = [];
      if (noteId && (targetPersonIds?.length || targetCompanyIds?.length)) {
        targets = await createTargetsForRecord(client, "note", noteId, targetPersonIds, targetCompanyIds);
      }
      return text("Created note:", { note: result, targets });
    },
    get_note: async (args) => {
      const { id } = args as { id: string };
      return text("Note:", await client.request(`/rest/notes/${id}`));
    },
    list_notes: async (args) => {
      const {
        filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, include_deleted = false,
      } = (args ?? {}) as ListNotesArgs;
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before, search,
        include_deleted: true,
      });
      return text("Notes:", await client.request(`/rest/notes${qs}`));
    },
    update_note: async (args) => {
      const { id, ...rest } = args as { id: string } & BodyInput;
      const body = transformBodyField(rest);
      return text("Updated note:", await client.request(`/rest/notes/${id}`, { method: "PATCH", body }));
    },
    delete_note: async (args) => {
      const { id } = args as { id: string };
      await client.request(`/rest/notes/${id}`, { method: "DELETE" });
      return ok(`Deleted note ${id}`);
    },
  };
}
