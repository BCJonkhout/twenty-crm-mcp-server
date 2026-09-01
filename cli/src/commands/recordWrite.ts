// Write path for the CRM objects the CLI can change: people, companies,
// opportunities, notes and tasks.
//
// Twenty stores names, emails, phones, money and rich text as composite fields;
// `transformPersonData`, `transformCompanyData` and `transformBodyField` in core
// do that mapping, so the CLI takes flat flags and never asks anyone to
// hand-write a composite object.

import type { RestClient } from "@twenty-crm/core";
import {
  createTargetsForRecord, extractId, transformBodyField,
  transformCompanyData, transformPersonData,
} from "@twenty-crm/core";
import {
  normaliseSelectValue, normaliseTaskStatus, OPPORTUNITY_STAGE_VALUES,
  TASK_BETROKKENEN_VALUES, TASK_BOARD_VALUES, TASK_LABEL_VALUES, TASK_PRIORITY_VALUES, TASK_SOURCE_VALUES,
} from "../filters.ts";
import { recordUrl } from "../urls.ts";

export class RecordWriteError extends Error {}

export type WritableObject = "people" | "companies" | "opportunities" | "notes" | "tasks";

const SINGULAR: Record<WritableObject, string> = {
  people: "person", companies: "company", opportunities: "opportunity", notes: "note", tasks: "task",
};

/**
 * Stages that mean "this deal is still running" — used by the create guard below.
 * ON_HOLD counts as open: a parked deal is paused, not closed, so a second
 * opportunity next to it would fragment the same deal across two records.
 */
export const OPEN_STAGES = ["NEW", "SCREENING", "MEETING", "PROPOSAL", "PILOT", "ON_HOLD"] as const;

export interface PersonFlags {
  firstName?: string; lastName?: string; email?: string; phone?: string;
  jobTitle?: string; city?: string; linkedinUrl?: string;
  companyId?: string; assigneeId?: string;
}

export interface CompanyFlags {
  name?: string; domain?: string; city?: string; employees?: number;
  branche?: string; accountOwnerId?: string;
}

export interface OpportunityFlags {
  name?: string; stage?: string; amount?: number; closeDate?: string;
  companyId?: string; pointOfContactId?: string;
}

export interface NoteFlags {
  title?: string; body?: string; companyId?: string; personId?: string;
}

export interface TaskFlags {
  title?: string;
  /** Markdown; becomes bodyV2 (markdown + blocknote) like a note body. */
  body?: string;
  status?: string;
  /** Already an ISO timestamp — see parseDueAt in commands/tasks.ts. */
  dueAt?: string;
  assigneeId?: string;
  /** SELECT — one of TASK_BOARD_VALUES (the six boards + the legacy PRUDAI). Required on create. */
  board?: string;
  /** MULTI_SELECT; a write replaces the whole set. */
  labels?: string[];
  priority?: string;
  source?: string;
  /** MULTI_SELECT; a write replaces the whole set. */
  betrokkenen?: string[];
  legacyRef?: string;
  /** Absolute URL; becomes the LINKS composite. */
  sourceLink?: string;
  /** Pass-through fields from --field key=value (custom fields the flags do not know yet). */
  fields?: Record<string, unknown>;
}

export interface TaskTargets {
  companyId?: string; personId?: string; opportunityId?: string;
}

/** Drops undefined/blank flags so an update never blanks a field by accident. */
function present(input: PersonFlags | CompanyFlags | OpportunityFlags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

export function buildPersonBody(flags: PersonFlags): Record<string, unknown> {
  const cleaned = present(flags);
  if (Object.keys(cleaned).length === 0) {
    throw new RecordWriteError("Nothing to write: pass at least one field.");
  }
  return transformPersonData(cleaned as never);
}

export function buildCompanyBody(flags: CompanyFlags): Record<string, unknown> {
  const cleaned = present(flags);
  if (Object.keys(cleaned).length === 0) {
    throw new RecordWriteError("Nothing to write: pass at least one field.");
  }
  return transformCompanyData(cleaned as never);
}

/** €25.000 on the command line is 25_000_000_000 micros in Twenty. */
export function eurToMicros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

export function buildOpportunityBody(flags: OpportunityFlags): Record<string, unknown> {
  const cleaned = present(flags) as OpportunityFlags;
  if (Object.keys(cleaned).length === 0) {
    throw new RecordWriteError("Nothing to write: pass at least one field.");
  }
  const body: Record<string, unknown> = {};
  if (cleaned.name) body.name = cleaned.name;
  if (cleaned.companyId) body.companyId = cleaned.companyId;
  if (cleaned.pointOfContactId) body.pointOfContactId = cleaned.pointOfContactId;
  if (cleaned.stage) {
    const stage = cleaned.stage.toUpperCase();
    if (!(OPPORTUNITY_STAGE_VALUES as readonly string[]).includes(stage)) {
      throw new RecordWriteError(
        `Unknown stage '${cleaned.stage}'. One of: ${OPPORTUNITY_STAGE_VALUES.join(", ")}.`,
      );
    }
    body.stage = stage;
  }
  if (cleaned.amount !== undefined) {
    if (!Number.isFinite(cleaned.amount) || cleaned.amount < 0) {
      throw new RecordWriteError("--amount must be a non-negative number of euros.");
    }
    body.amount = { amountMicros: eurToMicros(cleaned.amount), currencyCode: "EUR" };
  }
  if (cleaned.closeDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned.closeDate)) {
      throw new RecordWriteError("--close-date must be YYYY-MM-DD.");
    }
    body.closeDate = `${cleaned.closeDate}T00:00:00.000Z`;
  }
  return body;
}

export function buildNoteBody(flags: NoteFlags): Record<string, unknown> {
  if (!flags.title?.trim()) throw new RecordWriteError("cato notes create needs --title.");
  if (flags.body === undefined || flags.body.trim() === "") {
    throw new RecordWriteError("cato notes create needs --body or --body-file.");
  }
  return transformBodyField({ title: flags.title, body: flags.body });
}

/** Update-half of the note write path: PATCH only the fields that were passed. */
export function buildNoteUpdateBody(flags: NoteFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (flags.title?.trim()) body.title = flags.title;
  if (flags.body !== undefined && flags.body.trim() !== "") {
    Object.assign(body, transformBodyField({ body: flags.body }));
  }
  if (Object.keys(body).length === 0) {
    throw new RecordWriteError("Nothing to write: pass --title, --body or --body-file.");
  }
  return body;
}

// ---- tasks ----------------------------------------------------------------

/**
 * Fields that have a dedicated flag. `--field` exists for custom fields the
 * flags do not know yet (`bord`, `labels`); letting it also carry `status` or
 * `dueAt` would route those around the normalisation and date parsing.
 */
export const TASK_FLAG_OWNED_FIELDS = new Set([
  "title", "status", "dueAt", "assigneeId", "bodyV2", "body",
  "board", "labels", "priority", "source", "betrokkenen", "legacyRef", "sourceLink",
  // `bord` was the working name for the board field before it landed as `board`
  // (old README examples used it); the live field does not exist under that
  // name, so catch the muscle memory here instead of relaying CATO's 400.
  "bord",
  "id", "createdAt", "updatedAt", "deletedAt", "createdBy", "updatedBy",
]);

/**
 * `--field key=value` → string, `--field key:=<json>` → parsed JSON (number,
 * boolean, null, array, object). The key is only checked for shape; whether the
 * field exists is CATO's call, and its 400 is shown as-is.
 */
export function parseFieldAssignments(
  items: readonly string[],
  owned: ReadonlySet<string> = TASK_FLAG_OWNED_FIELDS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const m = /^([A-Za-z][A-Za-z0-9]*)(:?=)([\s\S]*)$/.exec(item);
    if (!m) throw new RecordWriteError(`--field expects key=value or key:=<json>, got '${item}'.`);
    const [, key, op, raw] = m as unknown as [string, string, string, string];
    if (owned.has(key)) {
      throw new RecordWriteError(`--field ${key}: that field has its own flag — use it instead of --field.`);
    }
    if (op === ":=") {
      try { out[key] = JSON.parse(raw); }
      catch { throw new RecordWriteError(`--field ${key}: '${raw}' is not valid JSON (use key=value for a plain string).`); }
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * The task SELECT/MULTI_SELECT flags ARE enforced (unlike --status): they sit
 * on stable board config, and the friendly error beats CATO's raw 400.
 */
function taskSelect(flag: string, value: string, allowed: readonly string[]): string {
  const v = normaliseSelectValue(value);
  if (!allowed.includes(v)) {
    throw new RecordWriteError(`--${flag}: '${value}' is not a valid value. Allowed: ${allowed.join(", ")}.`);
  }
  return v;
}

/** The Trello→CATO board fields, shared by the create and update bodies. */
function applyBoardFields(body: Record<string, unknown>, flags: TaskFlags): void {
  if (flags.board?.trim()) body.board = taskSelect("board", flags.board, TASK_BOARD_VALUES);
  if (flags.labels && flags.labels.length > 0) {
    body.labels = flags.labels.map((l) => taskSelect("label", l, TASK_LABEL_VALUES));
  }
  if (flags.priority?.trim()) body.priority = taskSelect("priority", flags.priority, TASK_PRIORITY_VALUES);
  if (flags.source?.trim()) body.source = taskSelect("source", flags.source, TASK_SOURCE_VALUES);
  if (flags.betrokkenen && flags.betrokkenen.length > 0) {
    body.betrokkenen = flags.betrokkenen.map((b) => taskSelect("betrokkenen", b, TASK_BETROKKENEN_VALUES));
  }
  if (flags.legacyRef?.trim()) body.legacyRef = flags.legacyRef.trim();
  if (flags.sourceLink?.trim()) {
    const url = flags.sourceLink.trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new RecordWriteError(`--source-link must be an absolute URL, got '${url}'.`);
    }
    body.sourceLink = { primaryLinkLabel: "", primaryLinkUrl: url, secondaryLinks: [] };
  }
}

export function buildTaskBody(flags: TaskFlags): Record<string, unknown> {
  if (!flags.title?.trim()) throw new RecordWriteError("cato tasks create needs --title.");
  const body: Record<string, unknown> = { ...(flags.fields ?? {}), title: flags.title.trim() };
  if (flags.body !== undefined && flags.body.trim() !== "") {
    Object.assign(body, transformBodyField({ body: flags.body }));
  }
  if (flags.status?.trim()) body.status = normaliseTaskStatus(flags.status);
  if (flags.dueAt) body.dueAt = flags.dueAt;
  if (flags.assigneeId) body.assigneeId = flags.assigneeId;
  applyBoardFields(body, flags);
  return body;
}

/** PATCH only what was passed; links (taskTargets) are never touched here. */
export function buildTaskUpdateBody(flags: TaskFlags): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(flags.fields ?? {}) };
  if (flags.title?.trim()) body.title = flags.title.trim();
  if (flags.body !== undefined && flags.body.trim() !== "") {
    Object.assign(body, transformBodyField({ body: flags.body }));
  }
  if (flags.status?.trim()) body.status = normaliseTaskStatus(flags.status);
  if (flags.dueAt) body.dueAt = flags.dueAt;
  if (flags.assigneeId) body.assigneeId = flags.assigneeId;
  applyBoardFields(body, flags);
  if (Object.keys(body).length === 0) {
    throw new RecordWriteError(
      "Nothing to write: pass --title, --status, --due, --assignee-id, --body/--body-file, " +
      "--board/--label/--priority/--source/--betrokkenen/--source-link/--legacy-ref or --field.",
    );
  }
  return body;
}

// ---- create-time board rules ----------------------------------------------

/** Sources whose tasks land in the Inbox: agents create, Beau/Geert triage. */
export const INBOX_SOURCES = new Set(["AGENT", "MEMO", "CHAT"]);

/**
 * Where a new task starts when the caller does not say: agent-made work
 * (AGENT/MEMO/CHAT) goes to INBOX for triage, hand-made work straight to TODO.
 * An explicit --status always wins over this.
 */
export function defaultTaskStatus(source: string | undefined): "INBOX" | "TODO" {
  if (source && INBOX_SOURCES.has(normaliseSelectValue(source))) return "INBOX";
  return "TODO";
}

export interface TaskCreateGuardInput {
  board?: string;
  due?: string;
  noDue?: boolean;
  targets: TaskTargets;
  noTarget?: boolean;
}

/**
 * The board rules `tasks create` enforces (02-taakmodel §1.5, §0/beslispunt 9):
 * every card names its board, carries a due date, and hangs off the customer it
 * touches. The escape hatches (--no-due, --no-target) exist but must be said
 * out loud — a forgotten flag and a deliberate exception must not look alike.
 */
export function requireTaskCreateGuards(g: TaskCreateGuardInput): void {
  if (!g.board?.trim()) {
    throw new RecordWriteError(
      `cato tasks create needs --board (${TASK_BOARD_VALUES.join(" or ")}) — every card lives on a board.`,
    );
  }
  if (g.due && g.noDue) {
    throw new RecordWriteError("--due and --no-due contradict each other; pass one of them.");
  }
  if (!g.due && !g.noDue) {
    throw new RecordWriteError(
      "cato tasks create needs --due <date> — board rule: every card carries a due date. " +
      "A task that truly has none takes an explicit --no-due.",
    );
  }
  const hasTarget = Boolean(g.targets.companyId || g.targets.personId || g.targets.opportunityId);
  if (hasTarget && g.noTarget) {
    throw new RecordWriteError("--no-target contradicts the --company-id/--person-id/--opportunity-id you passed; drop one.");
  }
  if (!hasTarget && !g.noTarget) {
    throw new RecordWriteError(
      "cato tasks create needs a target (--company-id, --person-id and/or --opportunity-id) — a task that " +
      "touches a customer hangs off that customer, and the customer-timeline line only appears when the link " +
      "is made at creation. Internal work takes an explicit --no-target.",
    );
  }
}

// ---- comments on tasks -----------------------------------------------------

/** What lastCommentPreview holds: the first ~120 characters (02-taakmodel §1.1). */
export const COMMENT_PREVIEW_LENGTH = 120;

/**
 * One line for the card: whitespace collapsed, cut near `max` characters on a
 * word boundary when one is close enough, with an ellipsis marking the cut.
 */
export function commentPreview(body: string, max: number = COMMENT_PREVIEW_LENGTH): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface CommentOutcome {
  commentId: string;
  taskId: string;
  lastCommentAt: string;
  preview: string;
}

/**
 * A comment is a `comment` record hanging off the task, PLUS the two derived
 * fields on the card (lastCommentAt/lastCommentPreview) that stand in for
 * Trello's comment badge. When the PATCH fails the comment is NOT rolled back:
 * the comment is the substance, the card fields are derived — failing loudly
 * beats losing what was said.
 */
export async function createCommentOnTask(
  client: RestClient,
  taskId: string,
  bodyText: string,
  now: Date = new Date(),
): Promise<CommentOutcome> {
  const preview = commentPreview(bodyText);
  const created = await client.request("/rest/comments", {
    method: "POST",
    // `name` is the record label the UI shows in chips and lists; without it
    // every comment reads "Untitled".
    body: { body: bodyText, name: preview, taskId },
  });
  const commentId = extractId(created);
  if (!commentId) throw new RecordWriteError("Creating the comment failed: no id came back.");
  const lastCommentAt = now.toISOString();
  try {
    await client.request(`/rest/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: { lastCommentAt, lastCommentPreview: preview },
    });
  } catch (err) {
    throw new RecordWriteError(
      `Comment ${commentId} was created, but stamping lastCommentAt/lastCommentPreview on task ${taskId} ` +
      `failed: ${String(err)}. The comment stands; re-run or fix the card by hand.`,
    );
  }
  return { commentId, taskId, lastCommentAt, preview };
}

/**
 * Same contract as createNoteWithTargets: a task that was meant to hang off a
 * company/person/opportunity but lost its link is a card nobody finds, so a
 * failed link removes the task again. A task without any target is fine — the
 * board also holds plain to-dos.
 */
export async function createTaskWithTargets(
  client: RestClient,
  body: Record<string, unknown>,
  targets: TaskTargets,
  baseUrl: string,
): Promise<WriteOutcome> {
  const created = await client.request(`/rest/tasks`, { method: "POST", body });
  const id = extractId(created);
  if (!id) throw new RecordWriteError("Creating the task failed: no id came back.");
  try {
    await createTargetsForRecord(
      client, "task", id,
      targets.personId ? [targets.personId] : [],
      targets.companyId ? [targets.companyId] : [],
      targets.opportunityId ? [targets.opportunityId] : [],
    );
  } catch (err) {
    await client.request(`/rest/tasks/${id}`, { method: "DELETE" }).catch(() => {});
    throw new RecordWriteError(
      `Linking the task to its record failed, so task ${id} was removed again: ${String(err)}`,
    );
  }
  return { action: "create", object: "tasks", id, url: recordUrl(baseUrl, "task", id) };
}

/** The "linked to …" lines a create confirms, for dry-run and success alike. */
export function describeTaskTargets(targets: TaskTargets): string[] {
  return [
    targets.companyId ? `linked to company ${targets.companyId}` : null,
    targets.personId ? `linked to person ${targets.personId}` : null,
    targets.opportunityId ? `linked to opportunity ${targets.opportunityId}` : null,
  ].filter((l): l is string => l !== null);
}

// ---- opportunities --------------------------------------------------------

/**
 * One open opportunity per company. Three cards for one deal is the failure mode
 * this guard exists for; `--force` is the escape hatch for a genuinely second
 * track running alongside the first.
 */
export async function findOpenOpportunities(
  client: RestClient, companyId: string,
): Promise<Array<{ id: string; stage: string; name: string }>> {
  const result = await client.request<{
    data?: { opportunities?: Array<{ id: string; stage: string; name: string }> };
  }>(`/rest/opportunities?limit=50&filter=companyId[eq]:${companyId}`);
  const all = result?.data?.opportunities ?? [];
  return all.filter((o) => (OPEN_STAGES as readonly string[]).includes(o.stage));
}

/**
 * A note without a target is unfindable clutter in the CRM, so the link is part
 * of creating it: if linking fails the note is removed again.
 */
export async function createNoteWithTargets(
  client: RestClient,
  body: Record<string, unknown>,
  targets: { companyId?: string; personId?: string },
  baseUrl: string,
): Promise<WriteOutcome> {
  const created = await client.request(`/rest/notes`, { method: "POST", body });
  const id = extractId(created);
  if (!id) throw new RecordWriteError("Creating the note failed: no id came back.");
  try {
    await createTargetsForRecord(
      client, "note", id,
      targets.personId ? [targets.personId] : [],
      targets.companyId ? [targets.companyId] : [],
    );
  } catch (err) {
    await client.request(`/rest/notes/${id}`, { method: "DELETE" }).catch(() => {});
    throw new RecordWriteError(
      `Linking the note to its record failed, so note ${id} was removed again: ${String(err)}`,
    );
  }
  return { action: "create", object: "notes", id, url: recordUrl(baseUrl, "note", id) };
}

export function requireCreateFields(
  object: WritableObject,
  flags: PersonFlags & CompanyFlags & OpportunityFlags,
): void {
  if (object === "companies" && !flags.name?.trim()) {
    throw new RecordWriteError("cato companies create needs --name.");
  }
  if (object === "people" && !flags.firstName?.trim() && !flags.lastName?.trim() && !flags.email?.trim()) {
    throw new RecordWriteError("cato people create needs at least --first-name, --last-name or --email.");
  }
  if (object === "opportunities") {
    if (!flags.name?.trim()) throw new RecordWriteError("cato opportunities create needs --name.");
    if (!flags.companyId?.trim()) {
      throw new RecordWriteError("cato opportunities create needs --company-id — an opportunity without a company is invisible in the pipeline.");
    }
    if (!flags.stage?.trim()) throw new RecordWriteError("cato opportunities create needs --stage.");
  }
}

/**
 * Twenty's "Sales Rep" role scopes Person visibility by
 * `assigneeId IS currentWorkspaceMember`. A person created against a company
 * without inheriting that company's accountOwnerId is invisible to the rep who
 * owns the account — so we inherit it unless the caller said otherwise.
 */
export async function resolveAssignee(
  client: RestClient,
  flags: PersonFlags,
): Promise<{ assigneeId?: string; inheritedFrom?: string }> {
  if (flags.assigneeId) return { assigneeId: flags.assigneeId };
  if (!flags.companyId) return {};

  const result = await client.request<{ data?: { company?: { accountOwnerId?: string | null } } }>(
    `/rest/companies/${flags.companyId}`,
  );
  const owner = result?.data?.company?.accountOwnerId;
  return owner ? { assigneeId: owner, inheritedFrom: flags.companyId } : {};
}

export interface WriteOutcome {
  action: "create" | "update" | "delete";
  object: WritableObject;
  id?: string;
  url?: string;
}

export async function createRecord(
  client: RestClient, object: WritableObject, body: Record<string, unknown>, baseUrl: string,
): Promise<WriteOutcome> {
  const singular = SINGULAR[object];
  const created = await client.request<Record<string, { [k: string]: { id?: string } }>>(
    `/rest/${object}`, { method: "POST", body },
  );
  const id = created?.data?.[`create${singular[0]!.toUpperCase()}${singular.slice(1)}`]?.id;
  return { action: "create", object, id, url: id ? recordUrl(baseUrl, singular, id) : undefined };
}

export async function updateRecord(
  client: RestClient, object: WritableObject, id: string,
  body: Record<string, unknown>, baseUrl: string,
): Promise<WriteOutcome> {
  await client.request(`/rest/${object}/${id}`, { method: "PATCH", body });
  return { action: "update", object, id, url: recordUrl(baseUrl, SINGULAR[object], id) };
}

export async function deleteRecord(
  client: RestClient, object: WritableObject, id: string,
): Promise<WriteOutcome> {
  await client.request(`/rest/${object}/${id}`, { method: "DELETE" });
  return { action: "delete", object, id };
}

/**
 * Wat een geslaagde schrijfactie terugmeldt. `import` en `auth` doen dit al zo:
 * een leesbare zin plus een klikbare URL, tenzij de caller --json/--csv vroeg.
 * De record-schrijfacties gaven alleen een JSON-blob terug die niet vertelde
 * wát er geschreven was — na `--stage ON_HOLD` kon je aan de uitvoer niet zien
 * of de stage nu ON_HOLD was. De dry-run toonde de body, de echte actie niet.
 */
export function summariseBody(body: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (key === "bodyV2") { parts.push("body: (rich text)"); continue; }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.amountMicros === "number") {
        const eur = (obj.amountMicros / 1_000_000).toLocaleString("nl-NL");
        parts.push(`${key}: € ${eur}`);
        continue;
      }
      for (const [sub, subValue] of Object.entries(obj)) {
        if (subValue === null || subValue === undefined || subValue === "") continue;
        parts.push(`${sub}: ${String(subValue)}`);
      }
      continue;
    }
    parts.push(`${key}: ${String(value)}`);
  }
  return parts;
}

export function renderWriteSuccess(
  outcome: WriteOutcome,
  body: Record<string, unknown> | null,
  extra: string[] = [],
): string {
  const verb = { create: "Created", update: "Updated", delete: "Deleted" }[outcome.action];
  const lines = [`${verb} ${SINGULAR[outcome.object]} ${outcome.id ?? "(no id returned)"}`];
  const fields = body ? summariseBody(body) : [];
  for (const f of fields) lines.push(`  ${f}`);
  for (const e of extra) lines.push(`  ${e}`);
  if (outcome.url) lines.push("", outcome.url);
  return lines.join("\n");
}

export function renderWriteDryRun(
  action: "create" | "update" | "delete",
  object: WritableObject,
  body: Record<string, unknown> | null,
  id?: string,
  inheritedFrom?: string,
  /** Extra lines (e.g. "linked to company …") shown before the footer. */
  extra: readonly string[] = [],
): string {
  const lines = [
    `DRY RUN — no ${SINGULAR[object]} was ${action}d.`,
    "",
    `Object: ${object}`,
  ];
  if (id) lines.push(`Id    : ${id}`);
  if (body) lines.push("Body  :", ...JSON.stringify(body, null, 2).split("\n").map((l) => `  ${l}`));
  for (const line of extra) lines.push(`  ${line}`);
  if (inheritedFrom) {
    lines.push("", `Assignee inherited from company ${inheritedFrom}, so the record stays visible`,
      "to the rep who owns that account.");
  }
  if (action === "delete") {
    // This used to promise "it is only a soft delete". It is not. Twenty's REST
    // delete takes a `soft_delete` query parameter that DEFAULTS TO FALSE — see
    // cli/openapi/cato.yaml, generated from the live CRM: "If true, soft deletes
    // the objects. If false, objects are permanently deleted." deleteRecord()
    // never sends it, so every delete this CLI performs is permanent, for every
    // object. Measured on CATO v1.19, 2026-08-25: a probe task was gone from the
    // workspace schema straight after, while 310 UI-soft-deleted rows sat there
    // untouched. Telling an operator a permanent action is reversible is the
    // worse error, so the dry run now says what actually happens.
    lines.push("",
      `Deleting is permanent: the ${SINGULAR[object]} leaves the database and cannot be restored.`,
      "(The trash in the CATO web UI is a soft delete; this is not.)");
  }
  lines.push("", "Re-run with --no-dry-run --yes to apply.");
  return lines.join("\n");
}
