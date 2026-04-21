import { buildListQuery } from "../rest.js";
import { transformBodyField, createTargetsForRecord, extractId } from "../transforms.js";
import { combineWithSoftDelete } from "../filter.js";
import { text, ok } from "./_render.js";

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

export const definitions = [
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

export function createHandlers(client) {
  return {
    create_note: async ({ targetPersonIds, targetCompanyIds, ...noteData }) => {
      const body = transformBodyField(noteData);
      const result = await client.request("/rest/notes", { method: "POST", body });
      const noteId = extractId(result);
      let targets = [];
      if (noteId && (targetPersonIds?.length || targetCompanyIds?.length)) {
        targets = await createTargetsForRecord(client, "note", noteId, targetPersonIds, targetCompanyIds);
      }
      return text("Created note:", { note: result, targets });
    },
    get_note: async ({ id }) => text("Note:", await client.request(`/rest/notes/${id}`)),
    list_notes: async (args = {}) => {
      const { filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, include_deleted = false } = args;
      const finalFilter = combineWithSoftDelete(filter ?? null, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before, search,
        include_deleted: true,
      });
      return text("Notes:", await client.request(`/rest/notes${qs}`));
    },
    update_note: async ({ id, ...rest }) => {
      const body = transformBodyField(rest);
      return text("Updated note:", await client.request(`/rest/notes/${id}`, { method: "PATCH", body }));
    },
    delete_note: async ({ id }) => {
      await client.request(`/rest/notes/${id}`, { method: "DELETE" });
      return ok(`Deleted note ${id}`);
    },
  };
}
