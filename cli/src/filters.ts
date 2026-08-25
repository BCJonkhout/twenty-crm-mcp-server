// Filter builders: turn CLI flags into Twenty's native filter grammar.
//
// Every field name and every enum value below was read out of the live
// metadata / OpenAPI surface of crm.prudai.com (image prudai/twenty:v1.19.0-
// marketing), not guessed. See cli/openapi/cato.yaml, which is generated from
// the same source.

import { andExpr, clause, combineWithSoftDelete, orExpr, searchExpr } from "@twenty-crm/core";

/** MULTI_SELECT `product` on person and company. */
export const PRODUCT_VALUES = ["LEO", "VERA", "ZIA", "BEVER", "IRMA", "ORDO", "CATO"] as const;

/** SELECT `branche` on person and company. */
export const BRANCHE_VALUES = ["ADVOCATUUR", "ARCHITECTUUR", "OVERHEID", "WONINGCORPORATIE"] as const;

/** SELECT `salesStatus` on person. */
export const SALES_STATUS_VALUES = [
  "TODO", "ON_HOLD", "SUCCESS", "REJECTED", "CALL", "LINKEDIN", "DEMO", "TEST_ACCOUNT",
] as const;

/** SELECT `visibility` on person and company. */
export const VISIBILITY_VALUES = ["MARKETING", "RESTRICTED"] as const;

/** SELECT `stage` on opportunity. */
export const OPPORTUNITY_STAGE_VALUES = ["NEW", "SCREENING", "MEETING", "PROPOSAL", "PILOT", "ON_HOLD", "CUSTOMER", "VERLOREN"] as const;

/**
 * SELECT `status` on task — the four the task board uses (metadata field
 * 3f4bf3f2-1236-4c77-a1f5-241ba4eb64df; four legacy options are being removed
 * on 2026-08-24). Unlike the stage enum this list is NOT enforced: the value is
 * normalised and passed through, and CATO's field metadata decides. An unknown
 * value comes back as HTTP 400 with the enum message, so a status added in the
 * UI never waits for a CLI release — and a typo is still refused, by the CRM.
 */
export const TASK_STATUS_VALUES = ["TODO", "IN_PROGRESS", "ON_HOLD", "DONE"] as const;

/** `in progress`, `in-progress`, `In_Progress` → `IN_PROGRESS`. */
export function normaliseTaskStatus(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function isKnownTaskStatus(value: string): boolean {
  return (TASK_STATUS_VALUES as readonly string[]).includes(normaliseTaskStatus(value));
}

export class FilterError extends Error {}

// The `is` operator takes the bare tokens NULL / NOT_NULL — quoting them
// (as escapeFilterValue would) makes Twenty reject the filter.
export function isNull(field: string): string {
  return `${field}[is]:NULL`;
}

export function isNotNull(field: string): string {
  return `${field}[is]:NOT_NULL`;
}

function requireEnum(flag: string, value: string, allowed: readonly string[]): string {
  const upper = value.toUpperCase();
  if (!allowed.includes(upper)) {
    throw new FilterError(`--${flag}: '${value}' is not a valid value. Allowed: ${allowed.join(", ")}.`);
  }
  return upper;
}

function requireEnumList(flag: string, values: readonly string[], allowed: readonly string[]): string[] {
  return values.map((v) => requireEnum(flag, v, allowed));
}

// ---- people ---------------------------------------------------------------

export interface PeopleFilterInput {
  companyId?: string;
  jobTitle?: string;
  city?: string;
  segment?: string;
  sourceSystem?: string;
  branche?: string;
  product?: string[];
  salesStatus?: string;
  visibility?: string;
  outreachState?: string;
  emailDomain?: string;
  hasEmail?: boolean;
  /** Excludes doNotContact and anyone who opted out — the marketing-safe set. */
  contactable?: boolean;
  createdSince?: string;
  updatedSince?: string;
  /** Free-text term — AND-ed in as an ilike OR over the person's name/email. */
  search?: string;
  /** Raw Twenty filter expression, AND-ed with everything else. */
  raw?: string;
  includeDeleted?: boolean;
}

export function buildPeopleFilter(input: PeopleFilterInput): string | null {
  const parts: Array<string | null> = [];

  if (input.companyId) parts.push(clause("companyId", "eq", input.companyId));
  if (input.jobTitle) parts.push(clause("jobTitle", "ilike", `%${input.jobTitle}%`));
  if (input.city) parts.push(clause("city", "ilike", `%${input.city}%`));
  if (input.segment) parts.push(clause("prudaiMarketingSourceSegment", "eq", input.segment));
  if (input.sourceSystem) parts.push(clause("prudaiMarketingSourceSystem", "eq", input.sourceSystem));
  if (input.outreachState) parts.push(clause("prudaiMarketingOutreachState", "eq", input.outreachState));
  if (input.branche) parts.push(clause("branche", "eq", requireEnum("branche", input.branche, BRANCHE_VALUES)));
  if (input.salesStatus) {
    parts.push(clause("salesStatus", "eq", requireEnum("sales-status", input.salesStatus, SALES_STATUS_VALUES)));
  }
  if (input.visibility) {
    parts.push(clause("visibility", "eq", requireEnum("visibility", input.visibility, VISIBILITY_VALUES)));
  }
  if (input.product && input.product.length > 0) {
    // MULTI_SELECT arrays use [containsAny]:[a,b] — verified against
    // twenty-server parse-base-filter.util.ts (BaseComparator.containsAny).
    const values = requireEnumList("product", input.product, PRODUCT_VALUES);
    parts.push(`product[containsAny]:[${values.join(",")}]`);
  }
  if (input.emailDomain) {
    const domain = input.emailDomain.replace(/^@/, "");
    parts.push(clause("emails.primaryEmail", "ilike", `%@${domain}`));
  }
  if (input.hasEmail) parts.push(isNotNull("emails.primaryEmail"));
  if (input.contactable) {
    // Person-level suppression, mirroring buildContactablePersonClause() in the
    // Twenty fork: no doNotContact flag and no marketing opt-out timestamp.
    // doNotContact is nullable, and NULL means "never flagged" — so the guard
    // has to accept NULL as well as false, or every contact that was never
    // touched drops out of the segment.
    parts.push(orExpr(isNull("doNotContact"), clause("doNotContact", "eq", false)));
    parts.push(isNull("marketingOptOutAt"));
    parts.push(isNotNull("emails.primaryEmail"));
  }
  if (input.createdSince) parts.push(clause("createdAt", "gte", isoDate("created-since", input.createdSince)));
  if (input.updatedSince) parts.push(clause("updatedAt", "gte", isoDate("updated-since", input.updatedSince)));
  if (input.search) parts.push(searchExpr("people", input.search));
  if (input.raw) parts.push(input.raw);

  return combineWithSoftDelete(andExpr(...parts), input.includeDeleted === true);
}

// ---- companies ------------------------------------------------------------

export interface CompanyFilterInput {
  name?: string;
  city?: string;
  cities?: string[];
  domain?: string;
  branche?: string;
  product?: string[];
  segment?: string;
  sourceSystem?: string;
  visibility?: string;
  minEmployees?: number;
  maxEmployees?: number;
  idealCustomerProfile?: boolean;
  createdSince?: string;
  /** Free-text term — AND-ed in as an ilike OR over company name/domain. */
  search?: string;
  raw?: string;
  includeDeleted?: boolean;
}

export function buildCompanyFilter(input: CompanyFilterInput): string | null {
  const parts: Array<string | null> = [];

  if (input.name) parts.push(clause("name", "ilike", `%${input.name}%`));
  if (input.city) parts.push(clause("address.addressCity", "ilike", `%${input.city}%`));
  if (input.cities && input.cities.length > 0) {
    parts.push(orExpr(...input.cities.map((c) => clause("address.addressCity", "eq", c))));
  }
  if (input.domain) parts.push(clause("domainName.primaryLinkUrl", "ilike", `%${input.domain}%`));
  if (input.branche) parts.push(clause("branche", "eq", requireEnum("branche", input.branche, BRANCHE_VALUES)));
  if (input.product && input.product.length > 0) {
    const values = requireEnumList("product", input.product, PRODUCT_VALUES);
    parts.push(`product[containsAny]:[${values.join(",")}]`);
  }
  if (input.segment) parts.push(clause("prudaiMarketingSourceSegment", "eq", input.segment));
  if (input.sourceSystem) parts.push(clause("prudaiMarketingSourceSystem", "eq", input.sourceSystem));
  if (input.visibility) {
    parts.push(clause("visibility", "eq", requireEnum("visibility", input.visibility, VISIBILITY_VALUES)));
  }
  if (input.minEmployees !== undefined) parts.push(clause("employees", "gte", input.minEmployees));
  if (input.maxEmployees !== undefined) parts.push(clause("employees", "lte", input.maxEmployees));
  if (input.idealCustomerProfile !== undefined) {
    parts.push(clause("idealCustomerProfile", "eq", input.idealCustomerProfile));
  }
  if (input.createdSince) parts.push(clause("createdAt", "gte", isoDate("created-since", input.createdSince)));
  if (input.search) parts.push(searchExpr("companies", input.search));
  if (input.raw) parts.push(input.raw);

  return combineWithSoftDelete(andExpr(...parts), input.includeDeleted === true);
}

// ---- opportunities --------------------------------------------------------

export interface OpportunityFilterInput {
  name?: string;
  stage?: string;
  companyId?: string;
  ownerId?: string;
  closeBefore?: string;
  closeAfter?: string;
  /** Free-text term — AND-ed in as an ilike over the opportunity name. */
  search?: string;
  raw?: string;
  includeDeleted?: boolean;
}

export function buildOpportunityFilter(input: OpportunityFilterInput): string | null {
  const parts: Array<string | null> = [];

  if (input.name) parts.push(clause("name", "ilike", `%${input.name}%`));
  if (input.stage) {
    parts.push(clause("stage", "eq", requireEnum("stage", input.stage, OPPORTUNITY_STAGE_VALUES)));
  }
  if (input.companyId) parts.push(clause("companyId", "eq", input.companyId));
  if (input.ownerId) parts.push(clause("ownerId", "eq", input.ownerId));
  if (input.closeAfter) parts.push(clause("closeDate", "gte", isoDate("close-after", input.closeAfter)));
  if (input.closeBefore) parts.push(clause("closeDate", "lte", isoDate("close-before", input.closeBefore)));
  if (input.search) parts.push(searchExpr("opportunities", input.search));
  if (input.raw) parts.push(input.raw);

  return combineWithSoftDelete(andExpr(...parts), input.includeDeleted === true);
}

// ---- notes ----------------------------------------------------------------

export interface NoteFilterInput {
  title?: string;
  assigneeId?: string;
  createdSince?: string;
  /** Free-text term — AND-ed in as an ilike over the note title. */
  search?: string;
  raw?: string;
  includeDeleted?: boolean;
}

export function buildNoteFilter(input: NoteFilterInput): string | null {
  const parts: Array<string | null> = [];

  if (input.title) parts.push(clause("title", "ilike", `%${input.title}%`));
  if (input.assigneeId) parts.push(clause("assigneeId", "eq", input.assigneeId));
  if (input.createdSince) parts.push(clause("createdAt", "gte", isoDate("created-since", input.createdSince)));
  if (input.search) parts.push(searchExpr("notes", input.search));
  if (input.raw) parts.push(input.raw);

  return combineWithSoftDelete(andExpr(...parts), input.includeDeleted === true);
}

// ---- tasks ----------------------------------------------------------------

export interface TaskFilterInput {
  status?: string;
  assigneeId?: string;
  /** Inclusive: a bare day means "due on or before that day". */
  dueBefore?: string;
  dueAfter?: string;
  /** Due date in the past and not DONE (a task without a status counts as open). */
  overdue?: boolean;
  /** Reference instant for --overdue; injectable so the filter is testable. */
  now?: Date;
  /** Free-text term — AND-ed in as an ilike over the task title. */
  search?: string;
  raw?: string;
  includeDeleted?: boolean;
}

export function buildTaskFilter(input: TaskFilterInput): string | null {
  const parts: Array<string | null> = [];

  if (input.status) {
    const status = normaliseTaskStatus(input.status);
    if (input.overdue && status === "DONE") {
      throw new FilterError("--overdue only covers open tasks; drop --status DONE.");
    }
    parts.push(clause("status", "eq", status));
  }
  if (input.assigneeId) parts.push(clause("assigneeId", "eq", input.assigneeId));
  if (input.dueAfter) parts.push(clause("dueAt", "gte", isoDate("due-after", input.dueAfter)));
  if (input.dueBefore) {
    // "before 4 September" on a task board means "by the end of the 4th", so a
    // bare day becomes a strict bound on the next midnight. A full timestamp
    // is taken literally.
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.dueBefore)) {
      parts.push(clause("dueAt", "lt", nextDayIso(input.dueBefore)));
    } else {
      parts.push(clause("dueAt", "lte", isoDate("due-before", input.dueBefore)));
    }
  }
  if (input.overdue) {
    const now = (input.now ?? new Date()).toISOString();
    parts.push(clause("dueAt", "lt", now));
    // A NULL status is an open task too: status[neq] alone would drop it.
    parts.push(orExpr(isNull("status"), clause("status", "neq", "DONE")));
  }
  if (input.search) parts.push(searchExpr("tasks", input.search));
  if (input.raw) parts.push(input.raw);

  return combineWithSoftDelete(andExpr(...parts), input.includeDeleted === true);
}

function nextDayIso(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new FilterError(`--due-before: '${day}' is not a valid date. Use YYYY-MM-DD or an ISO timestamp.`);
  }
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// ---- helpers --------------------------------------------------------------

/**
 * Accept both `2026-07-01` and a full ISO timestamp; reject anything else
 * loudly rather than shipping `Invalid Date` into a production query.
 */
/** `2026-09-04T10:00`, `2026-09-04 10:00:30.5`, `…Z`, `…+02:00` — but nothing else. */
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A date flag takes YYYY-MM-DD or an ISO-8601 timestamp — and nothing else.
 * `new Date()` alone is far too willing: it reads `04-09-2026` as 9 April 2026
 * and `2026-02-30` as 2 March, so a mistyped `--due-before` used to return a
 * confident answer about the wrong month instead of an error.
 */
export function isoDate(flag: string, value: string): string {
  const v = value.trim();
  const reject = () => {
    throw new FilterError(
      `--${flag}: '${value}' is not a valid date. Use YYYY-MM-DD or an ISO-8601 timestamp (2026-09-04T10:00:00Z).`,
    );
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const day = new Date(`${v}T00:00:00.000Z`);
    // Round-trip catches the days that do not exist (2026-02-30 → 2 March).
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== v) reject();
    return `${v}T00:00:00.000Z`;
  }
  if (ISO_TIMESTAMP_RE.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  reject();
  throw new Error("unreachable");
}
