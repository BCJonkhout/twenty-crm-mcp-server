import { describe, expect, it } from "bun:test";
import {
  addTargets, archiveCampaign, attachCandidates, bulkApproveDrafts, deleteCampaign,
  MarketingVerbError, removeMember, renderResearchProgress, renderWriteDryRun, requireIds,
  renderPersonHistory, requireVerb, setSchedule, startResearch, stopResearch, summariseResearch,
  renderActionResult, updateCampaign,
} from "../src/commands/marketingApi.ts";

function mockClient(response: unknown = {}) {
  const calls: Array<{ endpoint: string; method: string; body: unknown }> = [];
  const client = {
    request: async (endpoint: string, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ endpoint, method: opts.method ?? "GET", body: opts.body ?? null });
      return response;
    },
  };
  return { client: client as never, calls };
}

describe("requireVerb", () => {
  it("falls back to the first verb when none is given", () => {
    expect(requireVerb("members", undefined, ["list", "add"])).toBe("list");
  });

  it("accepts a known verb regardless of case", () => {
    expect(requireVerb("members", "ADD", ["list", "add"])).toBe("add");
  });

  it("rejects a typo instead of silently doing the default", () => {
    expect(() => requireVerb("members", "atach", ["list", "attach"])).toThrow(MarketingVerbError);
    expect(() => requireVerb("members", "atach", ["list", "attach"])).toThrow(/list, attach/);
  });
});

describe("requireIds", () => {
  it("splits and trims a comma-separated list", () => {
    expect(requireIds(" a , b ,c ", "candidate")).toEqual(["a", "b", "c"]);
  });

  it("refuses to post an empty list", () => {
    expect(() => requireIds("", "candidate")).toThrow(/at least one candidate id/);
    expect(() => requireIds(undefined, "person")).toThrow(/at least one person id/);
    expect(() => requireIds(" , , ", "candidate")).toThrow(MarketingVerbError);
  });
});

describe("summariseResearch", () => {
  const targets = (statuses: string[]) => statuses.map((status) => ({ status }));

  it("counts outstanding work as queued + not_searched + researching", () => {
    const p = summariseResearch(targets([
      "queued", "queued", "researching", "not_searched", "searched", "no_contacts_found", "failed",
    ]));
    expect(p.total).toBe(7);
    expect(p.outstanding).toBe(4);
    expect(p.done).toBe(3);
    expect(p.finished).toBe(false);
  });

  it("is finished only when nothing is outstanding", () => {
    expect(summariseResearch(targets(["searched", "failed"])).finished).toBe(true);
  });

  // An empty campaign is not a finished campaign — reporting it as done would
  // hide that no targets were ever attached.
  it("is not finished when there are no targets at all", () => {
    const p = summariseResearch([]);
    expect(p.finished).toBe(false);
    expect(p.total).toBe(0);
  });

  it("counts unknown statuses instead of dropping them", () => {
    expect(summariseResearch([{}, { status: "weird" }]).byStatus).toEqual({ unknown: 1, weird: 1 });
  });
});

describe("renderResearchProgress", () => {
  it("says plainly when nothing is attached", () => {
    expect(renderResearchProgress(summariseResearch([]))).toContain("No company targets attached");
  });

  it("says plainly when everything is done", () => {
    expect(renderResearchProgress(summariseResearch([{ status: "searched" }])))
      .toContain("finished for every target");
  });
});

describe("endpoints", () => {
  it("starts and stops research on the campaign's own routes", async () => {
    const { client, calls } = mockClient();
    await startResearch(client, "camp-1");
    await stopResearch(client, "camp-1");
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/contact-research/start");
    expect(calls[1]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/contact-research/stop");
    expect(calls[0]!.method).toBe("POST");
  });

  it("attaches candidates by id on the bulk-attach route", async () => {
    const { client, calls } = mockClient();
    await attachCandidates(client, "camp-1", ["a", "b"]);
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/contact-selection-candidates/bulk-attach");
    expect(calls[0]!.body).toEqual({ candidateIds: ["a", "b"] });
  });

  it("uses DELETE for removals rather than a POST", async () => {
    const { client, calls } = mockClient();
    await removeMember(client, "camp-1", "m-1");
    await deleteCampaign(client, "camp-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/members/m-1");
    expect(calls[1]!.method).toBe("DELETE");
  });

  it("PATCHes updates and schedule, POSTs archive", async () => {
    const { client, calls } = mockClient();
    await updateCampaign(client, "camp-1", { name: "x" });
    await setSchedule(client, "camp-1", { weeklyWindows: [] });
    await archiveCampaign(client, "camp-1");
    expect(calls.map((k) => k.method)).toEqual(["PATCH", "PATCH", "POST"]);
    expect(calls[1]!.endpoint).toEndWith("/schedule");
  });

  it("sends company ids as an array on add-targets", async () => {
    const { client, calls } = mockClient();
    await addTargets(client, "camp-1", ["c1"]);
    expect(calls[0]!.body).toEqual({ companyIds: ["c1"] });
  });

  it("posts bulk-approve on the drafts route", async () => {
    const { client, calls } = mockClient();
    await bulkApproveDrafts(client, "camp-1");
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/drafts/bulk-approve");
  });
});

describe("renderWriteDryRun", () => {
  it("states what did not happen and how many records it would touch", () => {
    const text = renderWriteDryRun("bulk-approve", ["Campaign: camp-1"], 42);
    expect(text).toContain("DRY RUN — bulk-approve was not performed.");
    expect(text).toContain("Records affected: 42");
    expect(text).toContain("--no-dry-run --yes");
  });
});

describe("renderPersonHistory", () => {
  const base = { personId: "p-1", memberships: [], messages: [],
    totals: { campaigns: 0, sent: 0, opens: 0, clicks: 0, bounces: 0, unsubscribes: 0 } };

  it("says plainly when nobody has mailed this person", () => {
    expect(renderPersonHistory(base)).toContain("No mail has been sent to this person.");
  });

  it("lists each mail with its phase and subject", () => {
    const text = renderPersonHistory({
      ...base,
      messages: [{ sentAt: "2026-07-07T10:00:00Z", phase: "email_2", subject: "Twentse AI", opens: 3, clicks: 1 }],
      totals: { ...base.totals, sent: 1, opens: 3, clicks: 1 },
    });
    expect(text).toContain("2026-07-07");
    expect(text).toContain("email_2");
    expect(text).toContain("Twentse AI");
    expect(text).toContain("3x open, 1x click");
  });

  it("marks a bounced mail rather than showing it as ordinary", () => {
    const text = renderPersonHistory({
      ...base,
      messages: [{ sentAt: "2026-07-07", subject: "X", opens: 0, clicks: 0, bounced: true }],
      totals: { ...base.totals, sent: 1, bounces: 1 },
    });
    expect(text).toContain("BOUNCED");
  });

  // The one signal that must never be missed in a list of numbers.
  it("spells out an unsubscribe as an instruction, not a count", () => {
    const text = renderPersonHistory({ ...base, totals: { ...base.totals, unsubscribes: 1 } });
    expect(text).toContain("has unsubscribed");
    expect(text).toContain("Do not include them in a campaign");
  });

  it("stays silent about unsubscribing when there is none", () => {
    expect(renderPersonHistory(base)).not.toContain("unsubscribed");
  });
});

// A second `if (sub === "targets")` earlier in the dispatcher shadowed the full
// list/add/remove branch, so `targets add --ids …` silently fell through to the
// filter-based variant and refused. Nothing in the types catches a duplicate
// branch; only the command surface does.
describe("dispatcher branches are unique", () => {
  const source = require("fs").readFileSync(
    require("path").join(import.meta.dir, "../src/index.ts"), "utf8",
  ) as string;

  // Scoped to runMarketing: `create` legitimately appears in the people,
  // companies and auth dispatchers too.
  const runMarketing = source.slice(
    source.indexOf("async function runMarketing("),
    source.indexOf("const code = await main("),
  );

  it("handles each marketing subcommand in exactly one place", () => {
    const seen = new Map<string, number>();
    // Alleen takken op het hoogste niveau (2 spaties); een geneste
    // `if (sub === "approve")` binnen een tak is legitiem.
    for (const m of runMarketing.matchAll(/^  if \(sub === "([a-z-]+)"/gm)) {
      seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
    expect(duplicated).toEqual([]);
  });

  it("looks at a real dispatcher, not an empty slice", () => {
    expect(runMarketing).toContain('sub === "targets"');
    expect(runMarketing.length).toBeGreaterThan(2000);
  });
});

describe("renderActionResult", () => {
  // These endpoints answered with a raw payload dumped straight to stdout: a
  // count object or the whole campaign. You had to read JSON to learn whether
  // anything had happened.
  it("turns a count payload into a sentence", () => {
    const text = renderActionResult("Added company targets.",
      { addedCount: 3, restoredCount: 0, skippedCount: 2 });
    expect(text).toContain("Added company targets.");
    expect(text).toContain("added 3, restored 0, skipped 2");
  });

  it("splits camelCase count keys into words", () => {
    expect(renderActionResult("Marked.", { alreadyHadStatusCount: 4, markedCount: 1 }))
      .toContain("already had status 4, marked 1");
  });

  it("summarises a campaign payload by name and state, not all 30 fields", () => {
    const text = renderActionResult("Archived campaign.", {
      id: "c-1", name: "Twente advocaten", status: "archived", isEnabled: false,
      message: "x".repeat(2000), promptOverrides: { a: 1 },
    });
    expect(text).toContain("name: Twente advocaten");
    expect(text).toContain("status: archived");
    expect(text).toContain("enabled: false");
    expect(text).not.toContain("promptOverrides");
    expect(text.length).toBeLessThan(200);
  });

  // A campaign payload carries memberCount and friends as well. Reporting those
  // after an archive tells you nothing about whether it archived.
  it("prefers the entity over its counts when both are present", () => {
    const text = renderActionResult("Archived campaign.", {
      id: "c-1", name: "Twente advocaten", status: "archived", isEnabled: false,
      memberCount: 0, pendingReviewCount: 0,
    });
    expect(text).toContain("status: archived");
    expect(text).not.toContain("member 0");
  });

  it("falls back to the action line when the payload says nothing useful", () => {
    expect(renderActionResult("Done.", null)).toBe("Done.");
  });
});
