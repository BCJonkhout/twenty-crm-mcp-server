// HTTP client for Twenty CRM REST API.
// Adds timeout + retry/backoff over the old one-liner fetch.
//
// Retry safety, which is the subtle part:
//   * 429 means the server refused the request outright — it did not run, so
//     replaying it is safe for any method.
//   * 5xx, a timeout or a dropped connection are AMBIGUOUS for a write: the
//     row may already exist. Replaying a POST there duplicates records, so
//     non-idempotent methods only ever retry on 429.
//   * GET/PUT/DELETE/HEAD/OPTIONS are idempotent by definition and retry on
//     everything retryable.
// Callers with a POST that is genuinely safe to replay (a search-style route,
// or one with a server-side upsert key) can opt in with `idempotent: true`.

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set<number>([429, 500, 502, 503, 504]);
const RATE_LIMITED = 429;
const MAX_RETRIES = 4;
const MAX_BACKOFF_MS = 8_000;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

export interface RestClientOptions {
  apiKey: string;
  baseUrl: string;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /**
   * Force this request to be treated as safe to replay. Only set it when the
   * endpoint is genuinely idempotent — a duplicate write is worse than a
   * failed one.
   */
  idempotent?: boolean;
}

/** Whether replaying this request can create a second copy of something. */
export function isIdempotent(method: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Exponential backoff with full jitter. Without jitter, several clients that
 * are rate-limited together retry in lockstep and hit the same wall again.
 */
export function backoffMs(attempt: number, retryAfterSeconds?: number, random = Math.random): number {
  if (Number.isFinite(retryAfterSeconds) && (retryAfterSeconds as number) > 0) {
    return (retryAfterSeconds as number) * 1000;
  }
  const ceiling = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The retry decision, split out so it can be tested without a socket. */
export function shouldRetry(input: {
  attempt: number;
  method: string;
  idempotent?: boolean;
  status?: number;
  networkError?: boolean;
}): boolean {
  if (input.attempt >= MAX_RETRIES) return false;

  const safeToReplay = isIdempotent(input.method, input.idempotent);

  if (input.status === RATE_LIMITED) return true;
  if (!safeToReplay) return false;

  if (input.networkError) return true;
  return input.status !== undefined && RETRYABLE.has(input.status);
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
    {
      method = "GET",
      body = null,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      idempotent,
    }: RequestOptions = {},
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

        if (shouldRetry({ attempt, method, idempotent, status: res.status })) {
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(backoffMs(attempt, retryAfter));
          attempt++;
          continue;
        }

        const errBody = await res.text().catch(() => "");
        const unsafeToReplay =
          RETRYABLE.has(res.status) && !isIdempotent(method, idempotent) && res.status !== RATE_LIMITED;
        const suffix = unsafeToReplay
          ? ` (not retried: replaying a ${method} after ${res.status} could duplicate the write)`
          : "";
        throw new Error(
          `Twenty API ${method} ${endpoint} → HTTP ${res.status}: ${errBody.slice(0, 600)}${suffix}`,
        );
      } catch (err) {
        clearTimeout(timer);
        const e = err as Error;
        if (e.name === "AbortError") {
          lastErr = new Error(`Twenty API ${method} ${endpoint} timed out after ${timeoutMs}ms`);
        } else {
          lastErr = e;
        }
        const isNetworkError = e.name === "AbortError" || /fetch failed|network/i.test(e.message);
        if (shouldRetry({ attempt, method, idempotent, networkError: isNetworkError })) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        if (isNetworkError && !isIdempotent(method, idempotent)) {
          lastErr = new Error(
            `${lastErr.message} (not retried: a ${method} may already have been applied server-side)`,
          );
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
  extraParams?: Record<string, unknown>;
  /**
   * Caller-side marker only: nothing in this module reads it. The soft-delete
   * guard is part of the filter (combineWithSoftDelete), not a query param.
   */
  include_deleted?: boolean;
}

// Build a /rest/{object} query string from structured params.
// Handles filter, order_by, depth, limit, after/before cursors, offset.
// Soft-delete handling is the caller's responsibility (see filter.ts).
//
// Deliberately has NO `search` param. Twenty's records endpoint ignores query
// params it does not recognise, so an earlier `search=<term>` was dropped on
// the floor and the caller got the entire table back looking like a result
// set. Free-text search goes through searchExpr() in filter.ts, which builds
// an ilike filter the server actually applies.
export function buildListQuery(params: ListQueryParams = {}): string {
  const {
    filter,
    order_by,
    depth,
    limit,
    offset,
    after,
    before,
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
