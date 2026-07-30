// The write half of `cato import`.
//
// Deliberately narrow: it tags companies with where we found them, and creates
// the ones we do not have yet. It does not touch email addresses, ownership,
// lifecycle state or anything the marketing engine reads to decide who gets
// mail. Loading a list is not the same as deciding to contact it.

import type { RestClient } from "@twenty-crm/core";
import { recordUrl } from "../urls.ts";

/** One row of the source list, already mapped onto what we intend to store. */
export interface ImportRow {
  name: string;
  sourceSegment?: string;
  sourceSystem?: string;
  sourceUrl?: string;
  /** Free-form provenance; stored as JSON on prudaiMarketingSourceContext. */
  context?: Record<string, unknown>;
}

export type ImportAction = "create" | "tag" | "skip";

export interface ImportOutcome {
  name: string;
  action: ImportAction;
  id?: string;
  url?: string;
  reason?: string;
}

/**
 * Company names are written inconsistently across sources ("OAK advocaten B.V."
 * vs "Oak Advocaten"), so matching on the raw string would create duplicates in
 * a CRM that already holds ~14k companies.
 */
export function matchKey(name: string): string {
  const stripped = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const withoutSuffixes = stripped.replace(
    /\b(advocaten|advocatuur|advocatenkantoor|juristen|b\.?v\.?|n\.?v\.?|law|legal|groep|group|partners)\b/g,
    " ",
  );
  return withoutSuffixes.replace(/[^a-z0-9]+/g, "");
}

/** Builds the field payload. Only ever the provenance fields — never contact data. */
export function buildPayload(row: ImportRow): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: row.name };
  if (row.sourceSegment) payload.prudaiMarketingSourceSegment = row.sourceSegment;
  if (row.sourceSystem) payload.prudaiMarketingSourceSystem = row.sourceSystem;
  if (row.sourceUrl) payload.prudaiMarketingSourceUrl = row.sourceUrl;
  if (row.context && Object.keys(row.context).length > 0) {
    payload.prudaiMarketingSourceContext = row.context;
  }
  return payload;
}

/** A tag-only payload leaves `name` alone so we never rename an existing record. */
export function buildTagPayload(row: ImportRow): Record<string, unknown> {
  const { name: _ignored, ...rest } = buildPayload(row);
  return rest;
}

export interface ExistingCompany {
  id: string;
  name: string;
}

/**
 * Decides per row what should happen, given what CATO already holds.
 * Pure, so the plan can be shown and reviewed before anything is written.
 */
export function planWrites(
  rows: ImportRow[],
  existing: ExistingCompany[],
): Array<{ row: ImportRow; action: ImportAction; existingId?: string; existingName?: string }> {
  const byKey = new Map<string, ExistingCompany>();
  for (const company of existing) {
    const key = matchKey(company.name);
    if (key && !byKey.has(key)) byKey.set(key, company);
  }

  const seenInBatch = new Set<string>();
  return rows.map((row) => {
    const key = matchKey(row.name);
    if (!key) return { row, action: "skip" as const };
    const hit = byKey.get(key);
    if (hit) return { row, action: "tag" as const, existingId: hit.id, existingName: hit.name };
    if (seenInBatch.has(key)) return { row, action: "skip" as const };
    seenInBatch.add(key);
    return { row, action: "create" as const };
  });
}

/** Executes a plan. Callers must have resolved the write gate already. */
export async function executeWrites(
  client: RestClient,
  plan: ReturnType<typeof planWrites>,
  baseUrl: string,
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];

  for (const step of plan) {
    if (step.action === "skip") {
      outcomes.push({ name: step.row.name, action: "skip", reason: "no usable name, or duplicate within the file" });
      continue;
    }

    try {
      if (step.action === "tag" && step.existingId) {
        await client.request(`/rest/companies/${step.existingId}`, {
          method: "PATCH",
          body: buildTagPayload(step.row),
        });
        outcomes.push({
          name: step.row.name,
          action: "tag",
          id: step.existingId,
          url: recordUrl(baseUrl, "company", step.existingId),
          reason: `matched existing '${step.existingName}'`,
        });
        continue;
      }

      const created = await client.request<{ data?: { createCompany?: { id?: string } } }>(
        "/rest/companies",
        { method: "POST", body: buildPayload(step.row) },
      );
      const id = created?.data?.createCompany?.id;
      outcomes.push({
        name: step.row.name,
        action: "create",
        id,
        url: id ? recordUrl(baseUrl, "company", id) : undefined,
      });
    } catch (err) {
      outcomes.push({
        name: step.row.name,
        action: "skip",
        reason: `failed: ${(err as Error).message.slice(0, 200)}`,
      });
    }
  }

  return outcomes;
}

export function renderWritePlan(
  plan: ReturnType<typeof planWrites>,
  sourceSystem: string,
  json: boolean,
): string {
  const creates = plan.filter((p) => p.action === "create");
  const tags = plan.filter((p) => p.action === "tag");
  const skips = plan.filter((p) => p.action === "skip");

  if (json) {
    return JSON.stringify(
      { sourceSystem, create: creates.length, tag: tags.length, skip: skips.length,
        rows: plan.map((p) => ({ name: p.row.name, action: p.action, existing: p.existingName })) },
      null, 2,
    );
  }

  const lines = [
    "DRY RUN — nothing was written to CATO.",
    "",
    `Source system : ${sourceSystem}`,
    `Would create  : ${creates.length} new compan${creates.length === 1 ? "y" : "ies"}`,
    `Would tag     : ${tags.length} existing (provenance fields only, name untouched)`,
    `Would skip    : ${skips.length}`,
    "",
    "Writes only: prudaiMarketingSourceSegment / SourceSystem / SourceUrl / SourceContext.",
    "No email addresses, no owners, no outreach state, no campaign membership.",
    "",
    "Re-run with --no-dry-run --yes to apply.",
  ];
  if (tags.length > 0) {
    lines.push("", "Examples of matches against existing records:");
    for (const t of tags.slice(0, 8)) lines.push(`  ${t.row.name}  ->  ${t.existingName}`);
  }
  return lines.join("\n");
}
