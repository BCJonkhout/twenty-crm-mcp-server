// Acceptance check for a contact-research run.
//
// "Candidates appeared" is not the same as "these people exist". Verifying
// names by crawling firm websites proved unreliable — jongbloed.tv did not load
// at all, and a lawyer we know from a competitor's own testimonial came back as
// "not found". So this checks the things that can be measured honestly:
// deliverability, domain agreement, coverage, and shapes that look like
// invention rather than research.
//
// It reports. It does not attach, delete or mail anything.

import { promises as dns } from "dns";

export interface ResearchCandidate {
  companyId: string;
  companyName: string;
  companyDomain?: string | null;
  displayName: string;
  jobTitle?: string | null;
  primaryEmail?: string | null;
  /** The page the model says it found this person on. */
  sourceUrl?: string | null;
  validationWarnings?: unknown[] | null;
}

export type CitationQuality = "own-site" | "third-party" | "search-redirect" | "none";

/**
 * Google's grounding tool hands back redirect URLs rather than the page it
 * read, so those cannot be judged either way — they are reported as their own
 * category instead of being counted as bad.
 */
const SEARCH_REDIRECT = /vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i;

/**
 * A candidate cited to the firm's own domain is the strong case: the model is
 * pointing at the team page it read. A citation to a different domain is where
 * the two genuinely wrong attributions in the 2026-08-02 run showed up — a
 * lawyer taken from another firm's site, and one from a lead database.
 */
export function assessCitation(candidate: ResearchCandidate): CitationQuality {
  const url = candidate.sourceUrl?.trim();
  if (!url) return "none";
  if (SEARCH_REDIRECT.test(url)) return "search-redirect";

  const host = normaliseDomain(url.replace(/^https?:\/\//, ""));
  if (!host) return "third-party";

  // A firm's website and its mail domain are often not the same string —
  // Jongbloed publishes on jongbloedfiscaaljuristen.nl and mails from
  // jongbloed.tv. Comparing against the email domain alone marked their own
  // team pages as third-party. Either domain counts as the firm itself.
  const own = [emailDomain(candidate.primaryEmail), normaliseDomain(candidate.companyDomain)]
    .filter((d): d is string => Boolean(d));
  if (own.length === 0) return "third-party";

  const sameOrg = own.some((d) => host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`));
  return sameOrg ? "own-site" : "third-party";
}

export interface CompanyTargetSummary {
  companyId: string;
  companyName: string;
  status: string;
}

export type Severity = "blocker" | "warning" | "note";

export interface Finding {
  severity: Severity;
  what: string;
  detail: string;
  examples: string[];
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export function hasValidSyntax(email: string | null | undefined): boolean {
  return typeof email === "string" && EMAIL.test(email.trim());
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!hasValidSyntax(email)) return null;
  return email!.trim().toLowerCase().split("@")[1]!;
}

/** Strips www. and any path so a stored domainName compares like an email domain. */
export function normaliseDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  return cleaned || null;
}

/**
 * A researched contact whose email is on a different domain than the company
 * is the strongest single signal of invention: the model reached for a plausible
 * address rather than one it found.
 */
export function domainMatches(candidate: ResearchCandidate): boolean | null {
  const company = normaliseDomain(candidate.companyDomain);
  const mail = emailDomain(candidate.primaryEmail);
  if (!company || !mail) return null;
  return mail === company || mail.endsWith(`.${company}`) || company.endsWith(`.${mail}`);
}

export interface Coverage {
  companiesSearched: number;
  companiesWithCandidates: number;
  companiesWithout: string[];
  candidatesPerCompany: Map<string, number>;
  crowded: Array<{ company: string; count: number }>;
}

/**
 * `maxPerCompany` is the campaign's own maxTitleCandidatesPerCompany. More
 * candidates than the run was allowed to produce means something is generating
 * rather than selecting.
 */
export function assessCoverage(
  candidates: ResearchCandidate[],
  targets: CompanyTargetSummary[],
  maxPerCompany: number,
): Coverage {
  const perCompany = new Map<string, number>();
  const nameById = new Map<string, string>();
  for (const c of candidates) {
    perCompany.set(c.companyId, (perCompany.get(c.companyId) ?? 0) + 1);
    nameById.set(c.companyId, c.companyName);
  }

  const searched = targets.filter((t) => t.status === "searched" || t.status === "no_contacts_found");
  const without = searched
    .filter((t) => !perCompany.has(t.companyId))
    .map((t) => t.companyName);

  const crowded = [...perCompany.entries()]
    .filter(([, n]) => n > maxPerCompany)
    .map(([id, n]) => ({ company: nameById.get(id) ?? id, count: n }))
    .sort((a, b) => b.count - a.count);

  return {
    companiesSearched: searched.length,
    companiesWithCandidates: perCompany.size,
    companiesWithout: without,
    candidatesPerCompany: perCompany,
    crowded,
  };
}

/** MX lookup per unique domain. A domain that cannot receive mail is a blocker. */
/**
 * DNS answers three ways, and collapsing them to two produces a blocker that
 * comes and goes. NXDOMAIN/NODATA is the resolver stating there is no
 * mailserver; a timeout or SERVFAIL states nothing at all. Only the first is
 * grounds for refusing to send — the second belongs in "could not be judged",
 * or the check reports DO NOT SEND on a network hiccup and is then rightly
 * ignored the next time it says it.
 */
const CONCLUSIVE_DNS_ERRORS = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export async function checkDeliverability(
  domains: string[],
  resolve: (d: string) => Promise<unknown[]> = (d) => dns.resolveMx(d),
): Promise<{ deliverable: string[]; undeliverable: string[]; unresolved: string[] }> {
  const deliverable: string[] = [];
  const undeliverable: string[] = [];
  const unresolved: string[] = [];
  await Promise.all(
    [...new Set(domains)].map(async (domain) => {
      // One retry, because a single UDP timeout is not evidence of anything.
      for (let attempt = 0; ; attempt++) {
        try {
          const records = await resolve(domain);
          (records && records.length > 0 ? deliverable : undeliverable).push(domain);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code ?? "";
          if (CONCLUSIVE_DNS_ERRORS.has(code)) return void undeliverable.push(domain);
          if (attempt >= 1) return void unresolved.push(domain);
        }
      }
    }),
  );
  return {
    deliverable: deliverable.sort(),
    undeliverable: undeliverable.sort(),
    unresolved: unresolved.sort(),
  };
}

export interface AcceptanceInput {
  candidates: ResearchCandidate[];
  targets: CompanyTargetSummary[];
  maxPerCompany: number;
  undeliverableDomains: string[];
  /** Domains whose MX lookup gave no answer either way — never a blocker. */
  unresolvedDomains?: string[];
}

export interface Acceptance {
  totalCandidates: number;
  withValidEmail: number;
  citations: Record<CitationQuality, number>;
  coverage: Coverage;
  findings: Finding[];
  /** Checks that could not run at all, so a pass is never mistaken for proof. */
  notEvaluated: string[];
  verdict: "usable" | "review" | "do-not-send";
}

export function assessAcceptance(input: AcceptanceInput): Acceptance {
  const { candidates, targets, maxPerCompany, undeliverableDomains } = input;
  const unresolvedDomains = input.unresolvedDomains ?? [];
  const findings: Finding[] = [];

  const badSyntax = candidates.filter((c) => !hasValidSyntax(c.primaryEmail));
  if (badSyntax.length > 0) {
    findings.push({
      severity: "blocker",
      what: `${badSyntax.length} candidate(s) without a usable email address`,
      detail: "Nothing can be sent to these, and they cannot be personalised on either.",
      examples: badSyntax.slice(0, 5).map((c) => `${c.companyName}: ${c.displayName}`),
    });
  }

  const undeliverable = new Set(undeliverableDomains.map((d) => d.toLowerCase()));
  const onDeadDomain = candidates.filter((c) => {
    const d = emailDomain(c.primaryEmail);
    return d !== null && undeliverable.has(d);
  });
  if (onDeadDomain.length > 0) {
    findings.push({
      severity: "blocker",
      what: `${onDeadDomain.length} candidate(s) on a domain that cannot receive mail`,
      detail: "Sending to these produces bounces, which cost sender reputation.",
      examples: [...new Set(onDeadDomain.map((c) => emailDomain(c.primaryEmail)!))].slice(0, 5),
    });
  }

  const mismatched = candidates.filter((c) => domainMatches(c) === false);
  if (mismatched.length > 0) {
    findings.push({
      severity: "warning",
      what: `${mismatched.length} candidate(s) whose email domain differs from their company`,
      detail:
        "The strongest signal that an address was constructed rather than found. " +
        "Check these by hand before attaching them.",
      examples: mismatched.slice(0, 5).map((c) => `${c.companyName}: ${c.primaryEmail}`),
    });
  }

  const coverage = assessCoverage(candidates, targets, maxPerCompany);
  if (coverage.crowded.length > 0) {
    findings.push({
      severity: "warning",
      what: `${coverage.crowded.length} compan(y|ies) with more candidates than the run allowed`,
      detail: `The campaign caps at ${maxPerCompany} per company; more than that means generating, not selecting.`,
      examples: coverage.crowded.slice(0, 5).map((c) => `${c.company}: ${c.count}`),
    });
  }

  if (coverage.companiesSearched > 0) {
    const rate = coverage.companiesWithCandidates / coverage.companiesSearched;
    if (rate < 0.25) {
      findings.push({
        severity: "warning",
        what: `only ${coverage.companiesWithCandidates} of ${coverage.companiesSearched} searched companies produced a contact`,
        detail:
          "A low rate usually means the run is not actually searching — check the job titles " +
          "on the campaign and that the research model still grounds.",
        examples: coverage.companiesWithout.slice(0, 5),
      });
    }
  }

  const citations: Record<CitationQuality, number> = {
    "own-site": 0, "third-party": 0, "search-redirect": 0, none: 0,
  };
  for (const c of candidates) citations[assessCitation(c)] += 1;

  if (citations["third-party"] > 0) {
    findings.push({
      severity: "warning",
      what: `${citations["third-party"]} candidate(s) cited to a page that is not the firm's own site`,
      detail:
        "Both genuinely wrong attributions in the first real run looked like this: " +
        "a person taken from another firm's site, and one from a lead database.",
      examples: candidates
        .filter((c) => assessCitation(c) === "third-party")
        .slice(0, 5)
        .map((c) => `${c.companyName}: ${c.displayName} — ${c.sourceUrl}`),
    });
  }
  if (citations.none > 0) {
    findings.push({
      severity: "warning",
      what: `${citations.none} candidate(s) with no source at all`,
      detail: "Nothing points at where this person was found, so nothing can be checked.",
      examples: candidates.filter((c) => assessCitation(c) === "none")
        .slice(0, 5).map((c) => `${c.companyName}: ${c.displayName}`),
    });
  }

  const flaggedByModule = candidates.filter(
    (c) => Array.isArray(c.validationWarnings) && c.validationWarnings.length > 0,
  );
  if (flaggedByModule.length > 0) {
    findings.push({
      severity: "warning",
      what: `${flaggedByModule.length} candidate(s) the research itself flagged`,
      detail: "The module recorded a validation warning while producing these.",
      examples: flaggedByModule.slice(0, 5).map((c) => `${c.companyName}: ${c.displayName}`),
    });
  }

  // Say what could NOT be judged. A check that silently skips is how a broken
  // run passes review — the failure mode this whole verification exists to catch.
  const notEvaluated: string[] = [];
  const withCompanyDomain = candidates.filter((c) => normaliseDomain(c.companyDomain) !== null).length;
  if (withCompanyDomain === 0 && candidates.length > 0) {
    notEvaluated.push(
      "email domain vs company domain — no candidate carried a company domain to compare against",
    );
  }
  if (unresolvedDomains.length > 0) {
    notEvaluated.push(
      `deliverability of ${unresolvedDomains.length} domain(s) — the MX lookup timed out rather than answering: ${unresolvedDomains.slice(0, 5).join(", ")}`,
    );
  }
  if (citations["search-redirect"] > 0) {
    notEvaluated.push(
      `${citations["search-redirect"]} citation(s) point at a Google grounding redirect, which cannot be resolved to a page`,
    );
  }

  const withValidEmail = candidates.filter((c) => hasValidSyntax(c.primaryEmail)).length;
  const hasBlocker = findings.some((f) => f.severity === "blocker");
  const hasWarning = findings.some((f) => f.severity === "warning");

  return {
    totalCandidates: candidates.length,
    withValidEmail,
    citations,
    coverage,
    findings,
    notEvaluated,
    verdict: hasBlocker ? "do-not-send" : hasWarning ? "review" : "usable",
  };
}

const VERDICT_LINE: Record<Acceptance["verdict"], string> = {
  usable: "USABLE — nothing here blocks a careful send.",
  review: "REVIEW — usable only after someone looks at the warnings below.",
  "do-not-send": "DO NOT SEND — fix the blockers first.",
};

export function renderAcceptance(a: Acceptance): string {
  const lines = [
    `Candidates            : ${a.totalCandidates}`,
    `With an address       : ${a.withValidEmail}`,
    `Cited to the firm site: ${a.citations["own-site"]}`,
    `Cited elsewhere       : ${a.citations["third-party"]}`,
    `Cited via a redirect  : ${a.citations["search-redirect"]}`,
    `Not cited at all      : ${a.citations.none}`,
    `Companies searched    : ${a.coverage.companiesSearched}`,
    `…with a contact       : ${a.coverage.companiesWithCandidates}`,
    "",
    VERDICT_LINE[a.verdict],
  ];

  for (const f of a.findings) {
    lines.push("", `[${f.severity.toUpperCase()}] ${f.what}`, `  ${f.detail}`);
    for (const e of f.examples) lines.push(`    ${e}`);
  }

  if (a.notEvaluated.length > 0) {
    lines.push("", "COULD NOT BE JUDGED (a pass here proves nothing):");
    for (const n of a.notEvaluated) lines.push(`  ${n}`);
  }

  lines.push(
    "",
    "This checks deliverability, citation quality and coverage — not whether the",
    "people exist. Measured on 2026-08-02: 87 of 95 checkable candidates did appear",
    "on the page the model cited. Treat every candidate as a proposal for the",
    "selection step, not as a verified contact.",
  );
  return lines.join("\n");
}
