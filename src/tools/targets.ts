import { buildListQuery, type RestClient } from "../rest.ts";
import { text, ok } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

export const definitions: Tool[] = [
  {
    name: "create_note_target",
    description: "Link a note to a person, company, or opportunity.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        targetPersonId: { type: "string" },
        targetCompanyId: { type: "string" },
        targetOpportunityId: { type: "string" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "list_note_targets",
    description: "List noteTarget rows. Filter by noteId / targetPersonId / targetCompanyId or any field.\n\nExamples:\n  filter: noteId[eq]:\"<uuid>\"\n  filter: targetPersonId[eq]:\"<uuid>\"",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Shortcut — equivalent to filter: noteId[eq]:<id>." },
        filter: { type: "string" },
        order_by: { type: "string" },
        limit: { type: "number" },
        starting_after: { type: "string" },
      },
    },
  },
  {
    name: "delete_note_target",
    description: "Unlink a noteTarget by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_task_target",
    description: "Link a task to a person, company, or opportunity.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        targetPersonId: { type: "string" },
        targetCompanyId: { type: "string" },
        targetOpportunityId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "list_task_targets",
    description: "List taskTarget rows. Filter by taskId / targetPersonId / targetCompanyId.\n\nExamples:\n  filter: taskId[eq]:\"<uuid>\"\n  filter: targetCompanyId[eq]:\"<uuid>\"",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Shortcut — equivalent to filter: taskId[eq]:<id>." },
        filter: { type: "string" },
        order_by: { type: "string" },
        limit: { type: "number" },
        starting_after: { type: "string" },
      },
    },
  },
  {
    name: "delete_task_target",
    description: "Unlink a taskTarget by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_notes_for_person",
    description: "Convenience: fetch all notes linked to a person via noteTargets.",
    inputSchema: {
      type: "object",
      properties: { personId: { type: "string" }, limit: { type: "number" } },
      required: ["personId"],
    },
  },
  {
    name: "list_tasks_for_person",
    description: "Convenience: fetch all tasks linked to a person via taskTargets.",
    inputSchema: {
      type: "object",
      properties: { personId: { type: "string" }, limit: { type: "number" } },
      required: ["personId"],
    },
  },
];

interface TargetListArgs {
  filter?: string;
  order_by?: string;
  limit?: number;
  starting_after?: string;
  noteId?: string;
  taskId?: string;
}

interface TargetRow {
  id: string;
  noteId?: string;
  taskId?: string;
}

interface TargetListResponse {
  data?: { noteTargets?: TargetRow[]; taskTargets?: TargetRow[] };
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  const listTargets = async (
    objectPath: "noteTargets" | "taskTargets",
    idShortcut: string | undefined,
    idField: "noteId" | "taskId",
    args: TargetListArgs,
  ) => {
    const { filter, order_by, limit = 50, starting_after } = args ?? {};
    const clauses: string[] = [];
    if (filter) clauses.push(filter);
    if (idShortcut) clauses.push(`${idField}[eq]:"${idShortcut}"`);
    const combined = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0]! : `and(${clauses.join(",")})`;
    const qs = buildListQuery({ filter: combined, order_by, limit, after: starting_after, include_deleted: true });
    return text(`${objectPath}:`, await client.request(`/rest/${objectPath}${qs}`));
  };

  return {
    create_note_target: async (args) =>
      text("Created noteTarget:", await client.request("/rest/noteTargets", { method: "POST", body: args })),
    list_note_targets: async (args) => {
      const a = (args ?? {}) as TargetListArgs;
      return listTargets("noteTargets", a.noteId, "noteId", a);
    },
    delete_note_target: async (args) => {
      const { id } = args as { id: string };
      await client.request(`/rest/noteTargets/${id}`, { method: "DELETE" });
      return ok(`Deleted noteTarget ${id}`);
    },
    create_task_target: async (args) =>
      text("Created taskTarget:", await client.request("/rest/taskTargets", { method: "POST", body: args })),
    list_task_targets: async (args) => {
      const a = (args ?? {}) as TargetListArgs;
      return listTargets("taskTargets", a.taskId, "taskId", a);
    },
    delete_task_target: async (args) => {
      const { id } = args as { id: string };
      await client.request(`/rest/taskTargets/${id}`, { method: "DELETE" });
      return ok(`Deleted taskTarget ${id}`);
    },
    list_notes_for_person: async (args) => {
      const { personId, limit = 50 } = args as { personId: string; limit?: number };
      const qs = buildListQuery({
        filter: `targetPersonId[eq]:"${personId}"`,
        limit,
        include_deleted: true,
      });
      const targetsResult = await client.request<TargetListResponse>(`/rest/noteTargets${qs}`);
      const targets = targetsResult?.data?.noteTargets ?? [];
      if (targets.length === 0) return ok(`No notes found for person ${personId}`);
      const notes: unknown[] = [];
      for (const t of targets) {
        try {
          const note = await client.request<{ data?: unknown }>(`/rest/notes/${t.noteId}`);
          notes.push({ ...((note?.data ?? note) as Record<string, unknown>), noteTargetId: t.id });
        } catch (e) {
          notes.push({ noteId: t.noteId, error: (e as Error).message });
        }
      }
      return text(`Notes for person ${personId} (${notes.length}):`, notes);
    },
    list_tasks_for_person: async (args) => {
      const { personId, limit = 50 } = args as { personId: string; limit?: number };
      const qs = buildListQuery({
        filter: `targetPersonId[eq]:"${personId}"`,
        limit,
        include_deleted: true,
      });
      const targetsResult = await client.request<TargetListResponse>(`/rest/taskTargets${qs}`);
      const targets = targetsResult?.data?.taskTargets ?? [];
      if (targets.length === 0) return ok(`No tasks found for person ${personId}`);
      const tasks: unknown[] = [];
      for (const t of targets) {
        try {
          const task = await client.request<{ data?: unknown }>(`/rest/tasks/${t.taskId}`);
          tasks.push({ ...((task?.data ?? task) as Record<string, unknown>), taskTargetId: t.id });
        } catch (e) {
          tasks.push({ taskId: t.taskId, error: (e as Error).message });
        }
      }
      return text(`Tasks for person ${personId} (${tasks.length}):`, tasks);
    },
  };
}
