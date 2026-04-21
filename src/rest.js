// HTTP client for Twenty CRM REST API.
// Adds timeout + retry/backoff over the old one-liner fetch.

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

export function createRestClient({ apiKey, baseUrl }) {
  if (!apiKey) throw new Error("TWENTY_API_KEY is required");
  if (!baseUrl) throw new Error("TWENTY_BASE_URL is required");

  async function request(endpoint, { method = "GET", body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let attempt = 0;
    let lastErr;
    while (attempt <= MAX_RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body && method !== "GET" && method !== "DELETE" ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          if (res.status === 204) return null;
          const text = await res.text();
          return text ? JSON.parse(text) : null;
        }

        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 8000);
          await sleep(backoffMs);
          attempt++;
          continue;
        }

        const errBody = await res.text().catch(() => "");
        throw new Error(`Twenty API ${method} ${endpoint} → HTTP ${res.status}: ${errBody.slice(0, 600)}`);
      } catch (err) {
        clearTimeout(timer);
        if (err.name === "AbortError") {
          lastErr = new Error(`Twenty API ${method} ${endpoint} timed out after ${timeoutMs}ms`);
        } else {
          lastErr = err;
        }
        if (attempt < MAX_RETRIES && (err.name === "AbortError" || /fetch failed|network/i.test(err.message))) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
          attempt++;
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error("Twenty API request failed");
  }

  return { request, baseUrl, apiKey };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a /rest/{object} query string from structured params.
// Handles filter, order_by, depth, limit, after/before cursors, offset, search.
// Soft-delete handling is the caller's responsibility (see filter.js).
export function buildListQuery(params = {}) {
  const {
    filter,
    order_by,
    depth,
    limit,
    offset,
    after,
    before,
    search,
    extraParams = {},
  } = params;

  const parts = [];
  if (filter) parts.push(`filter=${encodeURIComponent(filter)}`);
  if (order_by) parts.push(`order_by=${encodeURIComponent(order_by)}`);
  if (depth !== undefined && depth !== null) parts.push(`depth=${encodeURIComponent(String(depth))}`);
  if (limit !== undefined) parts.push(`limit=${encodeURIComponent(String(limit))}`);
  if (offset !== undefined) parts.push(`offset=${encodeURIComponent(String(offset))}`);
  if (after) parts.push(`starting_after=${encodeURIComponent(after)}`);
  if (before) parts.push(`ending_before=${encodeURIComponent(before)}`);
  if (search) parts.push(`search=${encodeURIComponent(search)}`);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }

  return parts.length ? `?${parts.join("&")}` : "";
}

// Paginate through /rest/{object} cursor-style and yield each record.
// Falls back to keyset (id[gt]:<lastId>) if endCursor stops advancing.
export async function* iterRecords(client, objectPath, params = {}) {
  let cursor = params.after ?? null;
  let lastId = null;
  let seenCursor = new Set();
  const pageLimit = params.limit ?? 200;

  while (true) {
    const pageParams = { ...params, limit: pageLimit };
    if (cursor) pageParams.after = cursor;
    else delete pageParams.after;
    if (!cursor && lastId) {
      // keyset fallback
      pageParams.filter = pageParams.filter
        ? `and(${pageParams.filter},id[gt]:"${lastId}")`
        : `id[gt]:"${lastId}"`;
      pageParams.order_by = pageParams.order_by || "id[AscNullsLast]";
    }

    const qs = buildListQuery(pageParams);
    const result = await client.request(`/rest/${objectPath}${qs}`);
    const rows = result?.data?.[objectPath] ?? [];
    if (rows.length === 0) return;

    for (const row of rows) {
      yield row;
      lastId = row.id ?? lastId;
    }

    const pageInfo = result?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) return;
    const nextCursor = pageInfo.endCursor;
    if (nextCursor && !seenCursor.has(nextCursor)) {
      cursor = nextCursor;
      seenCursor.add(nextCursor);
    } else {
      // cursor stalled → switch to keyset
      cursor = null;
    }
  }
}
