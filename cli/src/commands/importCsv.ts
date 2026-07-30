// `cato import --csv <file>` — DRY-RUN ONLY.
//
// This command deliberately has no write path at all. It parses the CSV, maps
// headers onto real Twenty fields, and reports what an import WOULD do. There
// is no --no-dry-run for it: the code to create records does not exist here.
// Bulk-loading into a 30k-contact production CRM is not something a CLI should
// make easy on its first version.

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines and commas. */
export function parseCsv(input: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const text = input.replace(/^﻿/, "");

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty };
}

/**
 * Header aliases -> Twenty field paths. Anything not in here is reported as
 * unmapped rather than silently dropped, because a silently dropped column is
 * how you discover three months later that no one has a job title.
 */
export const PEOPLE_HEADER_MAP: Record<string, string> = {
  email: "emails.primaryEmail",
  "e-mail": "emails.primaryEmail",
  emailaddress: "emails.primaryEmail",
  mail: "emails.primaryEmail",
  firstname: "name.firstName",
  voornaam: "name.firstName",
  lastname: "name.lastName",
  achternaam: "name.lastName",
  jobtitle: "jobTitle",
  functie: "jobTitle",
  city: "city",
  plaats: "city",
  phone: "phones.primaryPhoneNumber",
  telefoon: "phones.primaryPhoneNumber",
  linkedin: "linkedinLink.primaryLinkUrl",
  company: "companyId",
  bedrijf: "companyId",
  segment: "prudaiMarketingSourceSegment",
  branche: "branche",
  product: "product",
};

export const COMPANY_HEADER_MAP: Record<string, string> = {
  name: "name",
  bedrijf: "name",
  company: "name",
  domain: "domainName.primaryLinkUrl",
  website: "domainName.primaryLinkUrl",
  city: "address.addressCity",
  plaats: "address.addressCity",
  employees: "employees",
  branche: "branche",
  segment: "prudaiMarketingSourceSegment",
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_-]/g, "");
}

export interface ImportPlan {
  object: "people" | "companies";
  file: string;
  matchOn: string;
  totalRows: number;
  mapped: Array<{ header: string; field: string }>;
  unmapped: string[];
  /** Rows with no value in the match column — an import could not deduplicate these. */
  rowsMissingMatchValue: number;
  duplicateMatchValues: string[];
  wouldCreate: number;
  wouldUpdate: number;
  warnings: string[];
}

/**
 * Plan an import without contacting CATO. `existingMatchValues` is optional;
 * when the caller has looked up which values already exist, create/update
 * counts become exact instead of "all rows are candidates".
 */
export function planImport(
  table: CsvTable,
  options: {
    object: "people" | "companies";
    file: string;
    matchOn?: string;
    existingMatchValues?: ReadonlySet<string>;
  },
): ImportPlan {
  const map = options.object === "people" ? PEOPLE_HEADER_MAP : COMPANY_HEADER_MAP;
  const matchOn = options.matchOn ?? (options.object === "people" ? "emails.primaryEmail" : "name");

  const mapped: Array<{ header: string; field: string }> = [];
  const unmapped: string[] = [];
  for (const header of table.headers) {
    const field = map[normalizeHeader(header)];
    if (field) mapped.push({ header, field });
    else unmapped.push(header);
  }

  const matchColumnIndex = table.headers.findIndex(
    (h) => map[normalizeHeader(h)] === matchOn,
  );

  const warnings: string[] = [];
  if (matchColumnIndex === -1) {
    warnings.push(
      `No column maps to the match field '${matchOn}' — an import could not tell new records from existing ones.`,
    );
  }
  if (unmapped.length > 0) {
    warnings.push(`Unmapped columns would be ignored: ${unmapped.join(", ")}.`);
  }

  const seen = new Map<string, number>();
  let rowsMissingMatchValue = 0;
  let wouldCreate = 0;
  let wouldUpdate = 0;

  for (const row of table.rows) {
    const value = matchColumnIndex === -1 ? "" : (row[matchColumnIndex] ?? "").trim().toLowerCase();
    if (!value) { rowsMissingMatchValue++; continue; }
    seen.set(value, (seen.get(value) ?? 0) + 1);
    if (options.existingMatchValues?.has(value)) wouldUpdate++;
    else wouldCreate++;
  }

  const duplicateMatchValues = [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v);
  if (duplicateMatchValues.length > 0) {
    warnings.push(`${duplicateMatchValues.length} duplicate value(s) in the match column — the CSV itself is not deduplicated.`);
  }
  if (options.existingMatchValues === undefined) {
    warnings.push("No CATO lookup performed: create/update split is an upper bound, every row is counted as a create.");
  }

  return {
    object: options.object,
    file: options.file,
    matchOn,
    totalRows: table.rows.length,
    mapped,
    unmapped,
    rowsMissingMatchValue,
    duplicateMatchValues,
    wouldCreate,
    wouldUpdate,
    warnings,
  };
}

export function renderImportPlan(plan: ImportPlan, json: boolean): string {
  if (json) return JSON.stringify(plan, null, 2);
  const lines = [
    "DRY RUN — nothing was written to CATO. This command has no write path.",
    "",
    `File        : ${plan.file}`,
    `Object      : ${plan.object}`,
    `Match on    : ${plan.matchOn}`,
    `Rows        : ${plan.totalRows}`,
    `Would create: ${plan.wouldCreate}`,
    `Would update: ${plan.wouldUpdate}`,
    `Skipped (no match value): ${plan.rowsMissingMatchValue}`,
    "",
    "Column mapping:",
    ...plan.mapped.map((m) => `  ${m.header}  ->  ${m.field}`),
  ];
  if (plan.unmapped.length > 0) {
    lines.push("", "Unmapped columns (would be ignored):", ...plan.unmapped.map((u) => `  ${u}`));
  }
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((w) => `  ! ${w}`));
  }
  return lines.join("\n");
}
