import { describe, expect, it } from "bun:test";
import {
  buildCompanyBody, buildNoteBody, buildOpportunityBody, buildPersonBody, createNoteWithTargets,
  createRecord, deleteRecord, findOpenOpportunities, RecordWriteError,
  renderWriteDryRun, requireCreateFields, resolveAssignee, updateRecord,
} from "../src/commands/recordWrite.ts";

const BASE = "https://crm.prudai.com";

function mockClient(responses: Record<string, unknown> = {}) {
  const calls: Array<{ endpoint: string; method: string; body: unknown }> = [];
  const client = {
    request: async (endpoint: string, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ endpoint, method: opts.method ?? "GET", body: opts.body ?? null });
      return responses[endpoint] ?? { data: { createPerson: { id: "p-new" }, createCompany: { id: "c-new" } } };
    },
  };
  return { client: client as never, calls };
}

describe("buildPersonBody", () => {
  it("maps flat flags onto Twenty's composite fields", () => {
    const body = buildPersonBody({ firstName: "Beau", lastName: "Jonkhout", email: "b@prudai.com" });
    expect(body).toMatchObject({
      name: { firstName: "Beau", lastName: "Jonkhout" },
      emails: { primaryEmail: "b@prudai.com" },
    });
  });

  // An update that sends every flag, blank ones included, would wipe fields the
  // caller never mentioned.
  it("drops blank and undefined flags instead of blanking the field", () => {
    const body = buildPersonBody({ firstName: "Beau", lastName: "   ", jobTitle: undefined });
    expect(JSON.stringify(body)).not.toContain('"lastName"');
    expect(body).not.toHaveProperty("jobTitle");
  });

  it("refuses an empty write", () => {
    expect(() => buildPersonBody({})).toThrow(RecordWriteError);
    expect(() => buildPersonBody({ firstName: "  " })).toThrow(/Nothing to write/);
  });
});

describe("buildCompanyBody", () => {
  it("maps name and domain", () => {
    expect(buildCompanyBody({ name: "PrudAI", domain: "prudai.com" }))
      .toMatchObject({ name: "PrudAI" });
  });
});

describe("requireCreateFields", () => {
  it("insists a company has a name", () => {
    expect(() => requireCreateFields("companies", {})).toThrow(/needs --name/);
    expect(() => requireCreateFields("companies", { name: "X" })).not.toThrow();
  });

  it("insists a person is identifiable by something", () => {
    expect(() => requireCreateFields("people", { jobTitle: "Advocaat" }))
      .toThrow(/--first-name, --last-name or --email/);
    expect(() => requireCreateFields("people", { email: "a@b.nl" })).not.toThrow();
  });
});

describe("resolveAssignee", () => {
  it("inherits the company's account owner so the record stays visible to that rep", async () => {
    const { client, calls } = mockClient({
      "/rest/companies/c-1": { data: { company: { accountOwnerId: "wm-7" } } },
    });
    expect(await resolveAssignee(client, { companyId: "c-1" }))
      .toEqual({ assigneeId: "wm-7", inheritedFrom: "c-1" });
    expect(calls[0]!.endpoint).toBe("/rest/companies/c-1");
  });

  it("leaves the assignee unset when the company has no owner", async () => {
    const { client } = mockClient({ "/rest/companies/c-2": { data: { company: { accountOwnerId: null } } } });
    expect(await resolveAssignee(client, { companyId: "c-2" })).toEqual({});
  });

  it("does not override an explicit assignee, and does not look the company up", async () => {
    const { client, calls } = mockClient();
    expect(await resolveAssignee(client, { companyId: "c-1", assigneeId: "wm-9" }))
      .toEqual({ assigneeId: "wm-9" });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when there is no company to inherit from", async () => {
    const { client, calls } = mockClient();
    expect(await resolveAssignee(client, { firstName: "Solo" })).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("write calls", () => {
  it("POSTs a create and returns a clickable url", async () => {
    const { client, calls } = mockClient();
    const outcome = await createRecord(client, "people", { name: { firstName: "A" } }, BASE);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.endpoint).toBe("/rest/people");
    expect(outcome.url).toBe(`${BASE}/object/person/p-new`);
  });

  it("PATCHes an update on the record's own path", async () => {
    const { client, calls } = mockClient();
    const outcome = await updateRecord(client, "companies", "c-1", { name: "X" }, BASE);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.endpoint).toBe("/rest/companies/c-1");
    expect(outcome.url).toBe(`${BASE}/object/company/c-1`);
  });

  it("DELETEs rather than posting a flag", async () => {
    const { client, calls } = mockClient();
    await deleteRecord(client, "people", "p-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.endpoint).toBe("/rest/people/p-1");
  });
});

describe("renderWriteDryRun", () => {
  it("says nothing happened and how to apply it", () => {
    const text = renderWriteDryRun("create", "people", { name: { firstName: "A" } });
    expect(text).toContain("DRY RUN — no person was created.");
    expect(text).toContain("--no-dry-run --yes");
  });

  it("explains the inherited assignee, because that is invisible otherwise", () => {
    const text = renderWriteDryRun("create", "people", { a: 1 }, undefined, "c-1");
    expect(text).toContain("inherited from company c-1");
  });

  it("warns that a delete hides the record", () => {
    expect(renderWriteDryRun("delete", "companies", null, "c-1")).toContain("hides the record");
  });
});

describe("buildOpportunityBody", () => {
  it("turns euros into Twenty's micros and normalises the stage", () => {
    const body = buildOpportunityBody({ name: "Traject", stage: "meeting", amount: 25000 });
    expect(body).toMatchObject({
      name: "Traject",
      stage: "MEETING",
      amount: { amountMicros: 25_000_000_000, currencyCode: "EUR" },
    });
  });

  // PILOT and VERLOREN are live in CATO; the CLI rejected both until 19-08-2026.
  it("accepts every stage that actually occurs in the pipeline", () => {
    for (const stage of ["NEW", "SCREENING", "MEETING", "PROPOSAL", "PILOT", "ON_HOLD", "CUSTOMER", "VERLOREN"]) {
      expect(buildOpportunityBody({ stage })).toMatchObject({ stage });
    }
  });

  it("refuses an unknown stage instead of writing it", () => {
    expect(() => buildOpportunityBody({ stage: "WON" })).toThrow(RecordWriteError);
    expect(() => buildOpportunityBody({ stage: "WON" })).toThrow(/Unknown stage/);
  });

  it("refuses a negative amount and a malformed close date", () => {
    expect(() => buildOpportunityBody({ amount: -5 })).toThrow(/non-negative/);
    expect(() => buildOpportunityBody({ closeDate: "26-08-2026" })).toThrow(/YYYY-MM-DD/);
  });

  it("expands a close date to an ISO timestamp", () => {
    expect(buildOpportunityBody({ closeDate: "2026-09-30" }))
      .toMatchObject({ closeDate: "2026-09-30T00:00:00.000Z" });
  });

  it("refuses an empty write", () => {
    expect(() => buildOpportunityBody({})).toThrow(/Nothing to write/);
  });
});

describe("requireCreateFields for opportunities", () => {
  it("insists on a company, because a company-less deal is invisible in the pipeline", () => {
    expect(() => requireCreateFields("opportunities", { name: "X", stage: "MEETING" }))
      .toThrow(/--company-id/);
  });

  it("insists on a name and a stage", () => {
    expect(() => requireCreateFields("opportunities", { companyId: "c-1", stage: "MEETING" }))
      .toThrow(/--name/);
    expect(() => requireCreateFields("opportunities", { name: "X", companyId: "c-1" }))
      .toThrow(/--stage/);
  });

  it("passes when all three are present", () => {
    expect(() => requireCreateFields("opportunities", { name: "X", companyId: "c-1", stage: "MEETING" }))
      .not.toThrow();
  });
});

describe("findOpenOpportunities", () => {
  it("returns only the stages that mean the deal is still running", async () => {
    const { client } = mockClient({
      "/rest/opportunities?limit=50&filter=companyId[eq]:c-1": {
        data: { opportunities: [
          { id: "o-1", stage: "MEETING", name: "loopt" },
          { id: "o-2", stage: "CUSTOMER", name: "gewonnen" },
          { id: "o-3", stage: "VERLOREN", name: "afgeblazen" },
          { id: "o-4", stage: "PILOT", name: "pilot loopt" },
          { id: "o-5", stage: "ON_HOLD", name: "geparkeerd, niet gesloten" },
        ] },
      },
    });
    const open = await findOpenOpportunities(client, "c-1");
    expect(open.map((o) => o.id)).toEqual(["o-1", "o-4", "o-5"]);
  });
});

describe("buildNoteBody", () => {
  it("writes both markdown and blocknote, because the UI renders blocknote", () => {
    const body = buildNoteBody({ title: "Gesprek", body: "regel een\nregel twee" }) as {
      title: string; bodyV2: { markdown: string; blocknote: string };
    };
    expect(body.title).toBe("Gesprek");
    expect(body.bodyV2.markdown).toBe("regel een\nregel twee");
    const blocks = JSON.parse(body.bodyV2.blocknote);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content[0].text).toBe("regel een");
  });

  it("refuses a note without a title or without a body", () => {
    expect(() => buildNoteBody({ body: "tekst" })).toThrow(/--title/);
    expect(() => buildNoteBody({ title: "Kop", body: "  " })).toThrow(/--body/);
  });
});

describe("createNoteWithTargets", () => {
  it("creates the note and links it to company and person", async () => {
    const { client, calls } = mockClient({ "/rest/notes": { data: { createNote: { id: "n-1" } } } });
    const outcome = await createNoteWithTargets(
      client, { title: "t" }, { companyId: "c-1", personId: "p-1" }, BASE,
    );
    expect(outcome).toMatchObject({ action: "create", object: "notes", id: "n-1" });
    const targetCalls = calls.filter((c) => c.endpoint === "/rest/noteTargets");
    expect(targetCalls).toHaveLength(2);
    expect(targetCalls.map((c) => c.body)).toEqual([
      { noteId: "n-1", targetPersonId: "p-1" },
      { noteId: "n-1", targetCompanyId: "c-1" },
    ]);
  });

  // A note nobody can find is worse than no note: if the link fails, undo the note.
  it("removes the note again when linking fails", async () => {
    const calls: Array<{ endpoint: string; method: string }> = [];
    const client = {
      request: async (endpoint: string, opts: { method?: string } = {}) => {
        calls.push({ endpoint, method: opts.method ?? "GET" });
        if (endpoint === "/rest/noteTargets") throw new Error("nope");
        return { data: { createNote: { id: "n-1" } } };
      },
    } as never;
    await expect(createNoteWithTargets(client, { title: "t" }, { companyId: "c-1" }, BASE))
      .rejects.toThrow(/was removed again/);
    expect(calls).toContainEqual({ endpoint: "/rest/notes/n-1", method: "DELETE" });
  });
});
