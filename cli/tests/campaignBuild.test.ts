import { describe, expect, it } from "bun:test";
import {
  addCompanyTargets, addMatchingCompanyTargets, attachMatchingMembers, buildAudienceFilter,
  CampaignInputError, createCampaign, planCreateCampaign, renderAudienceDryRun,
  renderCreateDryRun, sendTest, setEnabled, setGeneration,
} from "../src/commands/campaignBuild.ts";

function mockClient(response: unknown = { id: "camp-1", name: "Test" }) {
  const calls: Array<{ endpoint: string; method: string; body: unknown }> = [];
  const client = {
    request: async (endpoint: string, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ endpoint, method: opts.method ?? "GET", body: opts.body ?? null });
      return response;
    },
  };
  return { client: client as never, calls };
}

describe("planCreateCampaign", () => {
  it("requires a name", () => {
    expect(() => planCreateCampaign({})).toThrow(CampaignInputError);
    expect(() => planCreateCampaign({ name: "   " })).toThrow(/needs --name/);
  });

  it("defaults to outbound and rejects an unknown channel", () => {
    expect(planCreateCampaign({ name: "x" }).channel).toBe("outbound");
    expect(() => planCreateCampaign({ name: "x", channel: "carrier-pigeon" as never }))
      .toThrow(/must be 'outbound' or 'newsletter'/);
  });

  it("rejects a relative CTA link, because a mail cannot follow one", () => {
    expect(() => planCreateCampaign({ name: "x", ctaLink: "/demo" })).toThrow(/absolute http/);
    expect(planCreateCampaign({ name: "x", ctaLink: "https://prudai.com/demo" }).ctaLink)
      .toBe("https://prudai.com/demo");
  });

  it("drops empty optional fields rather than writing blanks", () => {
    const planned = planCreateCampaign({ name: "x", message: "  ", focusArea: "Advocatuur" });
    expect(planned).not.toHaveProperty("message");
    expect(planned.focusArea).toBe("Advocatuur");
  });

  it("trims the name so two campaigns do not differ by whitespace alone", () => {
    expect(planCreateCampaign({ name: "  Wave 1  " }).name).toBe("Wave 1");
  });
});

describe("buildAudienceFilter", () => {
  it("refuses to build an empty filter", () => {
    expect(() => buildAudienceFilter({})).toThrow(/Refusing to target everyone/);
  });

  it("maps the flags onto the provenance fields the import writes", () => {
    expect(buildAudienceFilter({ sourceSystem: "concurrentie_analyse", segment: "Advocatuur" }))
      .toEqual({
        prudaiMarketingSourceSystem: "concurrentie_analyse",
        prudaiMarketingSourceSegment: "Advocatuur",
      });
  });
});

describe("write calls", () => {
  it("creates a campaign with POST /rest/marketing/campaigns", async () => {
    const { client, calls } = mockClient();
    await createCampaign(client, planCreateCampaign({ name: "Wave 1", mailSubject: "Hoi" }));
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ name: "Wave 1", mailSubject: "Hoi", channel: "outbound" });
  });

  it("attaches company targets by id", async () => {
    const { client, calls } = mockClient();
    await addCompanyTargets(client, "camp-1", ["c1", "c2"]);
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/company-targets");
    expect(calls[0]!.body).toEqual({ companyIds: ["c1", "c2"] });
  });

  it("pushes the filter server-side for add-matching", async () => {
    const { client, calls } = mockClient();
    await addMatchingCompanyTargets(client, "camp-1", { prudaiMarketingSourceSystem: "x" });
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/company-targets/add-matching");
    expect(calls[0]!.method).toBe("POST");
  });

  it("attaches matching members on the members route, not the targets route", async () => {
    const { client, calls } = mockClient();
    await attachMatchingMembers(client, "camp-1", { branche: "ADVOCATUUR" });
    expect(calls[0]!.endpoint).toBe("/rest/marketing/campaigns/camp-1/members/attach-matching");
  });

  it("uses distinct routes for activating and deactivating generation", async () => {
    const { client, calls } = mockClient();
    await setGeneration(client, "camp-1", true);
    await setGeneration(client, "camp-1", false);
    expect(calls[0]!.endpoint).toEndWith("/generation/activate");
    expect(calls[1]!.endpoint).toEndWith("/generation/deactivate");
  });

  it("PATCHes the enabled flag", async () => {
    const { client, calls } = mockClient();
    await setEnabled(client, "camp-1", true);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ isEnabled: true });
  });

  it("refuses to send a test to a malformed address", async () => {
    const { client, calls } = mockClient();
    await expect(sendTest(client, "camp-1", "not-an-email")).rejects.toThrow(CampaignInputError);
    expect(calls).toHaveLength(0);
  });

  it("sends a test mail to exactly one address", async () => {
    const { client, calls } = mockClient();
    await sendTest(client, "camp-1", "beau@prudai.com");
    expect(calls[0]!.endpoint).toEndWith("/send-test");
    // Verified against the live API: the server rejects {email} with 400.
    expect(calls[0]!.body).toEqual({ testRecipient: "beau@prudai.com" });
  });
});

describe("dry-run renders", () => {
  it("states that creating a campaign sends nothing", () => {
    const text = renderCreateDryRun(planCreateCampaign({ name: "Wave 1" }));
    expect(text).toContain("DRY RUN — no campaign was created.");
    expect(text).toContain("Nothing is sent by creating it.");
    expect(text).toContain("--no-dry-run --yes");
  });

  it("states that attaching an audience still requires approval per touchpoint", () => {
    const text = renderAudienceDryRun({ prudaiMarketingSourceSystem: "x" }, "camp-1", "members");
    expect(text).toContain("approved by a person");
    expect(text).toContain("prudaiMarketingSourceSystem = x");
  });
});
