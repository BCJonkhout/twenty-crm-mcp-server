// Flat-input → Twenty composite-field transforms. Ported verbatim from the
// original index.js so existing callers keep working.

import type { RestClient } from "./rest.ts";

export interface PersonInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  [key: string]: unknown;
}

export interface CompanyInput {
  name?: string;
  domainName?: string | Record<string, unknown>;
  address?: string | Record<string, unknown>;
  linkedinUrl?: string;
  xUrl?: string;
  annualRecurringRevenue?: number | Record<string, unknown>;
  [key: string]: unknown;
}

export interface BodyInput {
  body?: string;
  [key: string]: unknown;
}

export function transformPersonData(data: PersonInput): Record<string, unknown> {
  const t: Record<string, unknown> = { ...data };
  if (t.firstName || t.lastName) {
    // Only the halves that were actually supplied. Defaulting the other half to
    // "" is harmless on a create but blanks the existing value on a PATCH.
    const name: Record<string, string> = {};
    if (t.firstName) name.firstName = t.firstName as string;
    if (t.lastName) name.lastName = t.lastName as string;
    t.name = name;
    delete t.firstName;
    delete t.lastName;
  }
  if (t.email) {
    t.emails = { primaryEmail: t.email };
    delete t.email;
  }
  if (t.phone) {
    t.phones = { primaryPhoneNumber: t.phone };
    delete t.phone;
  }
  if (t.linkedinUrl) {
    t.linkedinLink = { url: t.linkedinUrl, label: "LinkedIn" };
    delete t.linkedinUrl;
  }
  return t;
}

export function transformCompanyData(data: CompanyInput): Record<string, unknown> {
  const t: Record<string, unknown> = { ...data };
  if (typeof t.domainName === "string") {
    const domain = t.domainName;
    t.domainName = {
      primaryLinkLabel: domain,
      primaryLinkUrl: domain.startsWith("http") ? domain : `https://${domain}`,
      secondaryLinks: [],
    };
  }
  if (typeof t.address === "string") {
    t.address = {
      addressStreet1: t.address,
      addressStreet2: "",
      addressCity: "",
      addressPostcode: "",
      addressState: "",
      addressCountry: "",
      addressLat: null,
      addressLng: null,
    };
  }
  if (t.linkedinUrl) {
    t.linkedinLink = {
      primaryLinkLabel: "LinkedIn",
      primaryLinkUrl: t.linkedinUrl,
      secondaryLinks: [],
    };
    delete t.linkedinUrl;
  }
  if (t.xUrl) {
    t.xLink = {
      primaryLinkLabel: "X",
      primaryLinkUrl: t.xUrl,
      secondaryLinks: [],
    };
    delete t.xUrl;
  }
  if (typeof t.annualRecurringRevenue === "number") {
    t.annualRecurringRevenue = {
      amountMicros: t.annualRecurringRevenue * 1_000_000,
      currencyCode: "EUR",
    };
  }
  return t;
}

type InlineNode =
  | { type: "text"; text: string; styles: Record<string, boolean> }
  | { type: "link"; href: string; content: { type: "text"; text: string; styles: Record<string, boolean> }[] };

/**
 * Markdown-inline naar BlockNote-content: vet, cursief (met een ster of een
 * liggend streepje), `code` en [tekst](url). Bewust conservatief — wat niet als paar sluit blijft
 * letterlijke tekst staan, zodat "5 * 3" en "a-b" ongemoeid blijven.
 */
function parseInline(line: string): InlineNode[] {
  const out: InlineNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain, styles: {} });
    plain = "";
  };
  // Volgorde telt: ** vóór *, anders eet de cursief-regel de vette markering op.
  const rules: { re: RegExp; style?: string }[] = [
    { re: /^`([^`\n]+)`/, style: "code" },
    { re: /^\*\*([^\n]+?)\*\*/, style: "bold" },
    { re: /^\*([^\s*][^\n]*?)\*/, style: "italic" },
    { re: /^_([^\s_][^\n]*?)_/, style: "italic" },
  ];
  let rest = line;
  outer: while (rest.length > 0) {
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push({
        type: "link",
        href: link[2],
        content: [{ type: "text", text: link[1], styles: {} }],
      });
      rest = rest.slice(link[0].length);
      continue;
    }
    for (const { re, style } of rules) {
      const m = re.exec(rest);
      if (m) {
        flush();
        out.push({ type: "text", text: m[1], styles: { [style as string]: true } });
        rest = rest.slice(m[0].length);
        continue outer;
      }
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return out.length > 0 ? out : [{ type: "text", text: "", styles: {} }];
}

/**
 * Eén markdown-regel naar één BlockNote-blok. Koppen, opsommingen en
 * genummerde lijsten krijgen hun eigen bloktype; de rest wordt een alinea.
 */
function lineToBlock(line: string, id: string) {
  const props: Record<string, unknown> = {
    textColor: "default", backgroundColor: "default", textAlignment: "left",
  };
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    return {
      id, type: "heading",
      props: { ...props, level: heading[1].length },
      content: parseInline(heading[2]), children: [],
    };
  }
  const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
  if (bullet) {
    return { id, type: "bulletListItem", props, content: parseInline(bullet[1]), children: [] };
  }
  const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (numbered) {
    return { id, type: "numberedListItem", props, content: parseInline(numbered[1]), children: [] };
  }
  return { id, type: "paragraph", props, content: parseInline(line), children: [] };
}

/**
 * De taakbody's die agents schrijven zijn markdown. Tot 31-08-2026 werd élke
 * regel een platte alinea, waardoor koppen, opsommingen en vet als letterlijke
 * tekens in CATO stonden en elke lege regel een leeg blok werd — bij een body
 * van enige lengte hield de editor er halverwege mee op. `markdown` blijft de
 * onbewerkte brontekst; alleen `blocknote` is nu opgemaakt.
 */
export function transformBodyField(data: BodyInput): Record<string, unknown> {
  const t: Record<string, unknown> = { ...data };
  if (t.body === undefined) return t;
  const text = t.body as string;
  const stamp = Date.now();
  const blocks = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => lineToBlock(line, `block-${stamp}-${i}`));
  t.bodyV2 = {
    blocknote: JSON.stringify(blocks),
    markdown: text,
  };
  delete t.body;
  return t;
}

export type TargetType = "note" | "task";

export async function createTargetsForRecord(
  client: RestClient,
  type: TargetType,
  recordId: string,
  targetPersonIds: string[] = [],
  targetCompanyIds: string[] = [],
  targetOpportunityIds: string[] = [],
): Promise<unknown[]> {
  const endpoint = type === "note" ? "/rest/noteTargets" : "/rest/taskTargets";
  const idField = type === "note" ? "noteId" : "taskId";
  const created: unknown[] = [];
  for (const personId of targetPersonIds ?? []) {
    const target = await client.request(endpoint, {
      method: "POST",
      body: { [idField]: recordId, targetPersonId: personId },
    });
    created.push(target);
  }
  for (const companyId of targetCompanyIds ?? []) {
    const target = await client.request(endpoint, {
      method: "POST",
      body: { [idField]: recordId, targetCompanyId: companyId },
    });
    created.push(target);
  }
  // Both target tables carry targetOpportunityId (verified on crm.prudai.com
  // v1.19: noteTarget and taskTarget expose targetCompany/targetPerson/
  // targetOpportunity as morph relations).
  for (const opportunityId of targetOpportunityIds ?? []) {
    const target = await client.request(endpoint, {
      method: "POST",
      body: { [idField]: recordId, targetOpportunityId: opportunityId },
    });
    created.push(target);
  }
  return created;
}

interface MaybeIdResult {
  id?: string;
  data?: Record<string, unknown> & { id?: string };
}

export function extractId(result: unknown): string | null {
  // Twenty responses nest the record under varying keys (data.createX, data.X).
  // Return the first plausible id.
  if (!result) return null;
  const r = result as MaybeIdResult;
  if (r.id) return r.id;
  const data = r.data;
  if (!data) return null;
  if (data.id) return data.id;
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v && typeof v === "object" && (v as { id?: string }).id) return (v as { id: string }).id;
  }
  return null;
}
