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

export function escapeFilterValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(escapeFilterValue).join(",")}]`;
  }
  // strings: wrap in quotes, escape embedded quotes and backslashes
  const s = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${s}"`;
}

export function clause(field, op, value) {
  const operator = op.startsWith("[") ? op : `[${op}]`;
  return `${field}${operator}:${escapeFilterValue(value)}`;
}

export function andExpr(...clauses) {
  const flat = clauses.filter(Boolean);
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return `and(${flat.join(",")})`;
}

export function orExpr(...clauses) {
  const flat = clauses.filter(Boolean);
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return `or(${flat.join(",")})`;
}

// Compose an outer filter and extra soft-delete guard without nesting "and(and(...))".
export function combineWithSoftDelete(filterExpr, includeDeleted) {
  if (includeDeleted) return filterExpr || null;
  const guard = "deletedAt[is]:NULL";
  if (!filterExpr) return guard;
  return `and(${filterExpr},${guard})`;
}
