// Command registry: the single source of truth for the command tree, per-command
// flags and help text. `args.ts` parses against this; `index.ts` dispatches on it.

import type { FlagSpecs } from "./args.ts";
import {
  BRANCHE_VALUES, OPPORTUNITY_STAGE_VALUES, PRODUCT_VALUES, SALES_STATUS_VALUES,
  TASK_BETROKKENEN_VALUES, TASK_BOARD_VALUES, TASK_LABEL_VALUES, TASK_PRIORITY_VALUES,
  TASK_SOURCE_VALUES, TASK_STATUS_VALUES,
} from "./filters.ts";

export const COMMAND_TREE: Record<string, readonly string[]> = {
  people: ["list", "get", "search", "create", "update", "delete", "history"],
  companies: ["list", "get", "search", "create", "update", "delete"],
  opportunities: ["list", "create", "update"],
  notes: ["list", "create", "update"],
  tasks: ["list", "get", "search", "create", "update", "complete", "done", "claim", "park", "comment", "comments", "delete"],
  segments: ["build"],
  import: [],
  auth: ["create", "set", "list", "revoke", "status", "whoami", "roles"],
  marketing: [
    // read
    "access", "campaigns", "touchpoints", "dispatches", "events", "schedule", "prompts",
    "people", "filter-options", "crm-picker", "assets",
    // build a campaign
    "create", "update", "targets", "contacts", "members", "candidates", "research",
    "search-settings", "generation", "enable", "archive", "restore", "delete", "verify",
    // review and send
    "approve", "reject", "regenerate", "bulk-approve", "send-test", "send-now",
    "tracking-simulate",
  ],
};

const COMMON_READ_FLAGS: FlagSpecs = {
  filter: { type: "string", placeholder: "<expr>", description: "Raw Twenty filter expression, AND-ed with the flag-built filter." },
  "order-by": { type: "string", placeholder: "<field[Dir]>", description: "e.g. createdAt[DescNullsFirst]." },
  depth: { type: "number", placeholder: "<0|1|2>", description: "Relation depth to include (default 0 = flat)." },
  fields: { type: "string[]", placeholder: "<a,b>", description: "Restrict output columns to these fields (dotted paths allowed)." },
  "include-deleted": { type: "boolean", description: "Include soft-deleted records (excluded by default)." },
  all: { type: "boolean", description: "Page through every match. Combine with --limit to cap it deliberately." },
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

const TASK_STATUS_HELP = `One of: ${TASK_STATUS_VALUES.join(", ")} (case-insensitive; other values are passed to CATO, which decides).`;

const TASK_FILTER_FLAGS: FlagSpecs = {
  status: { type: "string", placeholder: "<value>", description: TASK_STATUS_HELP },
  board: { type: "string", placeholder: "<value>", description: `Only tasks on this board. One of: ${TASK_BOARD_VALUES.join(", ")}.` },
  label: { type: "string[]", placeholder: "<a,b>", description: `MULTI_SELECT label (containsAny). One of: ${TASK_LABEL_VALUES.join(", ")}.` },
  priority: { type: "string", placeholder: "<value>", description: `One of: ${TASK_PRIORITY_VALUES.join(", ")}.` },
  source: { type: "string", placeholder: "<value>", description: `Where the task came from. One of: ${TASK_SOURCE_VALUES.join(", ")}.` },
  "assignee-id": { type: "string", placeholder: "<uuid>", description: "Only tasks assigned to this workspace member." },
  assignee: { type: "string", placeholder: "<name|email>", description: "Same, by first name, last name or e-mail (looked up in the workspace)." },
  "due-before": { type: "string", placeholder: "<date>", description: "Due on or before this day (YYYY-MM-DD, the whole day counts) or at/before this timestamp. Read in Europe/Amsterdam." },
  "due-after": { type: "string", placeholder: "<date>", description: "Due from this day or timestamp onwards. Read in Europe/Amsterdam." },
  overdue: { type: "boolean", description: "Due date in the past and not DONE." },
  "company-id": { type: "string", placeholder: "<uuid>", description: "Only tasks linked to this company (via taskTargets)." },
  "person-id": { type: "string", placeholder: "<uuid>", description: "Only tasks linked to this person." },
  "opportunity-id": { type: "string", placeholder: "<uuid>", description: "Only tasks linked to this opportunity." },
};

const TASK_UPDATE_FLAGS: FlagSpecs = {
  title: { type: "string", placeholder: "<text>", description: "Task title." },
  body: { type: "string", placeholder: "<text>", description: "Task body (markdown). Use --body-file for anything longer than a line." },
  "body-file": { type: "string", placeholder: "<path>", description: "Read the task body from a file." },
  status: { type: "string", placeholder: "<value>", description: TASK_STATUS_HELP },
  due: { type: "string", placeholder: "<YYYY-MM-DD[THH:MM]>", description: "Due date; day or wall-clock time in Europe/Amsterdam, or an ISO timestamp with zone." },
  "assignee-id": { type: "string", placeholder: "<uuid>", description: "Workspace member the task is assigned to." },
  assignee: { type: "string", placeholder: "<name|email>", description: "Same, by first name, last name or e-mail." },
  board: { type: "string", placeholder: "<value>", description: `Board the card lives on. One of: ${TASK_BOARD_VALUES.join(", ")}. Required on create.` },
  label: { type: "string[]", placeholder: "<a,b>", description: `Labels — a write replaces the whole set. One of: ${TASK_LABEL_VALUES.join(", ")}.` },
  priority: { type: "string", placeholder: "<value>", description: `One of: ${TASK_PRIORITY_VALUES.join(", ")}.` },
  source: { type: "string", placeholder: "<value>", description: `Where the task came from. One of: ${TASK_SOURCE_VALUES.join(", ")}. On create, AGENT/MEMO/CHAT default the status to INBOX.` },
  betrokkenen: { type: "string[]", placeholder: "<a,b>", description: `Who else is on the card — a write replaces the whole set. One of: ${TASK_BETROKKENEN_VALUES.join(", ")}.` },
  "source-link": { type: "string", placeholder: "<url>", description: "Link to the source report (e.g. the memo-verslag on SharePoint)." },
  "legacy-ref": { type: "string", placeholder: "<text>", description: "Trello provenance (e.g. 'prudai#128 · <card-id>'). Migration only." },
  field: {
    type: "string[]", noSplit: true, placeholder: "<key=value>",
    description: "Extra field to write, repeatable. key=value writes a string; key:=<json> writes JSON (number, boolean, null, list).",
  },
};

const TASK_WRITE_FLAGS: FlagSpecs = {
  ...TASK_UPDATE_FLAGS,
  "company-id": { type: "string", placeholder: "<uuid>", description: "Link the task to this company." },
  "person-id": { type: "string", placeholder: "<uuid>", description: "Link the task to this person." },
  "opportunity-id": { type: "string", placeholder: "<uuid>", description: "Link the task to this opportunity." },
  "no-due": { type: "boolean", description: "Create the task without a due date. The board rule wants one on every card, so say so explicitly." },
  "no-target": { type: "boolean", description: "Create the task without a company/person/opportunity link. For internal work only, so say so explicitly." },
};

const TASK_CLAIM_FLAGS: FlagSpecs = {
  assignee: { type: "string", placeholder: "<name|email>", description: "Who takes the task on (first name, last name or e-mail). Required." },
  "assignee-id": { type: "string", placeholder: "<uuid>", description: "Same, as a workspace-member id." },
};

const TASK_PARK_FLAGS: FlagSpecs = {
  due: { type: "string", placeholder: "<YYYY-MM-DD>", description: "When the card comes back. Default: 14 days from today (the board rule for parking)." },
};

const TASK_COMMENT_FLAGS: FlagSpecs = {
  body: { type: "string", placeholder: "<text>", description: "Comment text. Use --body-file for anything longer than a line." },
  "body-file": { type: "string", placeholder: "<path>", description: "Read the comment text from a file." },
};

const SEARCH_FLAGS: FlagSpecs = {
  query: { type: "string", placeholder: "<text>", description: "Substring to match, case-insensitive (also accepted as a positional argument). AND-ed with any filter flags." },
};

const SEGMENT_FLAGS: FlagSpecs = {
  ...PEOPLE_FILTER_FLAGS,
  ...COMMON_READ_FLAGS,
  name: { type: "string", placeholder: "<text>", description: "Name for the generated segment (used in the output metadata and default filename)." },
  out: { type: "string", placeholder: "<path>", description: "Write the segment to this file instead of stdout." },
  "wave-size": { type: "number", placeholder: "<n>", description: "Split the segment into waves of n recipients and label each row with its wave." },
};

const RECORD_WRITE_FLAGS: FlagSpecs = {
  "first-name": { type: "string", placeholder: "<text>", description: "Person first name." },
  "last-name": { type: "string", placeholder: "<text>", description: "Person last name." },
  email: { type: "string", placeholder: "<address>", description: "Primary email." },
  phone: { type: "string", placeholder: "<number>", description: "Primary phone." },
  "job-title": { type: "string", placeholder: "<text>", description: "Job title." },
  "linkedin-url": { type: "string", placeholder: "<url>", description: "LinkedIn profile URL." },
  "company-id": { type: "string", placeholder: "<uuid>", description: "Link the person to this company." },
  "assignee-id": { type: "string", placeholder: "<uuid>", description: "Owner. Defaults to the company's accountOwnerId." },
  name: { type: "string", placeholder: "<text>", description: "Company name." },
  domain: { type: "string", placeholder: "<host>", description: "Company domain." },
  city: { type: "string", placeholder: "<text>", description: "City." },
  employees: { type: "number", placeholder: "<n>", description: "Employee count." },
  branche: { type: "string", placeholder: "<text>", description: "Branche." },
  "account-owner-id": { type: "string", placeholder: "<uuid>", description: "Company account owner." },
};

const OPPORTUNITY_WRITE_FLAGS: FlagSpecs = {
  name: { type: "string", placeholder: "<text>", description: "Opportunity name — what the deal is." },
  stage: { type: "string", placeholder: "<value>", description: `One of: ${OPPORTUNITY_STAGE_VALUES.join(", ")}.` },
  amount: { type: "number", placeholder: "<eur>", description: "Expected value in euros (stored as micros)." },
  "close-date": { type: "string", placeholder: "<YYYY-MM-DD>", description: "Expected close date." },
  "company-id": { type: "string", placeholder: "<uuid>", description: "Company the deal belongs to (required on create)." },
  "point-of-contact-id": { type: "string", placeholder: "<uuid>", description: "Person who is the contact for this deal." },
  force: { type: "boolean", description: "Create a second open opportunity on a company that already has one." },
};

const NOTE_WRITE_FLAGS: FlagSpecs = {
  title: { type: "string", placeholder: "<text>", description: "Note title." },
  body: { type: "string", placeholder: "<text>", description: "Note body (markdown). Use --body-file for anything longer than a line." },
  "body-file": { type: "string", placeholder: "<path>", description: "Read the note body from a file." },
  "company-id": { type: "string", placeholder: "<uuid>", description: "Attach the note to this company." },
  "person-id": { type: "string", placeholder: "<uuid>", description: "Attach the note to this person." },
};

// Update never touches the note's links — only the fields it can PATCH.
const NOTE_UPDATE_FLAGS: FlagSpecs = {
  title: { type: "string", placeholder: "<text>", description: "New note title." },
  body: { type: "string", placeholder: "<text>", description: "New note body (markdown). Use --body-file for anything longer than a line." },
  "body-file": { type: "string", placeholder: "<path>", description: "Read the new note body from a file." },
};

const IMPORT_FLAGS: FlagSpecs = {
  csv: { type: "string", placeholder: "<path>", description: "CSV file to analyse." },
  object: { type: "string", placeholder: "<people|companies>", description: "Target object (default: people)." },
  "match-on": { type: "string", placeholder: "<field>", description: "Field used to detect existing records (default: emails.primaryEmail)." },
  "source-system": { type: "string", placeholder: "<name>", description: "Tag companies with this provenance label. Enables the write path (companies only)." },
  "allow-near-duplicates": { type: "boolean", description: "Proceed even though incoming names look like existing organisations. Check the dry run first." },
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
  ids: { type: "string", placeholder: "<a,b,c>", description: "Comma-separated ids (candidates, members, companies, people)." },
  target: { type: "string", placeholder: "<uuid>", description: "Company-target id." },
  member: { type: "string", placeholder: "<uuid>", description: "Campaign member id." },
  asset: { type: "string", placeholder: "<uuid>", description: "Asset id (assets update)." },
  type: { type: "string", placeholder: "<text>", description: "Asset type (assets create)." },
  body: { type: "string", placeholder: "<json>", description: "Raw JSON body for update/prompts/schedule/search-settings/assets." },
};

export function flagSpecsFor(command: readonly string[]): FlagSpecs {
  const [group, sub] = command;
  switch (group) {
    case "people":
      if (sub === "history") return {};
      if (sub === "create" || sub === "update" || sub === "delete") return RECORD_WRITE_FLAGS;
      return { ...COMMON_READ_FLAGS, ...PEOPLE_FILTER_FLAGS, ...(sub === "search" ? SEARCH_FLAGS : {}) };
    case "companies":
      if (sub === "create" || sub === "update" || sub === "delete") return RECORD_WRITE_FLAGS;
      return { ...COMMON_READ_FLAGS, ...COMPANY_FILTER_FLAGS, ...(sub === "search" ? SEARCH_FLAGS : {}) };
    case "opportunities":
      if (sub === "create" || sub === "update") return OPPORTUNITY_WRITE_FLAGS;
      return { ...COMMON_READ_FLAGS, ...OPPORTUNITY_FILTER_FLAGS };
    case "notes":
      if (sub === "create") return NOTE_WRITE_FLAGS;
      if (sub === "update") return NOTE_UPDATE_FLAGS;
      return { ...COMMON_READ_FLAGS, ...NOTE_FILTER_FLAGS };
    case "tasks":
      if (sub === "create") return TASK_WRITE_FLAGS;
      if (sub === "update") return TASK_UPDATE_FLAGS;
      if (sub === "claim") return TASK_CLAIM_FLAGS;
      if (sub === "park") return TASK_PARK_FLAGS;
      if (sub === "comment") return TASK_COMMENT_FLAGS;
      if (sub === "get" || sub === "complete" || sub === "done" || sub === "delete" || sub === "comments") return {};
      return { ...COMMON_READ_FLAGS, ...TASK_FILTER_FLAGS, ...(sub === "search" ? SEARCH_FLAGS : {}) };
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
  "people search": "Search people by first name, last name, email, phone or job title (case-insensitive substring).",
  "companies list": "List companies with CRM filters.",
  "companies get": "Fetch one company by id.",
  "companies search": "Search companies by name or domain (case-insensitive substring).",
  "opportunities list": "List opportunities (pipeline).",
  "opportunities create": "Create an opportunity on a company. Refuses a second open one unless --force. Needs --no-dry-run --yes.",
  "opportunities update": "Update an opportunity by id — move its stage, set the amount. Needs --no-dry-run --yes.",
  "notes list": "List notes.",
  "notes create": "Create a note and attach it to a company and/or person. Needs --no-dry-run --yes.",
  "notes update": "Update a note's title and/or body by id. Links stay untouched. Needs --no-dry-run --yes.",
  "tasks list": "List tasks: status, due date, assignee and the company/person/opportunity they hang off.",
  "tasks get": "Fetch one task by id, with its body (markdown), targets and assignee.",
  "tasks search": "Search tasks by title (case-insensitive substring), with the same filters as list.",
  "tasks create": "Create a task. --board is required; --due too unless --no-due; a target (--company-id/--person-id/--opportunity-id) too unless --no-target. --source AGENT/MEMO/CHAT lands in status INBOX. Needs --no-dry-run --yes.",
  "tasks update": "Update a task by id — title, status, due date, assignee, body, board, labels, custom fields. Links stay untouched. Needs --no-dry-run --yes.",
  "tasks complete": "Mark a task DONE (shorthand for update --status DONE). Needs --no-dry-run --yes.",
  "tasks done": "Alias of `tasks complete`.",
  "tasks claim": "Take a task on: status IN_PROGRESS + the --assignee you name. Needs --no-dry-run --yes.",
  "tasks park": "Park a task: status ON_HOLD, due set to when it comes back (default +14 days). Needs --no-dry-run --yes.",
  "tasks comment": "Add a comment to a task; also stamps lastCommentAt/lastCommentPreview on the card. Needs --no-dry-run --yes.",
  "tasks comments": "Read a task's comments, oldest first.",
  "tasks delete": "Delete a task by id. Permanent — unlike the UI's trash, the row does not come back. Needs --no-dry-run --yes.",
  "segments build": "Build a target-audience selection from filters and write it out as JSON/CSV.",
  import: "Analyse a CSV; with --source-system also tag/create companies. Needs --no-dry-run --yes.",
  "people create": "Create a person. Inherits the company's account owner so the record stays visible.",
  "people update": "Update a person by id. Only the fields you pass are written.",
  "people delete": "Delete a person by id. Permanent — unlike the UI's trash, the row does not come back. Needs --no-dry-run --yes.",
  "people history": "Campaigns this person is in and every mail we sent them, with opens and clicks.",
  "companies create": "Create a company. Needs --name.",
  "companies update": "Update a company by id. Only the fields you pass are written.",
  "companies delete": "Delete a company by id. Permanent — unlike the UI's trash, the row does not come back. Needs --no-dry-run --yes.",
  "marketing create": "Create a campaign. Starts disabled, generation off, no members. Sends nothing.",
  "marketing targets": "Attach companies as campaign targets from a provenance filter.",
  "marketing contacts": "Attach matching people as campaign members.",
  "marketing generation": "Turn AI draft generation on (default) or off (--off). Drafts still need approval.",
  "marketing enable": "Enable (default) or disable (--off) a campaign.",
  "marketing send-test": "Send ONE test mail to --email. The audience is never touched.",
  "marketing access": "Show what the current credential may do in the marketing module.",
  "marketing update": "Update campaign fields from --body <json>.",
  "marketing members": "list | add | bulk | attach-matching | remove | stop | mark-todo",
  "marketing candidates": "list | attach | remove | attach-crm | staged — the contact selection step.",
  "marketing research": "start | stop | status | target — contact research over the campaign's companies.",
  "marketing verify": "Acceptance check on a research run: deliverability, domain agreement, coverage.",
  "marketing search-settings": "get | set — which job titles the research looks for.",
  "marketing prompts": "get | set — the generation prompts of a campaign.",
  "marketing schedule": "get | set — the weekly send windows.",
  "marketing archive": "Archive a campaign.",
  "marketing restore": "Restore an archived campaign.",
  "marketing delete": "Delete a campaign. Needs --no-dry-run --yes.",
  "marketing regenerate": "Regenerate the draft of ONE touchpoint.",
  "marketing bulk-approve": "Approve every pending draft of a campaign. Shows the count first.",
  "marketing people": "Contactable people as the marketing module sees them.",
  "marketing filter-options": "Available contact filter options.",
  "marketing crm-picker": "CRM picker options (companies/people for selection).",
  "marketing assets": "list | create | update — templates, sender profiles, rule packs.",
  "marketing tracking-simulate": "Simulate tracking events for a campaign (testing only).",
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
  "marketing approve": "Approve ONE touchpoint. Needs --no-dry-run --yes.",
  "marketing reject": "Reject ONE touchpoint. Needs --no-dry-run --yes.",
  "marketing send-now": "Send all APPROVED touchpoints of a campaign now. Needs --no-dry-run --yes.",
};
