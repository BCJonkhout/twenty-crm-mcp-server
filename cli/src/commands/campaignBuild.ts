// Building a campaign, as opposed to reviewing one.
//
// Endpoints mirror twenty-server/src/modules/marketing/controllers/
// marketing-campaign.controller.ts. Every route here is behind
// assertCanManageMarketing(), so they need a user token, not an API key.
//
// The order below is the actual working order and the reason these live in one
// file: create -> targets -> contacts -> generation -> schedule -> enable.
// Approval stays manual on purpose; there is no auto-approve helper here, and
// nothing in this file sends mail.

import type { RestClient } from "@twenty-crm/core";
import { MARKETING_BASE, type Campaign } from "./marketing.ts";

export interface CreateCampaignInput {
  name: string;
  description?: string;
  focusArea?: string;
  message?: string;
  mailSubject?: string;
  ctaLink?: string;
  ctaText?: string;
  channel?: "outbound" | "newsletter";
}

export class CampaignInputError extends Error {}

/**
 * Pure validation, so a bad campaign is rejected before it reaches production
 * rather than half-created there.
 */
export function planCreateCampaign(input: Partial<CreateCampaignInput>): CreateCampaignInput {
  const name = (input.name ?? "").trim();
  if (!name) throw new CampaignInputError("cato marketing create needs --name.");

  const channel = input.channel ?? "outbound";
  if (channel !== "outbound" && channel !== "newsletter") {
    throw new CampaignInputError("--channel must be 'outbound' or 'newsletter'.");
  }

  if (input.ctaLink && !/^https?:\/\//i.test(input.ctaLink)) {
    throw new CampaignInputError("--cta-link must be an absolute http(s) URL.");
  }

  const planned: CreateCampaignInput = { name, channel };
  for (const key of ["description", "focusArea", "message", "mailSubject", "ctaText", "ctaLink"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") planned[key] = value.trim();
  }
  return planned;
}

export async function createCampaign(
  client: RestClient,
  input: CreateCampaignInput,
): Promise<Campaign> {
  return client.request<Campaign>(`${MARKETING_BASE}/campaigns`, {
    method: "POST",
    body: input as unknown as Record<string, unknown>,
  });
}

export interface CompanyTargetInput {
  companyId: string;
}

/** Attaches specific companies as targets of a campaign. */
export async function addCompanyTargets(
  client: RestClient,
  campaignId: string,
  companyIds: string[],
): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/company-targets`, {
    method: "POST",
    body: { companyIds },
  });
}

/**
 * Server-side selection: hands the filter to CATO instead of paging every
 * company through the CLI. This is how a tagged list becomes an audience.
 */
export async function addMatchingCompanyTargets(
  client: RestClient,
  campaignId: string,
  filter: Record<string, unknown>,
): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/company-targets/add-matching`, {
    method: "POST",
    body: filter,
  });
}

export async function listCompanyTargets(
  client: RestClient,
  campaignId: string,
): Promise<Array<Record<string, unknown>>> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/company-targets`);
}

export async function attachMatchingMembers(
  client: RestClient,
  campaignId: string,
  filter: Record<string, unknown>,
): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/members/attach-matching`, {
    method: "POST",
    body: filter,
  });
}

export async function bulkAttachMembers(
  client: RestClient,
  campaignId: string,
  personIds: string[],
): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/members/bulk`, {
    method: "POST",
    body: { personIds },
  });
}

export async function setGeneration(
  client: RestClient,
  campaignId: string,
  on: boolean,
): Promise<unknown> {
  const path = on ? "generation/activate" : "generation/deactivate";
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/${path}`, {
    method: "POST",
    body: {},
  });
}

export async function setEnabled(
  client: RestClient,
  campaignId: string,
  isEnabled: boolean,
): Promise<Campaign> {
  return client.request<Campaign>(`${MARKETING_BASE}/campaigns/${campaignId}/enabled`, {
    method: "PATCH",
    body: { isEnabled },
  });
}

export async function updateSchedule(
  client: RestClient,
  campaignId: string,
  schedule: Record<string, unknown>,
): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/schedule`, {
    method: "PATCH",
    body: schedule,
  });
}

/** Sends one test mail to an address of your choosing. Never to the audience. */
export async function sendTest(
  client: RestClient,
  campaignId: string,
  email: string,
): Promise<unknown> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CampaignInputError(`'${email}' is not a valid email address.`);
  }
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/send-test`, {
    method: "POST",
    body: { email },
  });
}

/**
 * Turns `--source-system x --segment y` into the filter the server expects.
 * Kept pure so the audience can be shown before it is attached.
 */
export function buildAudienceFilter(opts: {
  sourceSystem?: string;
  segment?: string;
  branche?: string;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.sourceSystem) filter.prudaiMarketingSourceSystem = opts.sourceSystem;
  if (opts.segment) filter.prudaiMarketingSourceSegment = opts.segment;
  if (opts.branche) filter.branche = opts.branche;
  if (Object.keys(filter).length === 0) {
    throw new CampaignInputError(
      "Refusing to target everyone: pass at least one of --source-system, --segment or --branche.",
    );
  }
  return filter;
}

export function renderCreateDryRun(input: CreateCampaignInput): string {
  return [
    "DRY RUN — no campaign was created.",
    "",
    `Name     : ${input.name}`,
    `Channel  : ${input.channel}`,
    `Subject  : ${input.mailSubject ?? "(none — generated per recipient)"}`,
    `CTA      : ${input.ctaText ?? "(none)"} ${input.ctaLink ?? ""}`.trimEnd(),
    `Focus    : ${input.focusArea ?? "(none)"}`,
    "",
    "A new campaign starts disabled, with generation off and no members.",
    "Nothing is sent by creating it.",
    "",
    "Re-run with --no-dry-run --yes to create it.",
  ].join("\n");
}

export function renderAudienceDryRun(
  filter: Record<string, unknown>,
  campaignId: string,
  kind: "company-targets" | "members",
): string {
  return [
    `DRY RUN — no ${kind} were attached.`,
    "",
    `Campaign : ${campaignId}`,
    "Filter   :",
    ...Object.entries(filter).map(([k, v]) => `  ${k} = ${String(v)}`),
    "",
    "Attaching an audience does not send anything: every touchpoint still has to",
    "be generated and then approved by a person before CATO will dispatch it.",
    "",
    "Re-run with --no-dry-run --yes to attach.",
  ].join("\n");
}
