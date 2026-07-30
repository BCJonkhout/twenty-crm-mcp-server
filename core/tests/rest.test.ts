import { describe, expect, it } from "bun:test";
import { backoffMs, createRestClient, isIdempotent, shouldRetry } from "../src/rest.ts";

describe("isIdempotent", () => {
  it("treats the read and replace verbs as safe to replay", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "get", "put"]) {
      expect(isIdempotent(method)).toBe(true);
    }
  });

  it("treats POST and PATCH as unsafe to replay", () => {
    expect(isIdempotent("POST")).toBe(false);
    expect(isIdempotent("PATCH")).toBe(false);
  });

  it("lets a caller override, for endpoints that really are replayable", () => {
    expect(isIdempotent("POST", true)).toBe(true);
    expect(isIdempotent("GET", false)).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("retries 429 for every method — the server refused, nothing ran", () => {
    expect(shouldRetry({ attempt: 0, method: "POST", status: 429 })).toBe(true);
    expect(shouldRetry({ attempt: 0, method: "GET", status: 429 })).toBe(true);
  });

  // This is the whole point of the change: a 502 after a POST may mean the row
  // was written and the response was lost. Replaying it duplicates the record.
  it("does NOT retry a POST on 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetry({ attempt: 0, method: "POST", status })).toBe(false);
    }
  });

  it("does NOT retry a POST on a timeout or dropped connection", () => {
    expect(shouldRetry({ attempt: 0, method: "POST", networkError: true })).toBe(false);
    expect(shouldRetry({ attempt: 0, method: "PATCH", networkError: true })).toBe(false);
  });

  it("still retries idempotent methods on 5xx and network errors", () => {
    expect(shouldRetry({ attempt: 0, method: "GET", status: 503 })).toBe(true);
    expect(shouldRetry({ attempt: 0, method: "DELETE", networkError: true })).toBe(true);
  });

  it("retries an opted-in POST like an idempotent one", () => {
    expect(shouldRetry({ attempt: 0, method: "POST", idempotent: true, status: 503 })).toBe(true);
  });

  it("never retries a 4xx that is not a rate limit", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(shouldRetry({ attempt: 0, method: "GET", status })).toBe(false);
    }
  });

  it("stops at the retry ceiling", () => {
    expect(shouldRetry({ attempt: 3, method: "GET", status: 503 })).toBe(true);
    expect(shouldRetry({ attempt: 4, method: "GET", status: 503 })).toBe(false);
    expect(shouldRetry({ attempt: 4, method: "GET", status: 429 })).toBe(false);
  });
});

describe("backoffMs", () => {
  it("obeys Retry-After exactly when the server sends one", () => {
    expect(backoffMs(0, 7)).toBe(7000);
    expect(backoffMs(3, 2)).toBe(2000);
  });

  it("ignores a missing or nonsensical Retry-After", () => {
    expect(backoffMs(0, undefined, () => 0)).toBe(500);
    expect(backoffMs(0, 0, () => 0)).toBe(500);
    expect(backoffMs(0, Number.NaN, () => 0)).toBe(500);
  });

  it("grows exponentially and caps at 8s", () => {
    const max = (attempt: number) => backoffMs(attempt, undefined, () => 0.999999);
    expect(max(0)).toBeLessThanOrEqual(1000);
    expect(max(1)).toBeLessThanOrEqual(2000);
    expect(max(2)).toBeLessThanOrEqual(4000);
    expect(max(9)).toBeLessThanOrEqual(8000);
  });

  it("jitters, so parallel clients do not retry in lockstep", () => {
    expect(backoffMs(2, undefined, () => 0)).toBe(2000);
    expect(backoffMs(2, undefined, () => 1)).toBe(4000);
  });
});

/** Swaps global fetch for a scripted sequence and records what was sent. */
function withFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number) => new Response("boom", { status });

describe("createRestClient retry behaviour", () => {
  const client = () => createRestClient({ apiKey: "k", baseUrl: "https://cato.test" });

  it("sends a POST exactly once when the server 500s", async () => {
    const { calls, restore } = withFetch([fail(500)]);
    try {
      await expect(client().request("/rest/companies", { method: "POST", body: { name: "x" } }))
        .rejects.toThrow(/HTTP 500/);
      expect(calls).toHaveLength(1);
    } finally { restore(); }
  });

  it("explains in the error why the POST was not retried", async () => {
    const { restore } = withFetch([fail(502)]);
    try {
      await expect(client().request("/rest/companies", { method: "POST" }))
        .rejects.toThrow(/could duplicate the write/);
    } finally { restore(); }
  });

  it("retries a GET through a 503 and returns the eventual body", async () => {
    const { calls, restore } = withFetch([fail(503), fail(503), ok({ data: 1 })]);
    try {
      const body = await client().request<{ data: number }>("/rest/companies");
      expect(body).toEqual({ data: 1 });
      expect(calls).toHaveLength(3);
    } finally { restore(); }
  });

  it("retries a POST on 429, because that request never ran", async () => {
    const { calls, restore } = withFetch([
      new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      ok({ id: "new" }),
    ]);
    try {
      const created = await client().request<{ id: string }>("/rest/companies", { method: "POST" });
      expect(created).toEqual({ id: "new" });
      expect(calls).toHaveLength(2);
    } finally { restore(); }
  });

  it("does not replay a POST whose connection dropped", async () => {
    const { calls, restore } = withFetch([new Error("fetch failed")]);
    try {
      await expect(client().request("/rest/companies", { method: "POST" }))
        .rejects.toThrow(/may already have been applied/);
      expect(calls).toHaveLength(1);
    } finally { restore(); }
  });

  it("returns null for 204 rather than trying to parse it", async () => {
    const { restore } = withFetch([new Response(null, { status: 204 })]);
    try {
      expect(await client().request("/rest/companies/1", { method: "DELETE" })).toBeNull();
    } finally { restore(); }
  });
});
