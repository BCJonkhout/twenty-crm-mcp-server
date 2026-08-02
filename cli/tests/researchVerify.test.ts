import { describe, expect, it } from "bun:test";
import {
  assessAcceptance, assessCitation, assessCoverage, checkDeliverability, domainMatches, emailDomain,
  hasValidSyntax, normaliseDomain, renderAcceptance, type ResearchCandidate,
} from "../src/commands/researchVerify.ts";

const candidate = (over: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  companyId: "c1", companyName: "Kantoor", companyDomain: "kantoor.nl",
  displayName: "Anne Jansen", jobTitle: "Advocaat", primaryEmail: "a.jansen@kantoor.nl",
  sourceUrl: "https://www.kantoor.nl/ons-team",
  ...over,
});

describe("hasValidSyntax", () => {
  it("accepts a normal address", () => {
    expect(hasValidSyntax("d.jongbloed@jongbloed.tv")).toBe(true);
  });

  it("rejects what cannot be mailed", () => {
    for (const bad of ["", "   ", "geen", "a@b", "a@@b.nl", null, undefined]) {
      expect(hasValidSyntax(bad as string)).toBe(false);
    }
  });
});

describe("normaliseDomain", () => {
  it("strips scheme, www and path so it compares like an email domain", () => {
    expect(normaliseDomain("https://www.kantoor.nl/team")).toBe("kantoor.nl");
    expect(normaliseDomain("KANTOOR.NL")).toBe("kantoor.nl");
  });

  it("returns null for nothing", () => {
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain(null)).toBeNull();
  });
});

describe("domainMatches", () => {
  it("accepts an address on the company's own domain", () => {
    expect(domainMatches(candidate())).toBe(true);
    expect(domainMatches(candidate({ companyDomain: "https://www.kantoor.nl" }))).toBe(true);
  });

  it("accepts a subdomain in either direction", () => {
    expect(domainMatches(candidate({ primaryEmail: "a@mail.kantoor.nl" }))).toBe(true);
    expect(domainMatches(candidate({ companyDomain: "mail.kantoor.nl" }))).toBe(true);
  });

  // The clearest sign an address was constructed rather than found.
  it("rejects an address on an unrelated domain", () => {
    expect(domainMatches(candidate({ primaryEmail: "a.jansen@gmail.com" }))).toBe(false);
  });

  it("says 'unknown' rather than guessing when the company has no domain", () => {
    expect(domainMatches(candidate({ companyDomain: null }))).toBeNull();
    expect(domainMatches(candidate({ primaryEmail: "" }))).toBeNull();
  });
});

describe("assessCoverage", () => {
  const targets = [
    { companyId: "c1", companyName: "Een", status: "searched" },
    { companyId: "c2", companyName: "Twee", status: "no_contacts_found" },
    { companyId: "c3", companyName: "Drie", status: "queued" },
  ];

  it("counts only companies the run actually finished", () => {
    const cov = assessCoverage([candidate()], targets, 4);

    expect(cov.companiesSearched).toBe(2);
    expect(cov.companiesWithCandidates).toBe(1);
    expect(cov.companiesWithout).toEqual(["Twee"]);
  });

  it("flags a company with more candidates than the run was allowed", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      candidate({ displayName: `Persoon ${i}`, primaryEmail: `p${i}@kantoor.nl` }));
    const cov = assessCoverage(many, targets, 4);

    expect(cov.crowded).toEqual([{ company: "Kantoor", count: 6 }]);
  });

  it("does not flag a company at exactly the cap", () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      candidate({ primaryEmail: `p${i}@kantoor.nl` }));

    expect(assessCoverage(four, targets, 4).crowded).toEqual([]);
  });
});

describe("checkDeliverability", () => {
  it("separates domains that can receive mail from those that cannot", async () => {
    const result = await checkDeliverability(
      ["goed.nl", "leeg.nl", "stuk.nl"],
      async (d) => {
        if (d === "stuk.nl") throw new Error("ENOTFOUND");
        return d === "leeg.nl" ? [] : [{ exchange: "mx" }];
      },
    );

    expect(result.deliverable).toEqual(["goed.nl"]);
    expect(result.undeliverable).toEqual(["leeg.nl", "stuk.nl"]);
  });

  it("looks each domain up once, however many candidates share it", async () => {
    const seen: string[] = [];
    await checkDeliverability(["a.nl", "a.nl", "a.nl"], async (d) => {
      seen.push(d);
      return [{ exchange: "mx" }];
    });

    expect(seen).toEqual(["a.nl"]);
  });
});

describe("assessAcceptance", () => {
  const targets = [{ companyId: "c1", companyName: "Kantoor", status: "searched" }];
  const base = { targets, maxPerCompany: 4, undeliverableDomains: [] as string[] };

  it("calls a clean run usable", () => {
    const a = assessAcceptance({ ...base, candidates: [candidate()] });

    expect(a.verdict).toBe("usable");
    expect(a.findings).toEqual([]);
    expect(a.withValidEmail).toBe(1);
  });

  it("blocks a run whose addresses cannot receive mail", () => {
    const a = assessAcceptance({
      ...base,
      candidates: [candidate()],
      undeliverableDomains: ["kantoor.nl"],
    });

    expect(a.verdict).toBe("do-not-send");
    expect(a.findings[0]!.detail).toContain("bounces");
  });

  it("blocks a candidate with no address at all", () => {
    const a = assessAcceptance({ ...base, candidates: [candidate({ primaryEmail: null })] });

    expect(a.verdict).toBe("do-not-send");
  });

  it("asks for review when an address sits on a foreign domain", () => {
    const a = assessAcceptance({
      ...base,
      candidates: [candidate({ primaryEmail: "a.jansen@gmail.com" })],
    });

    expect(a.verdict).toBe("review");
    expect(a.findings[0]!.what).toContain("differs from their company");
  });

  // The exact shape of the broken runs: everything "searched", nothing found.
  it("warns when almost nothing was found, because that means it did not search", () => {
    const manyTargets = Array.from({ length: 20 }, (_, i) => ({
      companyId: `c${i}`, companyName: `Kantoor ${i}`, status: "no_contacts_found",
    }));
    const a = assessAcceptance({ ...base, targets: manyTargets, candidates: [] });

    expect(a.verdict).toBe("review");
    expect(a.findings.some((f) => f.what.includes("produced a contact"))).toBe(true);
  });

  it("does not warn about a healthy find rate", () => {
    const t = Array.from({ length: 4 }, (_, i) => ({
      companyId: `c${i}`, companyName: `K${i}`, status: "searched",
    }));
    const c = t.map((x, i) => candidate({ companyId: x.companyId, primaryEmail: `p${i}@kantoor.nl`, companyDomain: null }));
    const a = assessAcceptance({ ...base, targets: t, candidates: c });

    expect(a.findings.some((f) => f.what.includes("produced a contact"))).toBe(false);
  });
});

describe("renderAcceptance", () => {
  it("states the verdict and refuses to claim the people were verified", () => {
    const text = renderAcceptance(assessAcceptance({
      targets: [{ companyId: "c1", companyName: "Kantoor", status: "searched" }],
      candidates: [candidate()], maxPerCompany: 4, undeliverableDomains: [],
    }));

    expect(text).toContain("USABLE");
    expect(text).toContain("not whether the");
    expect(text).toContain("not as a verified contact");
  });
});

describe("assessCitation", () => {
  const cited = (sourceUrl: string | null, email = "a@kantoor.nl") =>
    candidate({ sourceUrl, primaryEmail: email });

  it("calls a citation to the firm's own site the strong case", () => {
    expect(assessCitation(cited("https://www.kantoor.nl/team"))).toBe("own-site");
    expect(assessCitation(cited("https://kantoor.nl/over-ons/mensen"))).toBe("own-site");
  });

  // Both genuinely wrong attributions in the first real run had this shape.
  it("flags a citation to somebody else's site", () => {
    expect(assessCitation(cited("https://www.bonusadvocaten.be/team/jeffrey"))).toBe("third-party");
    expect(assessCitation(cited("https://prospeo.io/companies/rosholmdell"))).toBe("third-party");
  });

  it("keeps a Google grounding redirect as its own category, not as wrong", () => {
    expect(assessCitation(cited("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC")))
      .toBe("search-redirect");
  });

  it("reports a missing citation as none", () => {
    expect(assessCitation(cited(null))).toBe("none");
    expect(assessCitation(cited("   "))).toBe("none");
  });
});

describe("honesty about what could not be judged", () => {
  const targets = [{ companyId: "c1", companyName: "Kantoor", status: "searched" }];

  // The exact trap this whole verification exists to avoid: the first version
  // of this check reported USABLE while its domain comparison had silently not
  // run, because no candidate carried a company domain.
  it("says so when the company-domain comparison had nothing to compare", () => {
    const a = assessAcceptance({
      targets, maxPerCompany: 4, undeliverableDomains: [],
      candidates: [candidate({ companyDomain: null, sourceUrl: "https://kantoor.nl/team" })],
    });

    expect(a.notEvaluated.join(" ")).toContain("no candidate carried a company domain");
    expect(renderAcceptance(a)).toContain("COULD NOT BE JUDGED");
  });

  it("says how many citations point at an unresolvable redirect", () => {
    const a = assessAcceptance({
      targets, maxPerCompany: 4, undeliverableDomains: [],
      candidates: [candidate({
        companyDomain: "kantoor.nl",
        sourceUrl: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x",
      })],
    });

    expect(a.notEvaluated.join(" ")).toContain("grounding redirect");
  });

  it("stays quiet about non-evaluation when everything could be judged", () => {
    const a = assessAcceptance({
      targets, maxPerCompany: 4, undeliverableDomains: [],
      candidates: [candidate({ companyDomain: "kantoor.nl", sourceUrl: "https://kantoor.nl/team" })],
    });

    expect(a.notEvaluated).toEqual([]);
    expect(a.verdict).toBe("usable");
  });

  it("surfaces a warning the research itself recorded", () => {
    const a = assessAcceptance({
      targets, maxPerCompany: 4, undeliverableDomains: [],
      candidates: [candidate({
        companyDomain: "kantoor.nl", sourceUrl: "https://kantoor.nl/team",
        validationWarnings: ["email guessed"],
      })],
    });

    expect(a.verdict).toBe("review");
    expect(a.findings.some((f) => f.what.includes("research itself flagged"))).toBe(true);
  });
});
