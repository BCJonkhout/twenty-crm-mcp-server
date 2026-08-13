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
 * people mirrors the fork's own SEARCH_FIELDS_FOR_PERSON and each subfield was
 * confirmed by live [ilike] query; companies likewise; opportunities and notes
 * come from the existing filter builders; tasks from the documented field list
 * in the MCP tool. Adding an unverified field silently narrows results to
 * zero — check against the live API first.
 */
// `as const satisfies` rather than a plain Record: it keeps the literal keys so
// SearchableObject below is a union, which makes a typo at an internal call
// site a tsc error instead of a runtime throw on a real user's search.
export const SEARCHABLE_FIELDS = {
  // Mirrors SEARCH_FIELDS_FOR_PERSON in the Twenty fork: name, emails, phones,
  // jobTitle. Kept in step deliberately — `cato people search "advocaat"` is a
  // documented workflow and only works because jobTitle is in here.
  people: ["name.firstName", "name.lastName", "emails.primaryEmail", "phones.primaryPhoneNumber", "jobTitle"],
  companies: ["name", "domainName.primaryLinkUrl"],
  opportunities: ["name"],
  // The server also searches bodyV2, deliberately excluded here: it is
  // RICH_TEXT_V2 (jsonb) and does not take an [ilike] clause.
  notes: ["title"],
  tasks: ["title"],
} as const satisfies Record<string, readonly string[]>;

export type SearchableObject = keyof typeof SEARCHABLE_FIELDS;

export class UnsearchableObjectError extends Error {}

/**
 * A term was supplied but is blank. Distinct from UnsearchableObjectError:
 * the object is searchable, the term is not — a caller branching on the error
 * needs to tell those apart.
 */
export class BlankSearchTermError extends Error {}

/** True when free-text search is supported for this object name. */
export function isSearchableObject(object: string): object is SearchableObject {
  return Object.prototype.hasOwnProperty.call(SEARCHABLE_FIELDS, object);
}

/**
 * Free-text term -> a real Twenty filter expression, for an object type only
 * known at runtime (query_records / search_records take one as an argument).
 *
 * Throws rather than returning null for an unknown object: silently dropping
 * the term is the exact failure this replaces (you get every record back and
 * it looks like a result set). A caller that cannot search must say so.
 *
 * An empty string means "no search" and returns null — right when the term is
 * one optional filter among many. A term that is present but whitespace-only
 * is a mistake, not a choice, and throws: silently dropping it would list the
 * whole table back to a caller who thought they were searching. A search-ONLY
 * entry point must also treat null as an error; see requireSearchExpr.
 */
export function searchExprForType(object: string, term: string): string | null {
  if (term === "") return null;
  const trimmed = term.trim();
  if (!trimmed) {
    throw new BlankSearchTermError(
      "Search term is blank — search needs a non-empty term, " +
        "and a whitespace-only one would return unfiltered records.",
    );
  }

  if (!isSearchableObject(object)) {
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
  return orExpr(...SEARCHABLE_FIELDS[object].map((f) => clause(f, "ilike", `%${trimmed}%`)));
}

/** Same, for a statically-known object — a typo here fails at compile time. */
export function searchExpr(object: SearchableObject, term: string): string | null {
  return searchExprForType(object, term);
}

/**
 * For entry points whose ONLY job is to search (`cato <object> search <term>`,
 * the search_records tool). A blank term there must not quietly degrade into
 * "list everything" — that is the original bug wearing a different hat.
 */
export function requireSearchExpr(object: string, term: string): string {
  const expr = searchExprForType(object, term);
  if (!expr) {
    throw new BlankSearchTermError(
      `Search needs a non-empty term — a blank search would return unfiltered records.`,
    );
  }
  return expr;
}

// Compose an outer filter and extra soft-delete guard without nesting "and(and(...))".
export function combineWithSoftDelete(filterExpr: string | null, includeDeleted: boolean): string | null {
  if (includeDeleted) return filterExpr || null;
  const guard = "deletedAt[is]:NULL";
  if (!filterExpr) return guard;
  return `and(${filterExpr},${guard})`;
}
