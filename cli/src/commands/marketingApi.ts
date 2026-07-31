// Full coverage of /rest/marketing, mirroring marketing-campaign.controller.ts
// and marketing-asset.controller.ts.
//
// Every route in the module has a function here so nothing forces you back into
// the UI. The safety posture is unchanged: this file only issues requests; the
// dry-run gate and the confirmation counts live in index.ts, and there is still
// no auto-approve path.

import type { RestClient } from "@twenty-crm/core";
import { MARKETING_BASE, type Campaign } from "./marketing.ts";

export class MarketingVerbError extends Error {}

/**
 * Subcommands take a noun (`members`) plus a verb (`remove`). Validating the
 * verb up front means a typo fails before it reaches production rather than
 * silently doing the default thing.
 */
export function requireVerb(
  noun: string,
  verb: string | undefined,
  allowed: readonly string[],
): string {
  const chosen = (verb ?? allowed[0]!).toLowerCase();
  if (!allowed.includes(chosen)) {
    throw new MarketingVerbError(
      `cato marketing ${noun}: unknown action '${chosen}'. Use one of: ${allowed.join(", ")}.`,
    );
  }
  return chosen;
}

const c = (campaignId: string) => `${MARKETING_BASE}/campaigns/${campaignId}`;
const post = (client: RestClient, path: string, body: Record<string, unknown> = {}) =>
  client.request(path, { method: "POST", body });
const patch = (client: RestClient, path: string, body: Record<string, unknown>) =>
  client.request(path, { method: "PATCH", body });

// ---------------------------------------------------------------- campaigns
export const updateCampaign = (client: RestClient, id: string, body: Record<string, unknown>) =>
  patch(client, c(id), body) as Promise<Campaign>;
export const archiveCampaign = (client: RestClient, id: string) => post(client, `${c(id)}/archive`);
export const restoreCampaign = (client: RestClient, id: string) => post(client, `${c(id)}/restore`);
export const deleteCampaign = (client: RestClient, id: string) =>
  client.request(c(id), { method: "DELETE" });

// ---------------------------------------------------------------- prompts & schedule
export const getPrompts = (client: RestClient, id: string) =>
  client.request<Record<string, unknown>>(`${c(id)}/prompts`);
export const setPrompts = (client: RestClient, id: string, body: Record<string, unknown>) =>
  patch(client, `${c(id)}/prompts`, body);
export const setSchedule = (client: RestClient, id: string, body: Record<string, unknown>) =>
  patch(client, `${c(id)}/schedule`, body);

// ---------------------------------------------------------------- company targets
export const listTargets = (client: RestClient, id: string) =>
  client.request<Array<Record<string, unknown>>>(`${c(id)}/company-targets`);
export const addTargets = (client: RestClient, id: string, companyIds: string[]) =>
  post(client, `${c(id)}/company-targets`, { companyIds });
export const addMatchingTargets = (client: RestClient, id: string, filter: Record<string, unknown>) =>
  post(client, `${c(id)}/company-targets/add-matching`, filter);
export const removeTarget = (client: RestClient, id: string, targetId: string) =>
  client.request(`${c(id)}/company-targets/${targetId}`, { method: "DELETE" });

// ---------------------------------------------------------------- contact research
export const startResearch = (client: RestClient, id: string, body: Record<string, unknown> = {}) =>
  post(client, `${c(id)}/contact-research/start`, body);
export const stopResearch = (client: RestClient, id: string) =>
  post(client, `${c(id)}/contact-research/stop`);
export const researchTarget = (client: RestClient, id: string, targetId: string) =>
  post(client, `${c(id)}/company-targets/${targetId}/research`);
export const getSearchSettings = (client: RestClient, id: string) =>
  client.request<Record<string, unknown>>(`${c(id)}/contact-search-settings`);
export const setSearchSettings = (client: RestClient, id: string, body: Record<string, unknown>) =>
  patch(client, `${c(id)}/contact-search-settings`, body);
export const listTargetCrmContacts = (client: RestClient, id: string, targetId: string) =>
  client.request<Array<Record<string, unknown>>>(`${c(id)}/company-targets/${targetId}/crm-contacts`);
export const stageTargetContacts = (
  client: RestClient, id: string, targetId: string, body: Record<string, unknown>,
) => post(client, `${c(id)}/company-targets/${targetId}/contact-candidates`, body);

/**
 * Research progress, derived from the targets themselves. The module has no
 * status endpoint, and "is it done" is the question you actually have when a
 * run is going over hundreds of companies.
 */
export interface ResearchProgress {
  total: number;
  byStatus: Record<string, number>;
  done: number;
  outstanding: number;
  finished: boolean;
}

export function summariseResearch(targets: Array<Record<string, unknown>>): ResearchProgress {
  const byStatus: Record<string, number> = {};
  for (const t of targets) {
    const s = String(t.status ?? "unknown");
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const outstanding = (byStatus.queued ?? 0) + (byStatus.not_searched ?? 0) + (byStatus.researching ?? 0);
  const total = targets.length;
  return { total, byStatus, done: total - outstanding, outstanding, finished: total > 0 && outstanding === 0 };
}

export function renderResearchProgress(p: ResearchProgress): string {
  const lines = [
    `Targets   : ${p.total}`,
    `Done      : ${p.done}`,
    `Outstanding: ${p.outstanding}`,
    "",
    "By status:",
    ...Object.entries(p.byStatus).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s.padEnd(20)} ${n}`),
  ];
  if (p.total === 0) lines.push("", "No company targets attached yet — nothing to research.");
  else if (p.finished) lines.push("", "Research is finished for every target.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- candidates
export const listSelectionCandidates = (client: RestClient, id: string) =>
  client.request<Array<Record<string, unknown>>>(`${c(id)}/contact-selection-candidates`);
export const attachCandidates = (client: RestClient, id: string, candidateIds: string[]) =>
  post(client, `${c(id)}/contact-selection-candidates/bulk-attach`, { candidateIds });
export const removeCandidates = (client: RestClient, id: string, candidateIds: string[]) =>
  post(client, `${c(id)}/contact-selection-candidates/bulk-remove`, { candidateIds });
export const attachCrmContacts = (client: RestClient, id: string, personIds: string[]) =>
  post(client, `${c(id)}/contact-selection-candidates/attach-crm-contacts`, { personIds });
export const listContactCandidates = (client: RestClient, id: string) =>
  client.request<Array<Record<string, unknown>>>(`${c(id)}/contact-candidates`);

// ---------------------------------------------------------------- members
export const listMembers = (client: RestClient, id: string) =>
  client.request<Array<Record<string, unknown>>>(`${c(id)}/members`);
export const attachPerson = (client: RestClient, id: string, personId: string) =>
  post(client, `${c(id)}/members`, { personId });
export const bulkAttachMembers = (client: RestClient, id: string, personIds: string[]) =>
  post(client, `${c(id)}/members/bulk`, { personIds });
export const attachMatchingMembers = (client: RestClient, id: string, filter: Record<string, unknown>) =>
  post(client, `${c(id)}/members/attach-matching`, filter);
export const removeMember = (client: RestClient, id: string, memberId: string) =>
  client.request(`${c(id)}/members/${memberId}`, { method: "DELETE" });
export const stopMember = (client: RestClient, id: string, memberId: string) =>
  post(client, `${c(id)}/members/${memberId}/stop`);
export const markMembersAsTodo = (client: RestClient, id: string, body: Record<string, unknown> = {}) =>
  post(client, `${c(id)}/members/mark-as-todo`, body);

// ---------------------------------------------------------------- touchpoints
export const regenerateTouchpoint = (client: RestClient, touchpointId: string) =>
  post(client, `${MARKETING_BASE}/touchpoints/${touchpointId}/regenerate`);
export const bulkApproveDrafts = (client: RestClient, id: string, body: Record<string, unknown> = {}) =>
  post(client, `${c(id)}/drafts/bulk-approve`, body);

// ---------------------------------------------------------------- lookups
export const listPeopleOptions = (client: RestClient) =>
  client.request<Array<Record<string, unknown>>>(`${MARKETING_BASE}/people`);
export const listContactFilterOptions = (client: RestClient) =>
  client.request<Record<string, unknown>>(`${MARKETING_BASE}/contact-filter-options`);
export const listCrmPicker = (client: RestClient) =>
  client.request<Record<string, unknown>>(`${MARKETING_BASE}/crm-picker`);

// ---------------------------------------------------------------- assets
export const listAssets = (client: RestClient) =>
  client.request<Array<Record<string, unknown>>>(`${MARKETING_BASE}/assets`);
export const createAsset = (client: RestClient, type: string, body: Record<string, unknown>) =>
  post(client, `${MARKETING_BASE}/assets/${type}`, body);
export const updateAsset = (client: RestClient, assetId: string, body: Record<string, unknown>) =>
  patch(client, `${MARKETING_BASE}/assets/${assetId}`, body);

// ---------------------------------------------------------------- tracking
export const simulateTracking = (client: RestClient, id: string, body: Record<string, unknown> = {}) =>
  post(client, `${c(id)}/tracking/simulate`, body);

/** Comma-separated ids from a flag, rejecting an empty list rather than posting one. */
export function requireIds(raw: string | undefined, what: string): string[] {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new MarketingVerbError(`Need at least one ${what} id (comma-separated).`);
  }
  return ids;
}

export function renderWriteDryRun(action: string, detail: string[], affected?: number): string {
  const lines = [`DRY RUN — ${action} was not performed.`, "", ...detail];
  if (affected !== undefined) lines.push("", `Records affected: ${affected}`);
  lines.push("", "Re-run with --no-dry-run --yes to apply.");
  return lines.join("\n");
}
