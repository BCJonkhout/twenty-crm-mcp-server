// Output renderers: table (human), JSON, CSV.
//
// CSV is the format that leaves this CLI and lands in a mail-merge, so quoting
// has to be right: RFC 4180 quoting plus a leading-apostrophe guard against
// spreadsheet formula injection (a CRM job title can legitimately start with
// "=", and Excel will happily execute it).

export type Row = Record<string, unknown>;

export interface RenderOptions {
  json?: boolean;
  csv?: boolean;
  columns?: readonly string[];
}

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (FORMULA_PREFIXES.some((p) => s.startsWith(p))) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: readonly Row[], columns?: readonly string[]): string {
  const cols = columns ?? inferColumns(rows);
  const lines = [cols.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(pick(row, c))).join(","));
  }
  return lines.join("\n");
}

export function inferColumns(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** Dotted-path getter so columns like `name.firstName` work on nested records. */
export function pick(row: Row, path: string): unknown {
  if (!path.includes(".")) return row[path];
  let current: unknown = row;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function toTable(rows: readonly Row[], columns?: readonly string[]): string {
  if (rows.length === 0) return "(no records)";
  const cols = columns ?? inferColumns(rows);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(pick(r, c)).length)),
  );
  const clamp = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
  const maxWidths = widths.map((w) => Math.min(w, 48));

  const header = cols.map((c, i) => clamp(c, maxWidths[i]!)).join("  ");
  const rule = maxWidths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((r) => cols.map((c, i) => clamp(cell(pick(r, c)), maxWidths[i]!)).join("  "));
  return [header, rule, ...body].join("\n");
}

export function render(rows: readonly Row[], opts: RenderOptions): string {
  if (opts.json) return JSON.stringify(rows, null, 2);
  if (opts.csv) return toCsv(rows, opts.columns);
  return toTable(rows, opts.columns);
}

export function renderOne(row: Row | null, opts: RenderOptions): string {
  if (row === null) return opts.json ? "null" : "(not found)";
  if (opts.json) return JSON.stringify(row, null, 2);
  if (opts.csv) return toCsv([row], opts.columns);
  const cols = opts.columns ?? Object.keys(row);
  const width = Math.max(...cols.map((c) => c.length));
  return cols.map((c) => `${c.padEnd(width)}  ${cell(pick(row, c))}`).join("\n");
}
