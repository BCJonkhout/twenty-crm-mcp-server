import { describe, expect, it } from "bun:test";
import {
  buildPayload, buildTagPayload, executeWrites, matchKey, planWrites, renderWritePlan,
  type ImportRow,
} from "../src/commands/importWrite.ts";
import { recordUrl } from "../src/urls.ts";

const BASE = "https://crm.prudai.com";

describe("matchKey", () => {
  it("collapses the spellings the same firm appears under", () => {
    expect(matchKey("OAK advocaten B.V.")).toBe(matchKey("Oak Advocaten"));
    expect(matchKey("Tanger Advocaten N.V.")).toBe(matchKey("Tanger Advocaten"));
    expect(matchKey("SmeetsGijbels BV")).toBe(matchKey("SmeetsGijbels"));
    expect(matchKey("Hof-Recht advocaten")).toBe(matchKey("Hof-Recht Advocaten"));
  });

  it("keeps genuinely different firms apart", () => {
    expect(matchKey("Banning Advocaten")).not.toBe(matchKey("Bannink Advocaten"));
    expect(matchKey("De Roos")).not.toBe(matchKey("De Boorder"));
  });

  it("is empty for a nameless row so it can be skipped rather than guessed at", () => {
    expect(matchKey("")).toBe("");
    expect(matchKey("   ")).toBe("");
  });
});

describe("buildPayload", () => {
  const row: ImportRow = {
    name: "Testkantoor",
    sourceSegment: "Advocatuur",
    sourceSystem: "concurrentie_analyse",
    sourceUrl: "https://example.test/bewijs",
    context: { vendor: "Zeno", relatie: "KLANT" },
  };

  it("writes only provenance fields", () => {
    expect(Object.keys(buildPayload(row)).sort()).toEqual([
      "name",
      "prudaiMarketingSourceContext",
      "prudaiMarketingSourceSegment",
      "prudaiMarketingSourceSystem",
      "prudaiMarketingSourceUrl",
    ]);
  });

  it("never writes contact or outreach fields", () => {
    const keys = Object.keys(buildPayload(row));
    for (const forbidden of [
      "emails", "prudaiMarketingOutreachState", "accountOwnerId", "marketingSelection",
      "prudaiMarketingSuppressionFlags",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("leaves the name out when tagging, so an existing record is never renamed", () => {
    expect(Object.keys(buildTagPayload(row))).not.toContain("name");
  });

  it("omits empty optional fields instead of blanking them", () => {
    expect(buildPayload({ name: "X" })).toEqual({ name: "X" });
  });
});

describe("planWrites", () => {
  const existing = [
    { id: "id-oak", name: "OAK advocaten B.V." },
    { id: "id-bk", name: "BarentsKrans" },
  ];

  it("tags what already exists and creates only what does not", () => {
    const plan = planWrites(
      [{ name: "Oak Advocaten" }, { name: "BarentsKrans" }, { name: "Nieuw Kantoor" }],
      existing,
    );
    expect(plan.map((p) => p.action)).toEqual(["tag", "tag", "create"]);
    expect(plan[0]!.existingId).toBe("id-oak");
  });

  it("does not create the same new firm twice from one file", () => {
    const plan = planWrites([{ name: "Nieuw Kantoor" }, { name: "Nieuw kantoor B.V." }], existing);
    expect(plan.map((p) => p.action)).toEqual(["create", "skip"]);
  });

  it("skips rows without a usable name", () => {
    expect(planWrites([{ name: "" }], existing)[0]!.action).toBe("skip");
  });
});

/** Records every request so we can assert exactly what would hit production. */
function mockClient(responses: Record<string, unknown> = {}) {
  const calls: Array<{ endpoint: string; method: string; body: unknown }> = [];
  const client = {
    request: async (endpoint: string, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ endpoint, method: opts.method ?? "GET", body: opts.body ?? null });
      return responses[endpoint] ?? { data: { createCompany: { id: "new-id" } } };
    },
  };
  return { client: client as never, calls };
}

describe("executeWrites", () => {
  it("PATCHes an existing company without sending a name", async () => {
    const { client, calls } = mockClient();
    const plan = planWrites([{ name: "Oak Advocaten", sourceSegment: "Advocatuur" }],
      [{ id: "id-oak", name: "OAK advocaten B.V." }]);
    const outcomes = await executeWrites(client, plan, BASE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.endpoint).toBe("/rest/companies/id-oak");
    expect(Object.keys(calls[0]!.body as object)).not.toContain("name");
    expect(outcomes[0]!.url).toBe(recordUrl(BASE, "company", "id-oak"));
  });

  it("POSTs a new company and returns a clickable url", async () => {
    const { client, calls } = mockClient();
    const plan = planWrites([{ name: "Nieuw Kantoor" }], []);
    const outcomes = await executeWrites(client, plan, BASE);

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.endpoint).toBe("/rest/companies");
    expect(outcomes[0]!.action).toBe("create");
    expect(outcomes[0]!.url).toBe(recordUrl(BASE, "company", "new-id"));
  });

  it("reports a failed row instead of aborting the whole run", async () => {
    const calls: string[] = [];
    const client = {
      request: async (endpoint: string) => {
        calls.push(endpoint);
        if (calls.length === 1) throw new Error("HTTP 400: bad request");
        return { data: { createCompany: { id: "second-id" } } };
      },
    } as never;
    const plan = planWrites([{ name: "Kantoor Een" }, { name: "Kantoor Twee" }], []);
    const outcomes = await executeWrites(client, plan, BASE);

    expect(outcomes[0]!.action).toBe("skip");
    expect(outcomes[0]!.reason).toContain("failed");
    expect(outcomes[1]!.action).toBe("create");
  });
});

describe("renderWritePlan", () => {
  it("says plainly that nothing was written and how to actually apply it", () => {
    const plan = planWrites([{ name: "Nieuw Kantoor" }], []);
    const text = renderWritePlan(plan, "concurrentie_analyse", false);
    expect(text).toContain("DRY RUN — nothing was written to CATO.");
    expect(text).toContain("--no-dry-run --yes");
    expect(text).toContain("No email addresses");
  });
});
