// `cato tasks` — the task board in CATO, read side plus the glue the write
// verbs need (due-date parsing, assignee lookup, target resolution).
//
// Tasks are to replace the Trello board: /memo-verwerken, /give-me-work,
// /trello-agenda and /trello-groom are meant to read and write them through
// these verbs. Those skills still run on Trello today — this is the CLI side
// standing ready, not a live integration.
// Everything that knows how a task hangs together lives here — the write
// bodies themselves are in recordWrite.ts next to notes and opportunities.
//
// Shapes verified against crm.prudai.com (prudai/twenty v1.19, 2026-08-24):
//   task        title, bodyV2{markdown,blocknote}, status (SELECT), dueAt,
//               assigneeId, position, createdBy/updatedBy (ACTOR)
//   taskTarget  taskId + targetCompanyId | targetPersonId | targetOpportunityId
//               (depth=1 expands targetCompany/targetPerson/targetOpportunity)
//   workspaceMember  id, name{firstName,lastName}, userEmail

import { andExpr, clause, iterRecords, type RestClient, type TwentyRecord } from "@twenty-crm/core";
import { isKnownTaskStatus, normaliseTaskStatus, TASK_STATUS_VALUES } from "../filters.ts";
import { render, renderOne, toCsv } from "../output.ts";
import { DUE_TIME_ZONE, parseZonedInstant, WALL_CLOCK_RE, zonedDayStartIso, zonedToUtc } from "../time.ts";
import { DEFAULT_BASE_URL, recordUrl } from "../urls.ts";
import { fetchRecords, type ListInvocation } from "./records.ts";

export class TaskError extends Error {}

/** Soonest due first; undated tasks at the end. */
export const DEFAULT_TASK_ORDER = "dueAt[AscNullsLast]";

// ---- due dates --------------------------------------------------------------

/**
 * `--due` accepts a day (`2026-09-04`), a day with a time
 * (`2026-09-04T10:00`, also with a space or seconds) or a full ISO timestamp
 * with zone. Day and wall-clock forms are read in Europe/Amsterdam: a Dutch
 * team saying "10:00" means 10:00 here, and a bare day is midnight here, so the
 * card shows the intended date in the UI and turns overdue at the start of it.
 */
export function parseDueAt(value: string, timeZone: string = DUE_TIME_ZONE): string {
  const iso = parseZonedInstant(value, timeZone);
  if (iso) return iso;
  // "2026-02-30" and "morgen" are different mistakes and deserve different
  // answers: one is a day that does not exist, the other is not a date at all.
  if (WALL_CLOCK_RE.test(value.trim())) {
    throw new TaskError(`--due: '${value}' is not a real date/time.`);
  }
  throw new TaskError(
    `--due: '${value}' is not a valid date. Use YYYY-MM-DD, YYYY-MM-DDTHH:MM (Europe/Amsterdam) or an ISO timestamp with zone.`,
  );
}

/** `2026-09-03T22:00:00.000Z` → `2026-09-04` (midnight here) or `2026-09-04 10:00`. */
export function formatDue(iso: string | null | undefined, timeZone: string = DUE_TIME_ZONE): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return p.hour === "00" && p.minute === "00" ? day : `${day} ${p.hour}:${p.minute}`;
}

/**
 * Board rule: parking a card sets when it comes back. Default two weeks from
 * `now`: the calendar day 14 days out, at midnight Europe/Amsterdam — the same
 * instant `--due <that day>` would write.
 */
export function parkDue(now: Date = new Date(), timeZone: string = DUE_TIME_ZONE): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const today = dtf.format(now); // YYYY-MM-DD in the team's zone
  const iso = zonedDayStartIso(today, 14, timeZone);
  if (!iso) throw new TaskError(`Cannot compute a park due date from '${today}'.`);
  return iso;
}

// ---- status -----------------------------------------------------------------

/** Non-null when a status is outside the six the board uses; the CRM decides. */
export function statusHint(status: string | undefined): string | null {
  if (!status?.trim()) return null;
  if (isKnownTaskStatus(status)) return null;
  return `Note: status '${normaliseTaskStatus(status)}' is not one of ${TASK_STATUS_VALUES.join(", ")}; ` +
    "CATO's field metadata decides whether it is accepted.";
}

// ---- workspace members (assignees) ------------------------------------------

export interface WorkspaceMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export async function listWorkspaceMembers(client: RestClient): Promise<WorkspaceMember[]> {
  const result = await client.request<{ data?: { workspaceMembers?: TwentyRecord[] } }>(
    "/rest/workspaceMembers?limit=200",
  );
  return (result?.data?.workspaceMembers ?? []).map((m) => {
    const name = (m.name ?? {}) as { firstName?: string; lastName?: string };
    return {
      id: String(m.id ?? ""),
      firstName: name.firstName ?? "",
      lastName: name.lastName ?? "",
      email: String(m.userEmail ?? ""),
    };
  }).filter((m) => m.id);
}

export function memberName(m: WorkspaceMember | undefined): string {
  if (!m) return "";
  return [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--assignee beau` / `--assignee haisma@prudai.com` → one workspace member.
 * Exact match on first name, last name, full name, e-mail or the part before
 * the @; a substring match only as fallback and only when it is unambiguous.
 * `me` is refused: an API key has no workspace member to be.
 */
export function resolveMember(members: readonly WorkspaceMember[], text: string): WorkspaceMember {
  const q = text.trim().toLowerCase();
  if (!q) throw new TaskError("--assignee needs a name or e-mail.");
  if (q === "me") {
    throw new TaskError(
      "--assignee me is not available: an API key has no workspace member. Use a name or e-mail (e.g. --assignee beau).",
    );
  }
  if (UUID_RE.test(q)) {
    const byId = members.find((m) => m.id.toLowerCase() === q);
    if (byId) return byId;
    throw new TaskError(`No workspace member with id ${text}. Known: ${members.map(memberName).join(", ")}.`);
  }
  const exact = members.filter((m) =>
    m.firstName.toLowerCase() === q || m.lastName.toLowerCase() === q ||
    memberName(m).toLowerCase() === q || m.email.toLowerCase() === q ||
    m.email.toLowerCase().split("@")[0] === q);
  const hits = exact.length > 0 ? exact : members.filter((m) =>
    memberName(m).toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    throw new TaskError(`No workspace member matches '${text}'. Known: ${members.map(memberName).join(", ")}.`);
  }
  throw new TaskError(
    `'${text}' matches ${hits.length} workspace members: ${hits.map((m) => `${memberName(m)} <${m.email}>`).join(", ")}. Be more specific.`,
  );
}

// ---- targets ----------------------------------------------------------------

export type TargetKind = "company" | "person" | "opportunity";

export interface TaskTargetRef {
  kind: TargetKind;
  id: string;
  name: string | null;
}

export interface TargetFilter {
  companyId?: string;
  personId?: string;
  opportunityId?: string;
}

function targetFromRow(row: TwentyRecord): TaskTargetRef | null {
  if (row.targetCompanyId) {
    const c = row.targetCompany as { name?: string } | null | undefined;
    return { kind: "company", id: String(row.targetCompanyId), name: c?.name ?? null };
  }
  if (row.targetPersonId) {
    const p = row.targetPerson as { name?: { firstName?: string; lastName?: string } } | null | undefined;
    const name = [p?.name?.firstName, p?.name?.lastName].filter(Boolean).join(" ");
    return { kind: "person", id: String(row.targetPersonId), name: name || null };
  }
  if (row.targetOpportunityId) {
    const o = row.targetOpportunity as { name?: string } | null | undefined;
    return { kind: "opportunity", id: String(row.targetOpportunityId), name: o?.name ?? null };
  }
  return null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** taskId → its live targets, with names (depth=1), for a set of tasks. */
export async function fetchTargetsForTasks(
  client: RestClient, taskIds: readonly string[],
): Promise<Map<string, TaskTargetRef[]>> {
  const byTask = new Map<string, TaskTargetRef[]>();
  for (const ids of chunk(taskIds, 50)) {
    const filter = andExpr(clause("taskId", "in", ids), "deletedAt[is]:NULL");
    for await (const row of iterRecords(client, "taskTargets", { filter, depth: 1, limit: 200 })) {
      const ref = targetFromRow(row);
      if (!ref) continue;
      const taskId = String(row.taskId ?? "");
      const list = byTask.get(taskId) ?? [];
      list.push(ref);
      byTask.set(taskId, list);
    }
  }
  return byTask;
}

/**
 * Task ids linked to the given record(s). Null when no target flag was passed;
 * with more than one flag the sets are intersected ("linked to this company
 * AND this person"), since a single taskTarget row carries only one kind.
 */
export async function taskIdsForTarget(
  client: RestClient, target: TargetFilter,
): Promise<string[] | null> {
  const wanted: Array<[string, string]> = [];
  if (target.companyId) wanted.push(["targetCompanyId", target.companyId]);
  if (target.personId) wanted.push(["targetPersonId", target.personId]);
  if (target.opportunityId) wanted.push(["targetOpportunityId", target.opportunityId]);
  if (wanted.length === 0) return null;

  let ids: string[] | null = null;
  for (const [field, value] of wanted) {
    const filter = andExpr(clause(field, "eq", value), "deletedAt[is]:NULL");
    const found = new Set<string>();
    for await (const row of iterRecords(client, "taskTargets", { filter, limit: 200 })) {
      if (row.taskId) found.add(String(row.taskId));
    }
    ids = ids === null ? [...found] : ids.filter((id) => found.has(id));
    if (ids.length === 0) break;
  }
  return ids ?? [];
}

// ---- fetching ---------------------------------------------------------------

function sortForBoard(rows: TwentyRecord[]): TwentyRecord[] {
  const key = (r: TwentyRecord) => (r.dueAt ? String(r.dueAt) : "￿");
  return [...rows].sort((a, b) =>
    key(a).localeCompare(key(b)) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Plain lists page through records.ts. A target-scoped list already knows its
 * ids, so it fetches those in chunks of 100 and applies the limit itself — the
 * server cannot order across chunks, so the result is sorted here (due first,
 * undated last), the same order a plain list asks the server for.
 */
export async function fetchTasks(
  client: RestClient, plan: ListInvocation, ids: readonly string[] | null,
): Promise<TwentyRecord[]> {
  if (ids === null) return fetchRecords(client, plan);
  if (ids.length === 0) return [];
  const rows: TwentyRecord[] = [];
  for (const part of chunk(ids, 100)) {
    rows.push(...await fetchRecords(client, {
      ...plan,
      filter: andExpr(plan.filter, clause("id", "in", part)),
      fetchAll: true,
      limitExplicit: false,
    }));
  }
  const sorted = sortForBoard(rows);
  const cap = plan.fetchAll ? (plan.limitExplicit ? plan.limit : Infinity) : plan.limit;
  return sorted.slice(0, cap);
}

export async function fetchTask(client: RestClient, id: string): Promise<TwentyRecord | null> {
  const result = await client.request<{ data?: { task?: TwentyRecord } }>(`/rest/tasks/${encodeURIComponent(id)}`);
  return result?.data?.task ?? null;
}

// ---- comments ---------------------------------------------------------------

export interface TaskComment extends Record<string, unknown> {
  id: string;
  body: string;
  createdAt: string;
  /** "name (source)" from the ACTOR field, or "" when the CRM sent none. */
  author: string;
}

/** Every comment on the task, oldest first — a thread reads top to bottom. */
export async function fetchComments(client: RestClient, taskId: string): Promise<TaskComment[]> {
  const filter = andExpr(clause("taskId", "eq", taskId), "deletedAt[is]:NULL");
  const rows: TaskComment[] = [];
  for await (const row of iterRecords(client, "comments", {
    filter, limit: 200, order_by: "createdAt[AscNullsFirst]",
  })) {
    const by = row.createdBy as { name?: string; source?: string } | null | undefined;
    rows.push({
      id: String(row.id ?? ""),
      body: String(row.body ?? ""),
      createdAt: String(row.createdAt ?? ""),
      author: by?.name ? `${by.name}${by.source ? ` (${by.source})` : ""}` : "",
    });
  }
  return rows;
}

export function renderCommentList(
  comments: readonly TaskComment[],
  taskUrl: string,
  ctx: { json: boolean; csv: boolean },
): string {
  if (ctx.json) return JSON.stringify(comments, null, 2);
  if (ctx.csv) return toCsv(comments, ["id", "createdAt", "author", "body"]);
  if (comments.length === 0) return `(no comments)\n\n${taskUrl}`;
  const lines: string[] = [];
  for (const c of comments) {
    lines.push(`${formatDue(c.createdAt)}  ${c.author || "?"}`);
    for (const l of c.body.split("\n")) lines.push(`  ${l}`);
    lines.push("");
  }
  lines.push(`${comments.length} comment(s)  ${taskUrl}`);
  return lines.join("\n");
}

// ---- rendering --------------------------------------------------------------

export interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
  status: string | null;
  dueAt: string | null;
  due: string;
  assigneeId: string | null;
  assignee: string;
  targets: TaskTargetRef[];
  url: string;
}

export function enrichTasks(
  tasks: readonly TwentyRecord[],
  targets: ReadonlyMap<string, TaskTargetRef[]>,
  members: readonly WorkspaceMember[],
  baseUrl: string = DEFAULT_BASE_URL,
): TaskRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  return tasks.map((t) => {
    const id = String(t.id ?? "");
    const assigneeId = t.assigneeId ? String(t.assigneeId) : null;
    return {
      ...t,
      id,
      title: String(t.title ?? ""),
      status: t.status ? String(t.status) : null,
      dueAt: t.dueAt ? String(t.dueAt) : null,
      due: formatDue(t.dueAt as string | null),
      assigneeId,
      assignee: assigneeId ? (memberName(memberById.get(assigneeId)) || assigneeId) : "",
      targets: targets.get(id) ?? [],
      url: recordUrl(baseUrl, "task", id),
    };
  });
}

export const TASK_LIST_COLUMNS = ["id", "title", "status", "due", "assignee", "targets", "url"] as const;

export function describeTargets(targets: readonly TaskTargetRef[]): string {
  return targets.map((t) => `${t.kind}: ${t.name ?? t.id}`).join("; ");
}

/** The table/CSV shape: short id, formatted due date, names instead of ids. */
export function toListRow(row: TaskRow): Record<string, unknown> {
  return {
    ...row,
    id: row.id.slice(0, 8),
    targets: describeTargets(row.targets),
  };
}

export function renderTaskList(
  rows: readonly TaskRow[],
  ctx: { json: boolean; csv: boolean; columns?: readonly string[] },
): string {
  if (ctx.json) return JSON.stringify(rows, null, 2);
  const columns = ctx.columns ?? TASK_LIST_COLUMNS;
  const listRows = rows.map(toListRow);
  if (ctx.csv) return toCsv(listRows, columns);
  return render(listRows, { columns, maxWidths: { title: 60, targets: 60 } });
}

const DETAIL_SCALARS = [
  "id", "title", "status", "board", "priority", "source", "labels", "betrokkenen",
  "due", "dueAt", "assignee", "assigneeId", "sourceLink", "legacyRef", "lastComment",
  "position", "createdAt", "updatedAt", "url",
] as const;

export function renderTaskDetail(
  row: TaskRow | null,
  ctx: { json: boolean; csv: boolean },
): string {
  if (row === null) return ctx.json ? "null" : "(not found)";
  if (ctx.json) return JSON.stringify(row, null, 2);
  if (ctx.csv) return toCsv([toListRow(row)], TASK_LIST_COLUMNS);

  const createdBy = row.createdBy as { name?: string; source?: string } | null | undefined;
  const scalars: Record<string, unknown> = {};
  for (const key of DETAIL_SCALARS) scalars[key] = row[key];
  // The board fields that are not flat strings, made readable: MULTI_SELECT as
  // a comma list, the LINKS composite as its URL, the last comment as
  // "preview (when)" so Trello's comment badge has an equivalent here.
  scalars.labels = Array.isArray(row.labels) ? (row.labels as string[]).join(", ") : row.labels ?? "";
  scalars.betrokkenen = Array.isArray(row.betrokkenen) ? (row.betrokkenen as string[]).join(", ") : row.betrokkenen ?? "";
  const link = row.sourceLink as { primaryLinkUrl?: string } | null | undefined;
  scalars.sourceLink = link?.primaryLinkUrl ?? "";
  const lastPreview = row.lastCommentPreview ? String(row.lastCommentPreview) : "";
  scalars.lastComment = lastPreview
    ? `${lastPreview}${row.lastCommentAt ? `  (${formatDue(String(row.lastCommentAt))})` : ""}`
    : "";
  scalars.createdBy = createdBy?.name ? `${createdBy.name} (${createdBy.source ?? "?"})` : "";
  // renderOne pads each label to the longest one and adds two spaces, so the
  // second and later target lines have to line up with that same column.
  const labelWidth = Math.max(...[...DETAIL_SCALARS, "createdBy", "targets"].map((k) => k.length)) + 2;
  scalars.targets = row.targets.length
    ? row.targets.map((t) => `${t.kind}: ${t.name ?? "?"} (${t.id})`).join("\n" + " ".repeat(labelWidth))
    : "";
  const lines = [renderOne(scalars, { json: false, csv: false })];

  const body = row.bodyV2 as { markdown?: string | null } | null | undefined;
  const markdown = body?.markdown?.trim();
  lines.push("", "body:", markdown ? markdown.split("\n").map((l) => `  ${l}`).join("\n") : "  (empty)");
  return lines.join("\n");
}
