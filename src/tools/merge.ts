import { buildListQuery, type RestClient } from "../rest.ts";
import { createTargetsForRecord } from "../transforms.ts";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

interface TargetRow {
  id: string;
  noteId?: string;
  taskId?: string;
}

interface TargetsListResponse {
  data?: { noteTargets?: TargetRow[]; taskTargets?: TargetRow[] };
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

async function listAllTargets(client: RestClient, kind: "noteTargets" | "taskTargets", personId: string): Promise<TargetRow[]> {
  const rows: TargetRow[] = [];
  let after: string | null = null;
  while (true) {
    const qs = buildListQuery({
      filter: `targetPersonId[eq]:"${personId}"`,
      limit: 200,
      after,
      include_deleted: true,
    });
    const r = await client.request<TargetsListResponse>(`/rest/${kind}${qs}`);
    const page: TargetRow[] = r?.data?.[kind] ?? [];
    rows.push(...page);
    const pageInfo = r?.pageInfo ?? {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return rows;
}

export const definitions: Tool[] = [
  {
    name: "merge_people",
    description: `Merge duplicate person records into one primary. Re-points every noteTarget / taskTarget from duplicates to the primary, copies over any field that is null on primary, then soft-deletes the duplicates.

Example:
  primaryId: "<uuid-to-keep>"
  duplicateIds: ["<uuid-1>", "<uuid-2>"]`,
    inputSchema: {
      type: "object",
      properties: {
        primaryId: { type: "string" },
        duplicateIds: { type: "array", items: { type: "string" } },
      },
      required: ["primaryId", "duplicateIds"],
    },
  },
  {
    name: "link_person_to_company",
    description: "Shortcut to set a person's companyId. Equivalent to update_person with { companyId }.",
    inputSchema: {
      type: "object",
      properties: { personId: { type: "string" }, companyId: { type: "string" } },
      required: ["personId", "companyId"],
    },
  },
  {
    name: "bulk_attach_note",
    description: `Attach one existing note to many persons and/or companies via noteTargets.

Example:
  noteId: "<note-uuid>"
  personIds: ["<p1>", "<p2>", "<p3>"]
  companyIds: ["<c1>"]`,
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        personIds: { type: "array", items: { type: "string" } },
        companyIds: { type: "array", items: { type: "string" } },
      },
      required: ["noteId"],
    },
  },
];

interface PersonRecord {
  [key: string]: unknown;
}

interface PersonGetResponse {
  data?: { person?: PersonRecord };
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    merge_people: async (args) => {
      const { primaryId, duplicateIds } = args as { primaryId: string; duplicateIds: string[] };
      if (!primaryId) throw new Error("primaryId is required");
      if (!Array.isArray(duplicateIds) || duplicateIds.length === 0) throw new Error("duplicateIds must be a non-empty array");
      const primary = (await client.request<PersonGetResponse>(`/rest/people/${primaryId}`))?.data?.person ?? null;
      if (!primary) throw new Error(`primary ${primaryId} not found`);

      const report: Array<Record<string, unknown>> = [];
      for (const dupId of duplicateIds) {
        const dup = (await client.request<PersonGetResponse>(`/rest/people/${dupId}`))?.data?.person;
        if (!dup) {
          report.push({ dupId, error: "not found" });
          continue;
        }
        // 1. Re-point targets
        const noteTargets = await listAllTargets(client, "noteTargets", dupId);
        const taskTargets = await listAllTargets(client, "taskTargets", dupId);
        let repointed = 0;
        for (const t of noteTargets) {
          await client.request("/rest/noteTargets", { method: "POST", body: { noteId: t.noteId, targetPersonId: primaryId } });
          await client.request(`/rest/noteTargets/${t.id}`, { method: "DELETE" });
          repointed++;
        }
        for (const t of taskTargets) {
          await client.request("/rest/taskTargets", { method: "POST", body: { taskId: t.taskId, targetPersonId: primaryId } });
          await client.request(`/rest/taskTargets/${t.id}`, { method: "DELETE" });
          repointed++;
        }

        // 2. Copy over null-on-primary fields from duplicate
        const patch: Record<string, unknown> = {};
        const skip = new Set(["id", "createdAt", "updatedAt", "deletedAt", "searchVector", "createdBy", "updatedBy", "position"]);
        for (const [k, v] of Object.entries(dup)) {
          if (skip.has(k)) continue;
          const primVal = primary[k];
          const primEmpty = primVal === null || primVal === undefined || primVal === "" ||
            (typeof primVal === "object" && primVal !== null && Object.values(primVal as Record<string, unknown>).every((x) => x === null || x === "" || (Array.isArray(x) && x.length === 0)));
          const dupHas = v !== null && v !== undefined && v !== "";
          if (primEmpty && dupHas) patch[k] = v;
        }
        if (Object.keys(patch).length) {
          await client.request(`/rest/people/${primaryId}`, { method: "PATCH", body: patch });
        }

        // 3. Soft-delete duplicate
        await client.request(`/rest/people/${dupId}`, { method: "DELETE" });
        report.push({ dupId, repointed, copiedFields: Object.keys(patch), softDeleted: true });
      }
      return text("merge_people:", { primaryId, report });
    },

    link_person_to_company: async (args) => {
      const { personId, companyId } = args as { personId: string; companyId: string };
      const r = await client.request(`/rest/people/${personId}`, { method: "PATCH", body: { companyId } });
      return text(`Linked ${personId} → company ${companyId}:`, r);
    },

    bulk_attach_note: async (args) => {
      const { noteId, personIds = [], companyIds = [] } = args as { noteId: string; personIds?: string[]; companyIds?: string[] };
      if (!personIds.length && !companyIds.length) throw new Error("Provide at least one of personIds / companyIds");
      const created = await createTargetsForRecord(client, "note", noteId, personIds, companyIds);
      return text(`bulk_attach_note (${created.length} targets):`, created);
    },
  };
}
