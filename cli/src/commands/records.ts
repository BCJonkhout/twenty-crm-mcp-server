// Read commands for the four core objects: people, companies, opportunities, notes.

import { buildListQuery, iterRecords, type RestClient, type TwentyRecord } from "@twenty-crm/core";
import {
  buildCompanyFilter, buildNoteFilter, buildOpportunityFilter, buildPeopleFilter,
} from "../filters.ts";
import { flagBool, flagList, flagNumber, flagString, type FlagValue } from "../args.ts";
import { render, renderOne } from "../output.ts";
import { DEFAULT_BASE_URL, withUrls } from "../urls.ts";

export const DEFAULT_LIMIT = 20;
/** Twenty caps a REST page at 200 (v1.19). Paging above that is our job, not the server's. */
export const MAX_PAGE = 200;

export const DEFAULT_COLUMNS = {
  people: ["id", "name.firstName", "name.lastName", "emails.primaryEmail", "jobTitle", "companyId", "branche", "salesStatus"],
  companies: ["id", "name", "domainName.primaryLinkUrl", "address.addressCity", "employees", "branche", "prudaiMarketingSourceSegment"],
  opportunities: ["id", "name", "stage", "closeDate", "amount.amountMicros", "companyId", "ownerId"],
  notes: ["id", "title", "createdAt", "assigneeId"],
} as const;

export type ObjectPath = keyof typeof DEFAULT_COLUMNS;

export interface ListInvocation {
  objectPath: ObjectPath;
  filter: string | null;
  limit: number;
  orderBy?: string;
  depth?: number;
  fetchAll: boolean;
  /** True only when the caller passed --limit themselves. See fetchRecords. */
  limitExplicit?: boolean;
}

/**
 * Pure: flags -> list invocation. Kept separate from the network call so the
 * filter/limit logic is testable without touching production.
 */
export function planList(objectPath: ObjectPath, flags: Record<string, FlagValue>): ListInvocation {
  const includeDeleted = flagBool(flags, "include-deleted") === true;
  const raw = flagString(flags, "filter");
  // A free-text term becomes part of the filter. It used to be handed to the
  // server as `search=`, which Twenty ignores — every record came back and
  // looked like a hit list. See searchExpr() in @twenty-crm/core.
  const search = flagString(flags, "query");

  let filter: string | null;
  switch (objectPath) {
    case "people":
      filter = buildPeopleFilter({
        companyId: flagString(flags, "company-id"),
        jobTitle: flagString(flags, "job-title"),
        city: flagString(flags, "city"),
        segment: flagString(flags, "segment"),
        sourceSystem: flagString(flags, "source-system"),
        outreachState: flagString(flags, "outreach-state"),
        branche: flagString(flags, "branche"),
        product: flagList(flags, "product"),
        salesStatus: flagString(flags, "sales-status"),
        visibility: flagString(flags, "visibility"),
        emailDomain: flagString(flags, "email-domain"),
        hasEmail: flagBool(flags, "has-email"),
        contactable: flagBool(flags, "contactable"),
        createdSince: flagString(flags, "created-since"),
        updatedSince: flagString(flags, "updated-since"),
        search,
        raw,
        includeDeleted,
      });
      break;
    case "companies":
      filter = buildCompanyFilter({
        name: flagString(flags, "name"),
        city: flagString(flags, "city"),
        cities: flagList(flags, "cities"),
        domain: flagString(flags, "domain"),
        branche: flagString(flags, "branche"),
        product: flagList(flags, "product"),
        segment: flagString(flags, "segment"),
        sourceSystem: flagString(flags, "source-system"),
        visibility: flagString(flags, "visibility"),
        minEmployees: flagNumber(flags, "min-employees"),
        maxEmployees: flagNumber(flags, "max-employees"),
        idealCustomerProfile: flagBool(flags, "icp"),
        createdSince: flagString(flags, "created-since"),
        search,
        raw,
        includeDeleted,
      });
      break;
    case "opportunities":
      filter = buildOpportunityFilter({
        name: flagString(flags, "name"),
        stage: flagString(flags, "stage"),
        companyId: flagString(flags, "company-id"),
        ownerId: flagString(flags, "owner-id"),
        closeAfter: flagString(flags, "close-after"),
        closeBefore: flagString(flags, "close-before"),
        search,
        raw,
        includeDeleted,
      });
      break;
    case "notes":
      filter = buildNoteFilter({
        title: flagString(flags, "title"),
        assigneeId: flagString(flags, "assignee-id"),
        createdSince: flagString(flags, "created-since"),
        search,
        raw,
        includeDeleted,
      });
      break;
  }

  const explicitLimit = flagNumber(flags, "limit");
  return {
    objectPath,
    filter,
    limit: explicitLimit ?? DEFAULT_LIMIT,
    limitExplicit: explicitLimit !== undefined,
    orderBy: flagString(flags, "order-by"),
    depth: flagNumber(flags, "depth"),
    fetchAll: flagBool(flags, "all") === true,
  };
}

export async function fetchRecords(client: RestClient, plan: ListInvocation): Promise<TwentyRecord[]> {
  if (plan.fetchAll) {
    // `--all` means every match. It used to stop at plan.limit, which defaults
    // to 20 when nobody passed --limit — so `--all` silently returned 20 rows
    // and called it complete, the exact opposite of what its help promises.
    // An explicit --limit alongside --all is still honoured as a deliberate cap.
    const cap = plan.limitExplicit ? plan.limit : Infinity;
    const out: TwentyRecord[] = [];
    const iterator = iterRecords(client, plan.objectPath, {
      filter: plan.filter,
      order_by: plan.orderBy,
      depth: plan.depth,
      limit: MAX_PAGE,
      include_deleted: true, // soft-delete guard already baked into plan.filter
    });
    for await (const record of iterator) {
      out.push(record);
      if (out.length >= cap) break;
    }
    return out;
  }

  const qs = buildListQuery({
    filter: plan.filter,
    order_by: plan.orderBy,
    depth: plan.depth,
    limit: Math.min(plan.limit, MAX_PAGE),
    include_deleted: true,
  });
  const result = await client.request<{ data?: Record<string, TwentyRecord[]> }>(
    `/rest/${plan.objectPath}${qs}`,
  );
  return result?.data?.[plan.objectPath] ?? [];
}

export interface RenderContext {
  json: boolean;
  csv: boolean;
  /** Base URL of the CATO web app; used to make every record clickable. */
  baseUrl?: string;
}

export async function runList(
  client: RestClient,
  objectPath: ObjectPath,
  flags: Record<string, FlagValue>,
  ctx: RenderContext,
): Promise<string> {
  const plan = planList(objectPath, flags);
  const rows = await fetchRecords(client, plan);
  const linked = withUrls(rows as Record<string, unknown>[], ctx.baseUrl ?? DEFAULT_BASE_URL, objectPath);
  const columns = flagList(flags, "fields") ?? [...DEFAULT_COLUMNS[objectPath], "url"];
  return render(linked as TwentyRecord[], {
    json: ctx.json, csv: ctx.csv, columns: ctx.json ? undefined : columns,
  });
}

export async function runGet(
  client: RestClient,
  objectPath: ObjectPath,
  id: string,
  flags: Record<string, FlagValue>,
  ctx: RenderContext,
): Promise<string> {
  const depth = flagNumber(flags, "depth");
  const qs = depth === undefined ? "" : `?depth=${depth}`;
  const result = await client.request<{ data?: Record<string, TwentyRecord> }>(
    `/rest/${objectPath}/${id}${qs}`,
  );
  const singular = SINGULAR[objectPath];
  const row = result?.data?.[singular] ?? null;
  const linked = row
    ? withUrls([row as Record<string, unknown>], ctx.baseUrl ?? DEFAULT_BASE_URL, objectPath)[0]
    : null;
  const columns = flagList(flags, "fields");
  return renderOne(linked as TwentyRecord | null, { json: ctx.json, csv: ctx.csv, columns });
}

const SINGULAR: Record<ObjectPath, string> = {
  people: "person",
  companies: "company",
  opportunities: "opportunity",
  notes: "note",
};
