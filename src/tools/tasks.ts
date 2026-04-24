import { buildListQuery, type RestClient } from "../rest.ts";
import { transformBodyField, createTargetsForRecord, extractId, type BodyInput } from "../transforms.ts";
import { combineWithSoftDelete } from "../filter.ts";
import { text, ok } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

const LIST_DESCRIPTION = `List tasks with filtering, ordering, cursor pagination.

Filter grammar:
  Operators:  [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
              [gt] [gte] [lt] [lte] [is]
  ⚠ [like] is CASE-SENSITIVE — use [ilike] for case-insensitive match.
  Fields: title, status (TODO|IN_PROGRESS|DONE), dueAt, assigneeId, createdAt

Examples:
  • Open tasks due this week, newest first:
      filter: and(status[in]:["TODO","IN_PROGRESS"],dueAt[lt]:"2026-04-27T00:00:00Z")
      order_by: dueAt[AscNullsLast]
  • My assigned tasks:
      filter: assigneeId[eq]:"<workspaceMemberId>"`;

export const definitions: Tool[] = [
  {
    name: "create_task",
    description: "Create a task. body is converted to bodyV2. targetPersonIds / targetCompanyIds auto-create taskTarget links.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        dueAt: { type: "string", description: "ISO 8601" },
        status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE"] },
        assigneeId: { type: "string" },
        position: { type: "number" },
        targetPersonIds: { type: "array", items: { type: "string" } },
        targetCompanyIds: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "get_task",
    description: "Get a task by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_tasks",
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
        status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE"], description: "Shortcut: equivalent to filter: status[eq]:<value>." },
        assigneeId: { type: "string", description: "Shortcut: equivalent to filter: assigneeId[eq]:<id>." },
        include_deleted: { type: "boolean" },
      },
    },
  },
  {
    name: "update_task",
    description: "Patch a task.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        dueAt: { type: "string" },
        status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE"] },
        assigneeId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Soft-delete a task.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

interface CreateTaskArgs extends BodyInput {
  targetPersonIds?: string[];
  targetCompanyIds?: string[];
}

interface ListTasksArgs {
  filter?: string;
  order_by?: string;
  depth?: number;
  limit?: number;
  offset?: number;
  starting_after?: string;
  ending_before?: string;
  search?: string;
  status?: string;
  assigneeId?: string;
  include_deleted?: boolean;
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    create_task: async (args) => {
      const { targetPersonIds, targetCompanyIds, ...taskData } = args as CreateTaskArgs;
      const body = transformBodyField(taskData);
      const result = await client.request("/rest/tasks", { method: "POST", body });
      const taskId = extractId(result);
      let targets: unknown[] = [];
      if (taskId && (targetPersonIds?.length || targetCompanyIds?.length)) {
        targets = await createTargetsForRecord(client, "task", taskId, targetPersonIds, targetCompanyIds);
      }
      return text("Created task:", { task: result, targets });
    },
    get_task: async (args) => {
      const { id } = args as { id: string };
      return text("Task:", await client.request(`/rest/tasks/${id}`));
    },
    list_tasks: async (args) => {
      const {
        filter, order_by, depth, limit = 20, offset, starting_after, ending_before, search, status, assigneeId, include_deleted = false,
      } = (args ?? {}) as ListTasksArgs;
      const clauses: string[] = [];
      if (filter) clauses.push(filter);
      if (status) clauses.push(`status[eq]:"${status}"`);
      if (assigneeId) clauses.push(`assigneeId[eq]:"${assigneeId}"`);
      const combined = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0]! : `and(${clauses.join(",")})`;
      const finalFilter = combineWithSoftDelete(combined, include_deleted);
      const qs = buildListQuery({
        filter: finalFilter, order_by, depth, limit, offset,
        after: starting_after, before: ending_before, search,
        include_deleted: true,
      });
      return text("Tasks:", await client.request(`/rest/tasks${qs}`));
    },
    update_task: async (args) => {
      const { id, ...rest } = args as { id: string } & BodyInput;
      const body = transformBodyField(rest);
      return text("Updated task:", await client.request(`/rest/tasks/${id}`, { method: "PATCH", body }));
    },
    delete_task: async (args) => {
      const { id } = args as { id: string };
      await client.request(`/rest/tasks/${id}`, { method: "DELETE" });
      return ok(`Deleted task ${id}`);
    },
  };
}
