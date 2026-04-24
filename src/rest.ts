// HTTP client for Twenty CRM REST API.
// Adds timeout + retry/backoff over the old one-liner fetch.

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set<number>([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

export interface RestClientOptions {
  apiKey: string;
  baseUrl: string;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

export interface RestClient {
  request: <T = unknown>(endpoint: string, opts?: RequestOptions) => Promise<T>;
  baseUrl: string;
  apiKey: string;
}

export function createRestClient({ apiKey, baseUrl }: RestClientOptions): RestClient {
  if (!apiKey) throw new Error("TWENTY_API_KEY is required");
  if (!baseUrl) throw new Error("TWENTY_BASE_URL is required");

  async function request<T = unknown>(
    endpoint: string,
    { method = "GET", body = null, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
  ): Promise<T> {
    const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let attempt = 0;
    let lastErr: Error | undefined;
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
          if (res.status === 204) return null as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : null) as T;
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
        const e = err as Error;
        if (e.name === "AbortError") {
          lastErr = new Error(`Twenty API ${method} ${endpoint} timed out after ${timeoutMs}ms`);
        } else {
          lastErr = e;
        }
        if (attempt < MAX_RETRIES && (e.name === "AbortError" || /fetch failed|network/i.test(e.message))) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
          attempt++;
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr ?? new Error("Twenty API request failed");
  }

  return { request, baseUrl, apiKey };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ListQueryParams {
  filter?: string | null;
  order_by?: string;
  depth?: number | null;
  limit?: number;
  offset?: number;
  after?: string | null;
  before?: string | null;
  search?: string;
  extraParams?: Record<string, unknown>;
  /** Caller-side flag — `iterRecords` reads it but `buildListQuery` ignores it. */
  include_deleted?: boolean;
}

// Build a /rest/{object} query string from structured params.
// Handles filter, order_by, depth, limit, after/before cursors, offset, search.
// Soft-delete handling is the caller's responsibility (see filter.ts).
export function buildListQuery(params: ListQueryParams = {}): string {
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

  const parts: string[] = [];
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

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
  startCursor?: string | null;
}

interface ListPage<T = TwentyRecord> {
  data?: Record<string, T[] | undefined>;
  pageInfo?: PageInfo;
  totalCount?: number;
}

export interface TwentyRecord {
  id: string;
  [key: string]: unknown;
}

// Paginate through /rest/{object} cursor-style and yield each record.
// Falls back to keyset (id[gt]:<lastId>) if endCursor stops advancing.
export async function* iterRecords(
  client: RestClient,
  objectPath: string,
  params: ListQueryParams = {},
): AsyncGenerator<TwentyRecord, void, void> {
  let cursor: string | null = params.after ?? null;
  let lastId: string | null = null;
  const seenCursor = new Set<string>();
  const pageLimit = params.limit ?? 200;

  while (true) {
    const pageParams: ListQueryParams = { ...params, limit: pageLimit };
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
    const result = await client.request<ListPage>(`/rest/${objectPath}${qs}`);
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
