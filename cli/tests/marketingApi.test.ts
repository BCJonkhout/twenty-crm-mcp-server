import { describe, expect, it } from "bun:test";
import {
  addTargets, archiveCampaign, attachCandidates, bulkApproveDrafts, deleteCampaign,
  MarketingVerbError, removeMember, renderResearchProgress, renderWriteDryRun, requireIds,
  requireVerb, setSchedule, startResearch, stopResearch, summariseResearch, updateCampaign,
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
