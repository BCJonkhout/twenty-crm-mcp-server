// Filter grammar helpers for Twenty REST API.
//
// Twenty filter syntax (verified against crm.prudai.com v1.19):
//   Operators:  [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
//               [gt] [gte] [lt] [lte] [is]
//   [like] is CASE-SENSITIVE. Use [ilike] for case-insensitive match.
//   [nilike] is not supported — compose with or()/[neq] if needed.
//   Composition: and(clause1,clause2,...)  |  or(clause1,clause2,...)
//   Composite fields are reached by dot-notation:
//     address.addressCity, emails.primaryEmail, name.firstName,
//     phones.primaryPhoneNumber, domainName.primaryLinkUrl
//   Soft-delete guard: deletedAt[is]:NULL  (or deletedAt[is]:NOT_NULL)
//   Cursor pagination:  starting_after=<endCursor> | ending_before=<startCursor>

export type FilterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FilterValue[];

export function escapeFilterValue(value: FilterValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(escapeFilterValue).join(",")}]`;
  }
  // strings: wrap in quotes, escape embedded quotes and backslashes
  const s = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${s}"`;
}

export function clause(field: string, op: string, value: FilterValue): string {
  const operator = op.startsWith("[") ? op : `[${op}]`;
  return `${field}${operator}:${escapeFilterValue(value)}`;
}

export function andExpr(...clauses: Array<string | null | undefined | false>): string | null {
  const flat = clauses.filter((c): c is string => Boolean(c));
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0]!;
  return `and(${flat.join(",")})`;
}

export function orExpr(...clauses: Array<string | null | undefined | false>): string | null {
  const flat = clauses.filter((c): c is string => Boolean(c));
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0]!;
  return `or(${flat.join(",")})`;
}

/**
 * Which fields a free-text search covers, per object.
 *
 * Twenty's `/rest/{object}` endpoint has NO full-text search: it silently
 * ignores query params it does not know, so a `search=` param came back as the
 * complete unfiltered table — indistinguishable from a hit list. Free-text
 * search is therefore expressed as an `or(...)` of `[ilike]` clauses over the
 * fields below, which is a filter the server actually honours.
 *
 * Every field here is verified against crm.prudai.com (v1.19), not guessed:
 * people/companies by live query on 2026-08-13, opportunities/notes by the
 * existing filter builders, tasks by the documented field list in the MCP tool.
 * Adding an unverified field silently narrows results to zero — check first.
 */
export const SEARCHABLE_FIELDS: Record<string, readonly string[]> = {
  people: ["name.firstName", "name.lastName", "emails.primaryEmail"],
  companies: ["name", "domainName.primaryLinkUrl"],
  opportunities: ["name"],
  notes: ["title"],
  tasks: ["title"],
};

export class UnsearchableObjectError extends Error {}

/**
 * Free-text term -> a real Twenty filter expression.
 *
 * Throws rather than returning null for an unknown object: silently dropping
 * the term is the exact failure this replaces (you get every record back and
 * it looks like a result set). A caller that cannot search must say so.
 */
export function searchExpr(object: string, term: string): string | null {
  const trimmed = term.trim();
  if (!trimmed) return null;

  const fields = SEARCHABLE_FIELDS[object];
  if (!fields) {
    const known = Object.keys(SEARCHABLE_FIELDS).sort().join(", ");
    throw new UnsearchableObjectError(
      `Free-text search is not supported for '${object}' — no verified searchable fields. ` +
        `Searchable objects: ${known}. Use --filter with an explicit Twenty expression instead.`,
    );
  }

  // clause() escapes quotes and backslashes. It does NOT escape % or _, and
  // Twenty's grammar has no ESCAPE clause — so those stay ILIKE wildcards
  // inside a search term. Documented limitation, not an oversight: a search
  // for "50%" also matches "50 procent".
  return orExpr(...fields.map((f) => clause(f, "ilike", `%${trimmed}%`)));
}

// Compose an outer filter and extra soft-delete guard without nesting "and(and(...))".
export function combineWithSoftDelete(filterExpr: string | null, includeDeleted: boolean): string | null {
  if (includeDeleted) return filterExpr || null;
  const guard = "deletedAt[is]:NULL";
  if (!filterExpr) return guard;
  return `and(${filterExpr},${guard})`;
}
