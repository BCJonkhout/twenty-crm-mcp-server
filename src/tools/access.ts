import { buildListQuery, type RestClient } from "../rest.ts";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

// Per-object-type default ownership field. Extend if custom objects use
// their own relation name.
const OWNER_FIELD_BY_OBJECT: Record<string, string> = {
  companies: "accountOwnerId",
  opportunities: "ownerId",
  tasks: "assigneeId",
};

const LIST_MEMBERS_DESCRIPTION = `List Twenty workspace members (the users who can own records). Returns id, name, userEmail, colorScheme for each. These ids are what go into company.accountOwnerId, opportunity.ownerId, task.assigneeId.

Note: only existing workspace members are listed. Inviting a new member is done from the Twenty admin UI at Settings → Members — the REST API does not expose the invite flow.`;

const ASSIGN_OWNER_DESCRIPTION = `Assign a workspace member as the owner/assignee of a record. Smart wrapper:

  • Resolves the member by id OR userEmail OR name (firstName + lastName substring match, case-insensitive).
  • Picks the right field per object type:
      companies     → accountOwnerId
      opportunities → ownerId
      tasks         → assigneeId
    For any other object pass ownerField explicitly.
  • Patches the record and returns the new ownership.

⚠ In Twenty's default config this is informational, not a permission grant — all workspace members already see all records unless role-based policies are configured in admin. Assigning an owner affects *their* queue, notifications, and who shows as responsible.

Examples:
  • Assign a company to Geert by email:
      objectType: "companies"
      recordId: "<company-uuid>"
      memberEmail: "haisma@prudai.com"
  • Assign a task to Beau by name (partial match OK):
      objectType: "tasks"
      recordId: "<task-uuid>"
      memberName: "Beau"
  • Assign an opportunity with an explicit member id:
      objectType: "opportunities"
      recordId: "<opp-uuid>"
      memberId: "356e0364-5f38-4288-bfd9-20e6166c676d"
  • Unset ownership (pass null):
      objectType: "companies"
      recordId: "<uuid>"
      memberId: null`;

interface WorkspaceMember {
  id: string;
  name?: { firstName?: string; lastName?: string };
  userEmail?: string;
  colorScheme?: string;
}

interface MembersListResponse {
  data?: { workspaceMembers?: WorkspaceMember[] };
}

interface ResolveMemberArgs {
  memberId?: string | null;
  memberEmail?: string;
  memberName?: string;
}

interface ResolvedMember {
  id: string | null;
  name?: { firstName?: string; lastName?: string };
  userEmail?: string;
}

async function resolveMember(client: RestClient, { memberId, memberEmail, memberName }: ResolveMemberArgs): Promise<ResolvedMember> {
  if (memberId === null) return { id: null }; // explicit unset
  if (memberId) return { id: memberId };

  if (memberEmail) {
    const qs = buildListQuery({
      filter: `userEmail[eq]:"${memberEmail.replace(/"/g, '\\"')}"`,
      limit: 1,
      include_deleted: true,
    });
    const r = await client.request<MembersListResponse>(`/rest/workspaceMembers${qs}`);
    const m = r?.data?.workspaceMembers?.[0];
    if (!m) throw new Error(`No workspace member with userEmail="${memberEmail}"`);
    return m;
  }

  if (memberName) {
    // Fetch all members and filter client-side — there are typically <20.
    const r = await client.request<MembersListResponse>(`/rest/workspaceMembers?limit=200`);
    const members = r?.data?.workspaceMembers ?? [];
    const needle = memberName.toLowerCase();
    const match = members.filter((m) => {
      const full = `${m?.name?.firstName ?? ""} ${m?.name?.lastName ?? ""}`.trim().toLowerCase();
      return full.includes(needle) || (m.userEmail ?? "").toLowerCase().includes(needle);
    });
    if (match.length === 0) {
      const roster = members.map((m) => `${m.name?.firstName} ${m.name?.lastName} <${m.userEmail}>`).join(", ");
      throw new Error(`No workspace member matching "${memberName}". Known members: ${roster}`);
    }
    if (match.length > 1) {
      const options = match.map((m) => `${m.id} (${m.name?.firstName} ${m.name?.lastName} <${m.userEmail}>)`).join(", ");
      throw new Error(`Ambiguous memberName="${memberName}" — matched ${match.length}: ${options}. Use memberEmail or memberId instead.`);
    }
    return match[0]!;
  }

  throw new Error("Provide one of: memberId, memberEmail, memberName (or memberId: null to unset).");
}

export const definitions: Tool[] = [
  {
    name: "list_workspace_members",
    description: LIST_MEMBERS_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assign_owner",
    description: ASSIGN_OWNER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        objectType: {
          type: "string",
          description: "Plural REST name: 'companies', 'opportunities', 'tasks' (or any object with a member-relation field).",
        },
        recordId: { type: "string", description: "UUID of the record to assign." },
        memberId: { type: ["string", "null"], description: "Workspace member UUID. Pass null to unset." },
        memberEmail: { type: "string", description: "Resolve member by userEmail." },
        memberName: { type: "string", description: "Resolve member by name substring (e.g. 'Geert' or 'bas')." },
        ownerField: {
          type: "string",
          description: "Field to patch. Defaults: companies→accountOwnerId, opportunities→ownerId, tasks→assigneeId.",
        },
      },
      required: ["objectType", "recordId"],
    },
  },
];

interface AssignOwnerArgs extends ResolveMemberArgs {
  objectType?: string;
  recordId?: string;
  ownerField?: string;
}

export function createHandlers(client: RestClient): Record<string, ToolHandler> {
  return {
    list_workspace_members: async () => {
      const r = await client.request<MembersListResponse>("/rest/workspaceMembers?limit=200");
      const members = r?.data?.workspaceMembers ?? [];
      const slim = members.map((m) => ({
        id: m.id,
        name: `${m.name?.firstName ?? ""} ${m.name?.lastName ?? ""}`.trim(),
        userEmail: m.userEmail,
        colorScheme: m.colorScheme,
      }));
      return text(`Workspace members (${slim.length}):`, slim);
    },

    assign_owner: async (args) => {
      const { objectType, recordId, memberId, memberEmail, memberName, ownerField } = (args ?? {}) as AssignOwnerArgs;
      if (!objectType) throw new Error("objectType is required");
      if (!recordId) throw new Error("recordId is required");

      const field = ownerField ?? OWNER_FIELD_BY_OBJECT[objectType];
      if (!field) {
        throw new Error(
          `No default owner field known for objectType="${objectType}". Pass ownerField explicitly (e.g. 'accountOwnerId', 'ownerId', 'assigneeId').`,
        );
      }

      const resolved = await resolveMember(client, { memberId, memberEmail, memberName });
      const newValue = resolved.id; // may be null (explicit unset)
      const patched = await client.request(`/rest/${objectType}/${recordId}`, {
        method: "PATCH",
        body: { [field]: newValue },
      });
      return text(`assign_owner ${objectType}/${recordId} ${field}=${newValue ?? "NULL"}:`, {
        member: resolved.id ? {
          id: resolved.id,
          name: resolved.name ? `${resolved.name.firstName ?? ""} ${resolved.name.lastName ?? ""}`.trim() : undefined,
          userEmail: resolved.userEmail,
        } : null,
        patched,
      });
    },
  };
}
