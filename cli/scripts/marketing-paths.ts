// The marketing module is a custom controller in the prudai/twenty fork, so it
// does not appear in Twenty's own /rest/open-api/core document. These entries
// are transcribed from
//   twenty-server/src/modules/marketing/controllers/marketing-campaign.controller.ts
//   twenty-server/src/modules/marketing/controllers/marketing-asset.controller.ts
// and are what `cato marketing` calls. Keep them in step with the controllers.

type Json = Record<string, unknown>;

const CAMPAIGN_PARAM = {
  name: "campaignId", in: "path", required: true, schema: { type: "string", format: "uuid" },
};
const TARGET_PARAM = {
  name: "targetId", in: "path", required: true, schema: { type: "string", format: "uuid" },
};
const MEMBER_PARAM = {
  name: "memberId", in: "path", required: true, schema: { type: "string", format: "uuid" },
};
const TOUCHPOINT_PARAM = {
  name: "touchpointId", in: "path", required: true, schema: { type: "string", format: "uuid" },
};

const okJson = (description: string) => ({
  "200": { description, content: { "application/json": { schema: { type: "object" } } } },
});

function op(summary: string, params: Json[] = [], hasBody = false): Json {
  const operation: Json = { summary, tags: ["marketing"], responses: okJson(summary) };
  if (params.length > 0) operation.parameters = params;
  if (hasBody) {
    operation.requestBody = {
      required: false,
      content: { "application/json": { schema: { type: "object" } } },
    };
  }
  return operation;
}

const C = [CAMPAIGN_PARAM] as Json[];

export const MARKETING_PATHS: Record<string, Record<string, Json>> = {
  "/marketing/access": { get: op("What the calling credential may do in the marketing module.") },
  "/marketing/campaigns": {
    get: op("List campaigns."),
    post: op("Create a campaign. It starts disabled, with generation off and no members.", [], true),
  },
  "/marketing/campaigns/{campaignId}": {
    patch: op("Update campaign fields.", C, true),
    delete: op("Delete a campaign.", C),
  },
  "/marketing/campaigns/{campaignId}/enabled": { patch: op("Enable or disable a campaign.", C, true) },
  "/marketing/campaigns/{campaignId}/archive": { post: op("Archive a campaign.", C) },
  "/marketing/campaigns/{campaignId}/restore": { post: op("Restore an archived campaign.", C) },
  "/marketing/campaigns/{campaignId}/prompts": {
    get: op("Generation prompts of a campaign.", C),
    patch: op("Replace the generation prompts.", C, true),
  },
  "/marketing/campaigns/{campaignId}/schedule": { patch: op("Set the weekly send windows.", C, true) },
  "/marketing/people": { get: op("Contactable people as the marketing module sees them.") },
  "/marketing/contact-filter-options": { get: op("Available contact filter options.") },
  "/marketing/crm-picker": { get: op("CRM picker options for selection.") },
  "/marketing/campaigns/{campaignId}/members": {
    get: op("Campaign members.", C),
    post: op("Attach one person as a member.", C, true),
  },
  "/marketing/campaigns/{campaignId}/members/bulk": { post: op("Attach several people at once.", C, true) },
  "/marketing/campaigns/{campaignId}/members/attach-matching": {
    post: op("Attach every person matching a filter.", C, true),
  },
  "/marketing/campaigns/{campaignId}/members/mark-as-todo": { post: op("Mark members as todo.", C, true) },
  "/marketing/campaigns/{campaignId}/members/{memberId}": {
    delete: op("Remove a member.", [...C, MEMBER_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/members/{memberId}/stop": {
    post: op("Stop the sequence for one member.", [...C, MEMBER_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/company-targets": {
    get: op("Company targets of a campaign.", C),
    post: op("Attach companies as targets.", C, true),
  },
  "/marketing/campaigns/{campaignId}/company-targets/add-matching": {
    post: op("Attach every company matching a filter.", C, true),
  },
  "/marketing/campaigns/{campaignId}/company-targets/{targetId}": {
    delete: op("Remove a company target.", [...C, TARGET_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/company-targets/{targetId}/research": {
    post: op("Research contacts for one company.", [...C, TARGET_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/company-targets/{targetId}/crm-contacts": {
    get: op("CRM contacts already known for this company.", [...C, TARGET_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/company-targets/{targetId}/contact-candidates": {
    post: op("Stage contact candidates for this company.", [...C, TARGET_PARAM], true),
  },
  "/marketing/campaigns/{campaignId}/contact-search-settings": {
    get: op("Which job titles the research looks for.", C),
    patch: op("Change the contact search settings.", C, true),
  },
  "/marketing/campaigns/{campaignId}/contact-research/start": {
    post: op("Start contact research over the campaign's companies. Writes candidates, sends nothing.", C, true),
  },
  "/marketing/campaigns/{campaignId}/contact-research/stop": { post: op("Stop a running research run.", C) },
  "/marketing/campaigns/{campaignId}/contact-selection-candidates": {
    get: op("Candidates awaiting selection.", C),
  },
  "/marketing/campaigns/{campaignId}/contact-selection-candidates/bulk-attach": {
    post: op("Turn selected candidates into members.", C, true),
  },
  "/marketing/campaigns/{campaignId}/contact-selection-candidates/bulk-remove": {
    post: op("Discard selected candidates.", C, true),
  },
  "/marketing/campaigns/{campaignId}/contact-selection-candidates/attach-crm-contacts": {
    post: op("Attach existing CRM people as candidates.", C, true),
  },
  "/marketing/campaigns/{campaignId}/contact-candidates": { get: op("Staged contact candidates.", C) },
  "/marketing/campaigns/{campaignId}/generation/activate": { post: op("Turn AI draft generation on.", C) },
  "/marketing/campaigns/{campaignId}/generation/deactivate": { post: op("Turn AI draft generation off.", C) },
  "/marketing/campaigns/{campaignId}/drafts/bulk-approve": {
    post: op("Approve every pending draft of a campaign.", C, true),
  },
  "/marketing/campaigns/{campaignId}/review-queue": { get: op("Touchpoints awaiting review.", C) },
  "/marketing/touchpoints/{touchpointId}": { get: op("One touchpoint.", [TOUCHPOINT_PARAM]) },
  "/marketing/touchpoints/{touchpointId}/approve": {
    post: op("Approve one touchpoint. Required before CATO will dispatch it.", [TOUCHPOINT_PARAM]),
  },
  "/marketing/touchpoints/{touchpointId}/reject": { post: op("Reject one touchpoint.", [TOUCHPOINT_PARAM]) },
  "/marketing/touchpoints/{touchpointId}/regenerate": {
    post: op("Regenerate the draft of one touchpoint.", [TOUCHPOINT_PARAM]),
  },
  "/marketing/campaigns/{campaignId}/send-test": {
    post: op("Send ONE test mail to a given address. The audience is not touched.", C, true),
  },
  "/marketing/campaigns/{campaignId}/send-approved-now": {
    post: op("Dispatch every APPROVED touchpoint of a campaign immediately.", C),
  },
  "/marketing/campaigns/{campaignId}/tracking/simulate": {
    post: op("Simulate tracking events. Testing only.", C, true),
  },
  "/marketing/assets": { get: op("Templates, sender profiles and rule packs.") },
  "/marketing/assets/{type}": {
    post: op("Create an asset of a given type.", [
      { name: "type", in: "path", required: true, schema: { type: "string" } },
    ], true),
  },
  "/marketing/assets/{assetId}": {
    patch: op("Update an asset.", [
      { name: "assetId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ], true),
  },
};

export const MARKETING_PATH_COUNT = Object.keys(MARKETING_PATHS).length;
export const MARKETING_OPERATION_COUNT = Object.values(MARKETING_PATHS)
  .reduce((n, methods) => n + Object.keys(methods).length, 0);
