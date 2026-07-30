// Command registry: the single source of truth for the command tree, per-command
// flags and help text. `args.ts` parses against this; `index.ts` dispatches on it.

import type { FlagSpecs } from "./args.ts";
import { BRANCHE_VALUES, OPPORTUNITY_STAGE_VALUES, PRODUCT_VALUES, SALES_STATUS_VALUES } from "./filters.ts";

export const COMMAND_TREE: Record<string, readonly string[]> = {
  people: ["list", "get", "search"],
  companies: ["list", "get", "search"],
  opportunities: ["list"],
  notes: ["list"],
  segments: ["build"],
  import: [],
  auth: ["create", "set", "list", "revoke", "status", "whoami", "roles"],
  marketing: [
    "campaigns", "touchpoints", "dispatches", "events", "schedule", "approve", "reject", "send-now",
    "create", "targets", "contacts", "generation", "enable", "send-test",
  ],
};

const COMMON_READ_FLAGS: FlagSpecs = {
  filter: { type: "string", placeholder: "<expr>", description: "Raw Twenty filter expression, AND-ed with the flag-built filter." },
  "order-by": { type: "string", placeholder: "<field[Dir]>", description: "e.g. createdAt[DescNullsFirst]." },
  depth: { type: "number", placeholder: "<0|1|2>", description: "Relation depth to include (default 0 = flat)." },
  fields: { type: "string[]", placeholder: "<a,b>", description: "Restrict output columns to these fields (dotted paths allowed)." },
  "include-deleted": { type: "boolean", description: "Include soft-deleted records (excluded by default)." },
  all: { type: "boolean", description: "Page through every match instead of stopping at --limit." },
};

const PEOPLE_FILTER_FLAGS: FlagSpecs = {
  "company-id": { type: "string", placeholder: "<uuid>", description: "Only people at this company." },
  "job-title": { type: "string", placeholder: "<text>", description: "Case-insensitive substring match on jobTitle." },
  city: { type: "string", placeholder: "<text>", description: "Case-insensitive substring match on the person's city." },
  segment: { type: "string", placeholder: "<value>", description: "prudaiMarketingSourceSegment equals." },
  "source-system": { type: "string", placeholder: "<value>", description: "prudaiMarketingSourceSystem equals (e.g. architectenregister)." },
  "outreach-state": { type: "string", placeholder: "<value>", description: "prudaiMarketingOutreachState equals." },
  branche: { type: "string", placeholder: "<value>", description: `SELECT branche. One of: ${BRANCHE_VALUES.join(", ")}.` },
  product: { type: "string[]", placeholder: "<a,b>", description: `MULTI_SELECT product tag (containsAny). One of: ${PRODUCT_VALUES.join(", ")}.` },
  "sales-status": { type: "string", placeholder: "<value>", description: `One of: ${SALES_STATUS_VALUES.join(", ")}.` },
  visibility: { type: "string", placeholder: "<value>", description: "MARKETING or RESTRICTED." },
  "email-domain": { type: "string", placeholder: "<domain>", description: "Primary e-mail ends with @<domain>." },
  "has-email": { type: "boolean", description: "Only people with a primary e-mail address." },
  contactable: { type: "boolean", description: "Marketing-safe set: has e-mail, not doNotContact, no marketing opt-out." },
  "created-since": { type: "string", placeholder: "<date>", description: "createdAt >= YYYY-MM-DD or ISO timestamp." },
  "updated-since": { type: "string", placeholder: "<date>", description: "updatedAt >= YYYY-MM-DD or ISO timestamp." },
};

const COMPANY_FILTER_FLAGS: FlagSpecs = {
  name: { type: "string", placeholder: "<text>", description: "Case-insensitive substring match on the company name." },
  city: { type: "string", placeholder: "<text>", description: "Case-insensitive substring match on address.addressCity." },
  cities: { type: "string[]", placeholder: "<a,b>", description: "Exact-match any of these cities (OR)." },
  domain: { type: "string", placeholder: "<text>", description: "Substring match on the primary domain." },
  branche: { type: "string", placeholder: "<value>", description: `SELECT branche. One of: ${BRANCHE_VALUES.join(", ")}.` },
  product: { type: "string[]", placeholder: "<a,b>", description: `MULTI_SELECT product tag (containsAny). One of: ${PRODUCT_VALUES.join(", ")}.` },
  segment: { type: "string", placeholder: "<value>", description: "prudaiMarketingSourceSegment equals." },
  "source-system": { type: "string", placeholder: "<value>", description: "prudaiMarketingSourceSystem equals." },
  visibility: { type: "string", placeholder: "<value>", description: "MARKETING or RESTRICTED." },
  "min-employees": { type: "number", placeholder: "<n>", description: "employees >= n." },
  "max-employees": { type: "number", placeholder: "<n>", description: "employees <= n." },
  icp: { type: "boolean", description: "Only companies flagged idealCustomerProfile." },
  "created-since": { type: "string", placeholder: "<date>", description: "createdAt >= YYYY-MM-DD or ISO timestamp." },
};

const OPPORTUNITY_FILTER_FLAGS: FlagSpecs = {
  name: { type: "string", placeholder: "<text>", description: "Substring match on the opportunity name." },
  stage: { type: "string", placeholder: "<value>", description: `One of: ${OPPORTUNITY_STAGE_VALUES.join(", ")}.` },
  "company-id": { type: "string", placeholder: "<uuid>", description: "Only opportunities for this company." },
  "owner-id": { type: "string", placeholder: "<uuid>", description: "Only opportunities owned by this workspace member." },
  "close-after": { type: "string", placeholder: "<date>", description: "closeDate >= date." },
  "close-before": { type: "string", placeholder: "<date>", description: "closeDate <= date." },
};

const NOTE_FILTER_FLAGS: FlagSpecs = {
  title: { type: "string", placeholder: "<text>", description: "Substring match on the note title." },
  "assignee-id": { type: "string", placeholder: "<uuid>", description: "Only notes assigned to this workspace member." },
  "created-since": { type: "string", placeholder: "<date>", description: "createdAt >= date." },
};

const SEARCH_FLAGS: FlagSpecs = {
  query: { type: "string", placeholder: "<text>", description: "Full-text search term (also accepted as a positional argument)." },
};

const SEGMENT_FLAGS: FlagSpecs = {
  ...PEOPLE_FILTER_FLAGS,
  ...COMMON_READ_FLAGS,
  name: { type: "string", placeholder: "<text>", description: "Name for the generated segment (used in the output metadata and default filename)." },
  out: { type: "string", placeholder: "<path>", description: "Write the segment to this file instead of stdout." },
  "wave-size": { type: "number", placeholder: "<n>", description: "Split the segment into waves of n recipients and label each row with its wave." },
};

const IMPORT_FLAGS: FlagSpecs = {
  csv: { type: "string", placeholder: "<path>", description: "CSV file to analyse." },
  object: { type: "string", placeholder: "<people|companies>", description: "Target object (default: people)." },
  "match-on": { type: "string", placeholder: "<field>", description: "Field used to detect existing records (default: emails.primaryEmail)." },
  "source-system": { type: "string", placeholder: "<name>", description: "Tag companies with this provenance label. Enables the write path (companies only)." },
};

const AUTH_FLAGS: FlagSpecs = {
  name: { type: "string", placeholder: "<text>", description: "Name of the API key (shown in CATO settings)." },
  expires: { type: "string", placeholder: "<date>", description: "Expiry date (YYYY-MM-DD or ISO). Default: 90 days out." },
  "role-id": { type: "string", placeholder: "<uuid>", description: "Role to attach. Required by CATO — see `cato auth roles`." },
  "api-key": { type: "string", placeholder: "<token>", description: "Key to store (auth set). Prefer stdin: `cato auth set --stdin`." },
  "user-token": { type: "string", placeholder: "<token>", description: "User session token to store (needed for `cato marketing`)." },
  stdin: { type: "boolean", description: "Read the secret from stdin instead of the command line (keeps it out of shell history)." },
  kind: { type: "string", placeholder: "<api-key|user-token>", description: "What --stdin contains (default: api-key)." },
  note: { type: "string", placeholder: "<text>", description: "Free-text note stored with the profile." },
  "set-default": { type: "boolean", description: "Make this profile the default." },
};

const MARKETING_FLAGS: FlagSpecs = {
  campaign: { type: "string", placeholder: "<uuid>", description: "Campaign id." },
  state: { type: "string", placeholder: "<pending|approved|rejected>", description: "Filter the review queue by approval state." },
  touchpoint: { type: "string", placeholder: "<uuid>", description: "Touchpoint id (approve/reject)." },
  name: { type: "string", placeholder: "<text>", description: "Campaign name (create)." },
  subject: { type: "string", placeholder: "<text>", description: "Mail subject (create)." },
  message: { type: "string", placeholder: "<text>", description: "Core message the generator works from (create)." },
  "focus-area": { type: "string", placeholder: "<text>", description: "Focus area, e.g. a segment or theme (create)." },
  "cta-text": { type: "string", placeholder: "<text>", description: "Call-to-action label (create)." },
  "cta-link": { type: "string", placeholder: "<url>", description: "Call-to-action URL, must be absolute (create)." },
  channel: { type: "string", placeholder: "<outbound|newsletter>", description: "Campaign channel (default: outbound)." },
  "source-system": { type: "string", placeholder: "<name>", description: "Audience filter on provenance, as written by `cato import`." },
  segment: { type: "string", placeholder: "<text>", description: "Audience filter on prudaiMarketingSourceSegment." },
  branche: { type: "string", placeholder: "<text>", description: "Audience filter on branche." },
  on: { type: "boolean", description: "Turn generation/enabled on (default for `generation`/`enable`)." },
  off: { type: "boolean", description: "Turn generation/enabled off." },
  email: { type: "string", placeholder: "<address>", description: "Recipient of a single test mail (send-test)." },
};

export function flagSpecsFor(command: readonly string[]): FlagSpecs {
  const [group, sub] = command;
  switch (group) {
    case "people":
      return { ...COMMON_READ_FLAGS, ...PEOPLE_FILTER_FLAGS, ...(sub === "search" ? SEARCH_FLAGS : {}) };
    case "companies":
      return { ...COMMON_READ_FLAGS, ...COMPANY_FILTER_FLAGS, ...(sub === "search" ? SEARCH_FLAGS : {}) };
    case "opportunities":
      return { ...COMMON_READ_FLAGS, ...OPPORTUNITY_FILTER_FLAGS };
    case "notes":
      return { ...COMMON_READ_FLAGS, ...NOTE_FILTER_FLAGS };
    case "segments":
      return SEGMENT_FLAGS;
    case "import":
      return IMPORT_FLAGS;
    case "auth":
      return AUTH_FLAGS;
    case "marketing":
      return { ...COMMON_READ_FLAGS, ...MARKETING_FLAGS };
    default:
      return {};
  }
}

export const COMMAND_SUMMARIES: Record<string, string> = {
  "people list": "List people with CRM filters.",
  "people get": "Fetch one person by id.",
  "people search": "Full-text search over people.",
  "companies list": "List companies with CRM filters.",
  "companies get": "Fetch one company by id.",
  "companies search": "Full-text search over companies.",
  "opportunities list": "List opportunities (pipeline).",
  "notes list": "List notes.",
  "segments build": "Build a target-audience selection from filters and write it out as JSON/CSV.",
  import: "Analyse a CSV; with --source-system also tag/create companies. Needs --no-dry-run --yes.",
  "marketing create": "Create a campaign. Starts disabled, generation off, no members. Sends nothing.",
  "marketing targets": "Attach companies as campaign targets from a provenance filter.",
  "marketing contacts": "Attach matching people as campaign members.",
  "marketing generation": "Turn AI draft generation on (default) or off (--off). Drafts still need approval.",
  "marketing enable": "Enable (default) or disable (--off) a campaign.",
  "marketing send-test": "Send ONE test mail to --email. The audience is never touched.",
  "auth create": "Create an API key in CATO and print the token once. Needs --no-dry-run --yes.",
  "auth set": "Store a key/token in a local profile (~/.config/cato/credentials.json, 0600).",
  "auth list": "List API keys in the workspace (never the key material).",
  "auth revoke": "Revoke an API key by id. Needs --no-dry-run --yes.",
  "auth roles": "List roles and whether they can be attached to an API key.",
  "auth status": "Show the active profile, credential source and what the credential can do.",
  "auth whoami": "Alias of `auth status`.",
  "marketing campaigns": "List/inspect marketing campaigns.",
  "marketing touchpoints": "Show the touchpoint review queue (--state pending|approved|rejected).",
  "marketing dispatches": "List dispatches for a campaign.",
  "marketing events": "Show tracking aggregates (opens/clicks/bounces/unsubscribes).",
  "marketing schedule": "Show the weekly send windows of a campaign.",
  "marketing approve": "Approve ONE touchpoint. Needs --no-dry-run --yes.",
  "marketing reject": "Reject ONE touchpoint. Needs --no-dry-run --yes.",
  "marketing send-now": "Send all APPROVED touchpoints of a campaign now. Needs --no-dry-run --yes.",
};
