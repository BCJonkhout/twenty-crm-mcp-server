// `cato marketing ...` — the PrudAI marketing module of the CATO fork.
//
// AUTH REALITY (verified in the fork's source, not assumed):
// marketing-access.service.ts opens with `if (authContext.type !== 'user')` and
// hands anything that is not a user an accessLevel of 'none'. An API key has
// no workspace member, so EVERY /rest/marketing/* route except /access returns
// 403 for an API key. These commands therefore require a *user session token*
// (profile field `userToken` / $CATO_USER_TOKEN).
//
// APPROVAL IS A FEATURE. Every touchpoint must reach approvalState='approved'
// before it can be dispatched — that gate exists on both the automatic and the
// manual send path. This CLI exposes approve/reject/send-now one at a time,
// behind --no-dry-run --yes, and always prints the recipient count first.
// There is deliberately no bulk-approve and no auto-approve here.

import type { RestClient } from "@twenty-crm/core";

export const MARKETING_BASE = "/rest/marketing";

export class MarketingAuthError extends Error {}

export interface MarketingAccess {
  accessLevel: "none" | "sales_rep" | "full";
  canManageMarketing: boolean;
  canReadAssignedProgression: boolean;
  roleLabel: string | null;
  workspaceMemberId: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  description?: string | null;
  focusArea?: string | null;
  mailSubject?: string | null;
  sendBatchMode?: string | null;
  generationEnabled?: boolean;
  archivedAt?: string | null;
  [key: string]: unknown;
}

export interface ReviewQueueItem {
  touchpointId?: string;
  id?: string;
  campaignId?: string;
  approvalState?: string;
  personName?: string;
  personEmail?: string;
  subject?: string;
  phaseKey?: string;
  scheduledFor?: string | null;
  [key: string]: unknown;
}

export const CAMPAIGN_COLUMNS = [
  "id", "name", "focusArea", "mailSubject", "sendBatchMode", "generationEnabled", "archivedAt",
] as const;

export const REVIEW_QUEUE_COLUMNS = [
  "touchpointId", "approvalState", "phaseKey", "personName", "personEmail", "subject", "scheduledFor",
] as const;

export const APPROVAL_STATES = ["pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export function normalizeApprovalState(value: string | undefined): ApprovalState | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if ((APPROVAL_STATES as readonly string[]).includes(lower)) return lower as ApprovalState;
  throw new MarketingAuthError(`--state: '${value}' is not valid. Use one of: ${APPROVAL_STATES.join(", ")}.`);
}

/**
 * Filter a review queue by approval state. Kept pure: the endpoint returns the
 * whole queue for a campaign, and narrowing it is our job.
 */
export function filterReviewQueue(
  items: readonly ReviewQueueItem[],
  state: ApprovalState | null,
): ReviewQueueItem[] {
  if (!state) return [...items];
  return items.filter((item) => (item.approvalState ?? "").toLowerCase() === state);
}

/**
 * Since server-commit 3c570e37 the marketing module accepts an API key too, as
 * long as its role may manage marketing. A user token still wins when both are
 * present: it carries the workspace member the module scopes some reads by.
 */
export function assertMarketingAuth(
  userToken: string | undefined,
  apiKey?: string,
): string {
  const credential = userToken ?? apiKey;
  if (!credential) {
    throw new MarketingAuthError(
      "cato marketing needs a credential: a user session token or an API key whose role may manage marketing.\n" +
        "  Fix: cato auth set --profile <name> --stdin            (API key)\n" +
        "       cato auth set --profile <name> --user-token <t>   (browser session token)\n" +
        "  Check what a credential may do with: cato marketing access",
    );
  }
  return credential;
}

export async function getAccess(client: RestClient): Promise<MarketingAccess> {
  return client.request<MarketingAccess>(`${MARKETING_BASE}/access`);
}

export async function listCampaigns(client: RestClient): Promise<Campaign[]> {
  return client.request<Campaign[]>(`${MARKETING_BASE}/campaigns`);
}

export async function getCampaign(client: RestClient, campaignId: string): Promise<Campaign> {
  const campaigns = await listCampaigns(client);
  const found = campaigns.find((c) => c.id === campaignId);
  if (!found) throw new MarketingAuthError(`Campaign ${campaignId} not found in this workspace.`);
  return found;
}

export async function listReviewQueue(client: RestClient, campaignId: string): Promise<ReviewQueueItem[]> {
  return client.request<ReviewQueueItem[]>(`${MARKETING_BASE}/campaigns/${campaignId}/review-queue`);
}

export async function listMembers(client: RestClient, campaignId: string): Promise<Array<Record<string, unknown>>> {
  return client.request<Array<Record<string, unknown>>>(`${MARKETING_BASE}/campaigns/${campaignId}/members`);
}

export async function getSchedule(client: RestClient, campaignId: string): Promise<Record<string, unknown>> {
  const campaign = await getCampaign(client, campaignId);
  const schedule = campaign.schedule;
  if (schedule && typeof schedule === "object") return schedule as Record<string, unknown>;
  throw new MarketingAuthError(
    `Campaign ${campaignId} carries no schedule object. The schedule is edited via PATCH ${MARKETING_BASE}/campaigns/:id/schedule.`,
  );
}

export async function getTouchpoint(client: RestClient, touchpointId: string): Promise<ReviewQueueItem> {
  return client.request<ReviewQueueItem>(`${MARKETING_BASE}/touchpoints/${touchpointId}`);
}

export async function approveTouchpoint(client: RestClient, touchpointId: string): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/touchpoints/${touchpointId}/approve`, { method: "POST", body: {} });
}

export async function rejectTouchpoint(client: RestClient, touchpointId: string): Promise<unknown> {
  return client.request(`${MARKETING_BASE}/touchpoints/${touchpointId}/reject`, { method: "POST", body: {} });
}

export async function sendApprovedNow(
  client: RestClient,
  campaignId: string,
): Promise<{ sentCount: number; errorCount: number }> {
  return client.request(`${MARKETING_BASE}/campaigns/${campaignId}/send-approved-now`, {
    method: "POST",
    body: {},
  });
}

// ---- dry-run renderers ----------------------------------------------------

export function renderApproveDryRun(item: ReviewQueueItem, action: "approve" | "reject"): string {
  return [
    `DRY RUN — touchpoint NOT ${action === "approve" ? "approved" : "rejected"}.`,
    "",
    `Touchpoint : ${item.touchpointId ?? item.id ?? "(unknown)"}`,
    `State      : ${item.approvalState ?? "(unknown)"}`,
    `Recipient  : ${item.personName ?? "(unknown)"} <${item.personEmail ?? "no e-mail"}>`,
    `Subject    : ${item.subject ?? "(none)"}`,
    `Phase      : ${item.phaseKey ?? "(none)"}`,
    "",
    `Recipients affected: 1`,
    action === "approve"
      ? "Approving makes this mail eligible for the next send window. It does not send it immediately."
      : "Rejecting takes this mail out of the queue.",
    "",
    `To actually ${action}: re-run with --no-dry-run --yes`,
  ].join("\n");
}

export function renderSendNowDryRun(campaign: Campaign, approved: readonly ReviewQueueItem[]): string {
  const recipients = approved
    .map((i) => i.personEmail)
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  const preview = recipients.slice(0, 10);
  return [
    "DRY RUN — nothing was sent.",
    "",
    `Campaign            : ${campaign.name} (${campaign.id})`,
    `Approved touchpoints: ${approved.length}`,
    `Recipients affected : ${recipients.length}`,
    "",
    "First recipients:",
    ...(preview.length ? preview.map((e) => `  ${e}`) : ["  (none)"]),
    ...(recipients.length > preview.length ? [`  ... and ${recipients.length - preview.length} more`] : []),
    "",
    "This would send real e-mail via SendGrid to real people, immediately,",
    "bypassing the scheduled send window.",
    "",
    "To actually send: re-run with --no-dry-run --yes",
  ].join("\n");
}
