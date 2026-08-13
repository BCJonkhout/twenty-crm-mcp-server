#!/usr/bin/env bun
// `cato` — command line interface for PrudAI's Twenty CRM instance (CATO).
//
// Safety posture, in one place:
//   * reads are unrestricted, writes are gated behind --no-dry-run --yes;
//   * `cato import` has no write path whatsoever;
//   * secrets are never logged, never echoed back, never written to the repo.

import { createRestClient, type RestClient } from "@twenty-crm/core";
import {
  flagBool, flagNumber, flagString, parseArgs, resolveWriteGate, type FlagValue,
} from "./args.ts";
import { COMMAND_TREE, flagSpecsFor } from "./commands.ts";
import { commandHelp, topLevelHelp, VERSION } from "./help.ts";
import {
  credentialsPath, readCredentials, readKeyFromOpenBao, resolveCredentials,
  writeCredentials, type ResolvedCredentials,
} from "./config.ts";
import { FilterError } from "./filters.ts";
import { render } from "./output.ts";
import { fetchRecords, planList, runGet, runList, type ObjectPath } from "./commands/records.ts";
import { buildSegment, renderSegment } from "./commands/segments.ts";
import { parseCsv, planImport, renderImportPlan } from "./commands/importCsv.ts";
import {
  executeWrites, findNearDuplicates, planWrites, renderWritePlan, type ImportRow,
} from "./commands/importWrite.ts";
import * as auth from "./commands/auth.ts";
import * as marketing from "./commands/marketing.ts";
import * as build from "./commands/campaignBuild.ts";
import * as api from "./commands/marketingApi.ts";
import * as write from "./commands/recordWrite.ts";
import * as verify from "./commands/researchVerify.ts";
import { DEFAULT_BASE_URL, indexUrl, marketingUrl, recordUrl } from "./urls.ts";
import { createGraphQLTransport, currentWorkspace } from "./auth-api.ts";

class CliError extends Error {}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function resolveAuth(flags: Record<string, FlagValue>): Promise<ResolvedCredentials> {
  const creds = resolveCredentials({
    profileFlag: flagString(flags, "profile"),
    baseUrlFlag: flagString(flags, "base-url"),
  });
  if (creds.apiKey || creds.userToken) return creds;

  const fromBao = await readKeyFromOpenBao();
  if (fromBao) return { ...creds, apiKey: fromBao, source: "openbao" };
  return creds;
}

function requireApiKey(creds: ResolvedCredentials): string {
  if (creds.apiKey) return creds.apiKey;
  throw new CliError(
    "No CATO credential found. Resolution order:\n" +
      "  1. --profile <name>\n" +
      "  2. $CATO_API_KEY\n" +
      `  3. default profile in ${credentialsPath()}\n` +
      "  4. OpenBao kv/prod/cato-cli/app (needs $CATO_BAO_TOKEN)\n" +
      "Store one with: cato auth set --profile default --stdin",
  );
}

function restClient(creds: ResolvedCredentials, token?: string): RestClient {
  return createRestClient({ apiKey: token ?? requireApiKey(creds), baseUrl: creds.baseUrl });
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMAND_TREE, flagSpecsFor);

  if (flagBool(parsed.flags, "version") === true) {
    out(VERSION);
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write("\nRun 'cato --help'.\n");
    return 2;
  }
  if (parsed.command.length === 0) {
    out(topLevelHelp());
    return flagBool(parsed.flags, "help") === true ? 0 : 1;
  }
  const [group, sub] = parsed.command;
  if (flagBool(parsed.flags, "help") === true) {
    out(commandHelp(parsed.command));
    return 0;
  }
  if (!sub && (COMMAND_TREE[group!] ?? []).length > 0) {
    out(commandHelp(parsed.command));
    return 1;
  }

  const json = flagBool(parsed.flags, "json") === true;
  const csv = flagBool(parsed.flags, "csv") === true;
  const ctx = {
    json,
    csv,
    baseUrl: flagString(parsed.flags, "base-url") ?? process.env.CATO_BASE_URL ?? DEFAULT_BASE_URL,
  };

  switch (group) {
    case "people":
    case "companies":
    case "opportunities":
    case "notes":
      return runRecordCommand(group as ObjectPath, sub!, parsed.positionals, parsed.flags, ctx);
    case "segments":
      return runSegments(parsed.flags, ctx);
    case "import":
      return runImport(parsed.flags, ctx);
    case "auth":
      return runAuth(sub!, parsed.positionals, parsed.flags, ctx);
    case "marketing":
      return runMarketing(sub!, parsed.positionals, parsed.flags, ctx);
    default:
      throw new CliError(`Unhandled command group '${group}'.`);
  }
}

async function runRecordCommand(
  objectPath: ObjectPath,
  sub: string,
  positionals: string[],
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean; baseUrl?: string },
): Promise<number> {
  const creds = await resolveAuth(flags);
  const client = restClient(creds);
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE_URL;

  if (sub === "create" || sub === "update" || sub === "delete") {
    if (objectPath !== "people" && objectPath !== "companies") {
      throw new CliError(`cato ${objectPath} ${sub} is not supported.`);
    }
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    const id = positionals[0];

    if (sub === "delete") {
      if (!id) throw new CliError(`cato ${objectPath} delete needs a record id.`);
      if (gate.dryRun) { out(write.renderWriteDryRun("delete", objectPath, null, id)); return 0; }
      out(JSON.stringify(await write.deleteRecord(client, objectPath, id), null, 2));
      return 0;
    }

    const personFlags: write.PersonFlags = {
      firstName: flagString(flags, "first-name"), lastName: flagString(flags, "last-name"),
      email: flagString(flags, "email"), phone: flagString(flags, "phone"),
      jobTitle: flagString(flags, "job-title"), linkedinUrl: flagString(flags, "linkedin-url"),
      city: flagString(flags, "city"), companyId: flagString(flags, "company-id"),
      assigneeId: flagString(flags, "assignee-id"),
    };
    const companyFlags: write.CompanyFlags = {
      name: flagString(flags, "name"), domain: flagString(flags, "domain"),
      city: flagString(flags, "city"), employees: flagNumber(flags, "employees"),
      branche: flagString(flags, "branche"), accountOwnerId: flagString(flags, "account-owner-id"),
    };

    let inheritedFrom: string | undefined;
    if (objectPath === "people") {
      const resolved = await write.resolveAssignee(client, personFlags);
      personFlags.assigneeId = resolved.assigneeId;
      inheritedFrom = resolved.inheritedFrom;
    }

    if (sub === "create") write.requireCreateFields(objectPath, { ...personFlags, ...companyFlags });
    else if (!id) throw new CliError(`cato ${objectPath} update needs a record id.`);

    const body = objectPath === "people"
      ? write.buildPersonBody(personFlags)
      : write.buildCompanyBody(companyFlags);

    if (gate.dryRun) { out(write.renderWriteDryRun(sub, objectPath, body, id, inheritedFrom)); return 0; }
    const outcome = sub === "create"
      ? await write.createRecord(client, objectPath, body, baseUrl)
      : await write.updateRecord(client, objectPath, id!, body, baseUrl);
    out(JSON.stringify(outcome, null, 2));
    if (inheritedFrom) out(`Assignee inherited from company ${inheritedFrom}.`);
    return 0;
  }

  if (sub === "history") {
    const id = positionals[0];
    if (!id) throw new CliError("cato people history needs a person id.");
    const creds2 = await resolveAuth(flags);
    const token = marketing.assertMarketingAuth(creds2.userToken, creds2.apiKey);
    const history = await api.getPersonHistory(restClient(creds2, token), id);
    out(ctx.json ? JSON.stringify(history, null, 2) : api.renderPersonHistory(history));
    if (!ctx.json) out(`\n${recordUrl(baseUrl, "person", id)}`);
    return 0;
  }

  if (sub === "get") {
    const id = positionals[0];
    if (!id) throw new CliError(`cato ${objectPath} get needs a record id as its argument.`);
    out(await runGet(client, objectPath, id, flags, ctx));
    return 0;
  }

  if (sub === "search") {
    const query = flagString(flags, "query") ?? positionals[0];
    // Whitespace-only counts as missing: a blank term builds no search clause,
    // and the command would quietly list the whole table instead of searching.
    if (!query?.trim()) throw new CliError(`cato ${objectPath} search needs a search term.`);
    out(await runList(client, objectPath, { ...flags, query }, ctx));
    return 0;
  }

  out(await runList(client, objectPath, flags, ctx));
  return 0;
}

async function runSegments(
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean },
): Promise<number> {
  const creds = await resolveAuth(flags);
  const client = restClient(creds);

  const name = flagString(flags, "name") ?? `segment-${new Date().toISOString().slice(0, 10)}`;
  // Segments are audience selections: default much wider than a `list`, and
  // always paged, otherwise the first 20 rows masquerade as "the segment".
  const limit = flagNumber(flags, "limit") ?? 1000;
  const plan = planList("people", { ...flags, limit, all: true });
  const records = await fetchRecords(client, plan);
  const segment = buildSegment(name, plan.filter, records, flagNumber(flags, "wave-size"));

  const format = ctx.json ? "json" : ctx.csv ? "csv" : "table";
  const text = renderSegment(segment, format);

  const outPath = flagString(flags, "out");
  if (outPath) {
    await Bun.write(outPath, `${text}\n`);
    out(`Wrote ${segment.count} members to ${outPath} (${format}).`);
    if (segment.waves) out(`Waves: ${segment.waves} x ${segment.waveSize}.`);
    return 0;
  }
  out(text);
  return 0;
}

async function runImport(
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean },
): Promise<number> {
  const file = flagString(flags, "csv");
  if (!file) throw new CliError("cato import needs --csv <path>.");

  const objectFlag = flagString(flags, "object") ?? "people";
  if (objectFlag !== "people" && objectFlag !== "companies") {
    throw new CliError("--object must be 'people' or 'companies'.");
  }

  const text = await Bun.file(file).text();
  const table = parseCsv(text);

  // The provenance-tagging path: `--source-system` says "this list came from
  // somewhere, record where". Only companies, and only provenance fields.
  const sourceSystem = flagString(flags, "source-system");
  if (sourceSystem) {
    if (objectFlag !== "companies") {
      throw new CliError("--source-system is only supported with --object companies.");
    }
    return runImportTag(table, file, sourceSystem, flags, ctx);
  }

  const plan = planImport(table, {
    object: objectFlag,
    file,
    matchOn: flagString(flags, "match-on"),
  });
  out(renderImportPlan(plan, ctx.json));
  return 0;
}

/** Reads the CSV into ImportRows, matches against CATO, then plans or applies. */
async function runImportTag(
  table: ReturnType<typeof parseCsv>,
  file: string,
  sourceSystem: string,
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean; baseUrl?: string },
): Promise<number> {
  const col = (header: string): number =>
    table.headers.findIndex((h) => h.trim().toLowerCase() === header);
  const nameIdx = col("name");
  if (nameIdx === -1) throw new CliError(`${file} has no 'name' column.`);

  const segmentIdx = col("segment");
  const urlIdx = col("url");
  const contextIdx = col("context");

  const rows: ImportRow[] = table.rows
    .map((row) => {
      const rawContext = contextIdx === -1 ? "" : (row[contextIdx] ?? "");
      let context: Record<string, unknown> | undefined;
      if (rawContext) {
        try { context = JSON.parse(rawContext) as Record<string, unknown>; }
        catch { context = { note: rawContext }; }
      }
      return {
        name: (row[nameIdx] ?? "").trim(),
        sourceSegment: segmentIdx === -1 ? undefined : (row[segmentIdx] ?? "").trim() || undefined,
        sourceUrl: urlIdx === -1 ? undefined : (row[urlIdx] ?? "").trim() || undefined,
        sourceSystem,
        context,
      };
    })
    .filter((r) => r.name !== "");

  const creds = await resolveAuth(flags);
  const client = restClient(creds);
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE_URL;

  // One pass over CATO's companies beats 200+ individual lookups.
  const existingRecords = await fetchRecords(client, {
    objectPath: "companies", filter: null, limit: 100000, fetchAll: true,
  });
  const existing = existingRecords
    .map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? "") }))
    .filter((r) => r.id && r.name);

  const plan = planWrites(rows, existing);

  // Names that an existing record extends ("AKD" vs "AKD advocaten &
  // notarissen") hash differently and would silently duplicate the register.
  const nearDuplicates = plan
    .filter((p) => p.action === "create")
    .map((p) => ({ incoming: p.row.name, existing: findNearDuplicates(p.row.name, existing) }))
    .filter((d) => d.existing.length > 0);

  const gate = resolveWriteGate(flags);
  if (gate.blockedReason) throw new CliError(gate.blockedReason);

  if (!gate.dryRun && nearDuplicates.length > 0 && flagBool(flags, "allow-near-duplicates") !== true) {
    throw new CliError(
      `Refusing to write: ${nearDuplicates.length} incoming name(s) look like an organisation that ` +
      "already exists under a longer name, and creating them would duplicate the register.\n" +
      nearDuplicates.slice(0, 10).map((d) => `  ${d.incoming}  ~  ${d.existing.map((e) => e.name).join(" / ")}`).join("\n") +
      "\nRun the dry run to see them all, then pass --allow-near-duplicates once you have checked.",
    );
  }

  if (gate.dryRun) {
    out(renderWritePlan(plan, sourceSystem, ctx.json, nearDuplicates));
    out(`\nMatched against ${existing.length} companies already in CATO.`);
    out(`List afterwards: ${indexUrl(baseUrl, "companies")}`);
    return 0;
  }

  const outcomes = await executeWrites(client, plan, baseUrl);
  const created = outcomes.filter((o) => o.action === "create").length;
  const tagged = outcomes.filter((o) => o.action === "tag").length;
  const failed = outcomes.filter((o) => o.action === "skip").length;

  if (ctx.json || ctx.csv) {
    out(render(outcomes as unknown as Record<string, unknown>[], { json: ctx.json, csv: ctx.csv }));
  } else {
    out(`Created ${created}, tagged ${tagged}, skipped ${failed}.`);
    for (const o of outcomes.filter((x) => x.url).slice(0, 10)) out(`  ${o.name}  ${o.url}`);
    if (outcomes.filter((x) => x.url).length > 10) out("  …");
  }
  out(`\nOpen the tagged list: ${indexUrl(baseUrl, "companies")}`);
  out(`Filter on prudaiMarketingSourceSystem = '${sourceSystem}'.`);
  return 0;
}

async function runAuth(
  sub: string,
  positionals: string[],
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean },
): Promise<number> {
  const creds = await resolveAuth(flags);

  if (sub === "set") {
    const profileName = flagString(flags, "profile") ?? "default";
    let apiKey = flagString(flags, "api-key");
    let userToken = flagString(flags, "user-token");
    if (flagBool(flags, "stdin") === true) {
      const secret = await readStdin();
      if (!secret) throw new CliError("--stdin was given but nothing arrived on stdin.");
      const kind = flagString(flags, "kind") ?? "api-key";
      if (kind === "user-token") userToken = secret;
      else if (kind === "api-key") apiKey = secret;
      else throw new CliError("--kind must be 'api-key' or 'user-token'.");
    }
    const file = readCredentials();
    const updated = auth.applyProfile(file, {
      profileName,
      apiKey,
      userToken,
      baseUrl: flagString(flags, "base-url"),
      note: flagString(flags, "note"),
      setDefault: flagBool(flags, "set-default") === true,
    });
    writeCredentials(updated);
    out(`Stored profile '${profileName}' in ${credentialsPath()} (mode 0600).`);
    if (updated.defaultProfile === profileName) out(`'${profileName}' is now the default profile.`);
    out("The secret was not echoed and is not in your shell history if you used --stdin.");
    return 0;
  }

  if (sub === "status" || sub === "whoami") {
    const status = auth.buildStatus(creds);
    if (ctx.json) {
      out(JSON.stringify(status, null, 2));
      return 0;
    }
    let roleLine: string | null = null;
    if (creds.apiKey) {
      try {
        const transport = createGraphQLTransport(creds.baseUrl, creds.apiKey);
        const ws = await currentWorkspace(transport);
        if (ws) roleLine = `workspace ${ws.displayName ?? ws.id} reachable`;
      } catch (err) {
        roleLine = `credential rejected by CATO: ${(err as Error).message}`;
      }
    }
    out(auth.renderStatus(status, roleLine));
    return 0;
  }

  const transport = createGraphQLTransport(creds.baseUrl, requireApiKey(creds));

  if (sub === "roles") {
    const roles = await auth.runRoles(transport);
    out(ctx.json ? JSON.stringify(roles, null, 2) : auth.renderRoles(roles));
    return 0;
  }

  if (sub === "list") {
    const keys = await auth.runList(transport);
    out(render(keys as unknown as Record<string, unknown>[], {
      json: ctx.json,
      csv: ctx.csv,
      columns: ["id", "name", "createdAt", "expiresAt", "revokedAt"],
    }));
    return 0;
  }

  if (sub === "create") {
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    const roles = await auth.runRoles(transport);
    const plan = auth.planCreate(
      { name: flagString(flags, "name"), expires: flagString(flags, "expires"), roleId: flagString(flags, "role-id") },
      roles,
    );
    if (gate.dryRun) {
      out(auth.renderCreateDryRun(plan));
      return 0;
    }
    const created = await auth.executeCreate(transport, plan);
    out(auth.renderCreatedKey(created, plan));
    return 0;
  }

  if (sub === "revoke") {
    const id = positionals[0];
    if (!id) throw new CliError("cato auth revoke needs an API key id. Run 'cato auth list'.");
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    const keys = await auth.runList(transport);
    const key = keys.find((k) => k.id === id);
    if (gate.dryRun) {
      out(auth.renderRevokeDryRun(id, key));
      return 0;
    }
    const revoked = await auth.executeRevoke(transport, id);
    out(`Revoked API key ${revoked.id} (${revoked.name}) at ${revoked.revokedAt}.`);
    return 0;
  }

  throw new CliError(`Unknown auth subcommand '${sub}'.`);
}

async function runMarketing(
  sub: string,
  positionals: string[],
  flags: Record<string, FlagValue>,
  ctx: { json: boolean; csv: boolean; baseUrl?: string },
): Promise<number> {
  // Auth is resolved lazily: a dry run that only validates input should work
  // without credentials, so an agent can plan a campaign before it has a token.
  let cached: RestClient | null = null;
  const clientFor = async (): Promise<RestClient> => {
    if (cached) return cached;
    const creds = await resolveAuth(flags);
    const userToken = marketing.assertMarketingAuth(creds.userToken, creds.apiKey);
    cached = restClient(creds, userToken);
    return cached;
  };
  const client = sub === "create" ? (null as unknown as RestClient) : await clientFor();

  const campaignId = flagString(flags, "campaign") ?? positionals[0];

  if (sub === "campaigns") {
    if (campaignId) {
      const campaign = await marketing.getCampaign(client, campaignId);
      out(JSON.stringify(campaign, null, 2));
      return 0;
    }
    const campaigns = await marketing.listCampaigns(client);
    out(render(campaigns as unknown as Record<string, unknown>[], {
      json: ctx.json, csv: ctx.csv, columns: [...marketing.CAMPAIGN_COLUMNS],
    }));
    return 0;
  }

  // Not everything hangs off a campaign: `create` brings one into existence,
  // and the lookups are workspace-wide.
  const CAMPAIGN_FREE = new Set([
    "create", "access", "people", "filter-options", "crm-picker", "assets", "regenerate",
  ]);
  if (!CAMPAIGN_FREE.has(sub) && !campaignId) {
    throw new CliError(`cato marketing ${sub} needs --campaign <id>.`);
  }

  if (sub === "touchpoints") {
    const state = marketing.normalizeApprovalState(flagString(flags, "state"));
    const queue = await marketing.listReviewQueue(client, campaignId);
    const filtered = marketing.filterReviewQueue(queue, state);
    out(render(filtered as unknown as Record<string, unknown>[], {
      json: ctx.json, csv: ctx.csv, columns: [...marketing.REVIEW_QUEUE_COLUMNS],
    }));
    if (!ctx.json && !ctx.csv) out(`\n${filtered.length} touchpoint(s)${state ? ` in state '${state}'` : ""}.`);
    return 0;
  }

  if (sub === "dispatches") {
    const members = await marketing.listMembers(client, campaignId);
    out(render(members, { json: ctx.json, csv: ctx.csv }));
    return 0;
  }

  if (sub === "events") {
    const campaign = await marketing.getCampaign(client, campaignId);
    const tracking = campaign.tracking ?? campaign.trackingAggregate ?? null;
    out(JSON.stringify(tracking ?? { note: "No tracking aggregate on the campaign payload." }, null, 2));
    return 0;
  }

  if (sub === "schedule") {
    out(JSON.stringify(await marketing.getSchedule(client, campaignId), null, 2));
    return 0;
  }

  if (sub === "approve" || sub === "reject") {
    const touchpointId = flagString(flags, "touchpoint") ?? positionals[0];
    if (!touchpointId) throw new CliError(`cato marketing ${sub} needs --touchpoint <id>.`);
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    const item = await marketing.getTouchpoint(client, touchpointId);
    if (gate.dryRun) {
      out(marketing.renderApproveDryRun(item, sub));
      return 0;
    }
    if (sub === "approve") await marketing.approveTouchpoint(client, touchpointId);
    else await marketing.rejectTouchpoint(client, touchpointId);
    out(`Touchpoint ${touchpointId} ${sub === "approve" ? "approved" : "rejected"} (1 recipient affected).`);
    return 0;
  }

  if (sub === "send-now") {
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    const campaign = await marketing.getCampaign(client, campaignId);
    const queue = await marketing.listReviewQueue(client, campaignId);
    const approved = marketing.filterReviewQueue(queue, "approved");
    if (gate.dryRun) {
      out(marketing.renderSendNowDryRun(campaign, approved));
      return 0;
    }
    out(`About to send ${approved.length} approved touchpoint(s) for '${campaign.name}' NOW.`);
    const result = await marketing.sendApprovedNow(client, campaignId);
    out(`Sent ${result.sentCount}, errors ${result.errorCount}.`);
    return 0;
  }

  if (sub === "create") {
    const planned = build.planCreateCampaign({
      name: flagString(flags, "name") ?? positionals[0],
      mailSubject: flagString(flags, "subject"),
      message: flagString(flags, "message"),
      focusArea: flagString(flags, "focus-area"),
      ctaText: flagString(flags, "cta-text"),
      ctaLink: flagString(flags, "cta-link"),
      channel: flagString(flags, "channel") as "outbound" | "newsletter" | undefined,
      description: flagString(flags, "description"),
    });
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    if (gate.dryRun) {
      out(build.renderCreateDryRun(planned));
      return 0;
    }
    const created = await build.createCampaign(await clientFor(), planned);
    out(ctx.json ? JSON.stringify(created, null, 2) : `Created campaign '${created.name}' (${created.id}).`);
    out(`Open it: ${marketingUrl(ctx.baseUrl ?? DEFAULT_BASE_URL, created.id)}`);
    out("It is disabled, generation is off and it has no members yet.");
    return 0;
  }

  // `contacts` is de korte vorm van `members attach-matching`; `targets` wordt
  // verderop afgehandeld met zijn volledige list/add/add-matching/remove.
  if (sub === "contacts") {
    const filter = build.buildAudienceFilter({
      sourceSystem: flagString(flags, "source-system"),
      segment: flagString(flags, "segment"),
      branche: flagString(flags, "branche"),
    });
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    if (gate.dryRun) {
      out(build.renderAudienceDryRun(filter, campaignId, "members"));
      return 0;
    }
    out(JSON.stringify(await api.attachMatchingMembers(await clientFor(), campaignId, filter), null, 2));
    out(`\nCampaign: ${marketingUrl(ctx.baseUrl ?? DEFAULT_BASE_URL, campaignId)}`);
    return 0;
  }

  if (sub === "generation" || sub === "enable") {
    if (!campaignId) throw new CliError(`cato marketing ${sub} needs --campaign <id>.`);
    const off = flagBool(flags, "off") === true;
    const on = !off;
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    if (gate.dryRun) {
      out(`DRY RUN — would turn ${sub} ${on ? "ON" : "OFF"} for campaign ${campaignId}.`);
      if (sub === "generation" && on) {
        out("Generation writes drafts; it does not send. Each draft still needs approval.");
      }
      out("Re-run with --no-dry-run --yes to apply.");
      return 0;
    }
    const authed = await clientFor();
    if (sub === "generation") await build.setGeneration(authed, campaignId, on);
    else await build.setEnabled(authed, campaignId, on);
    out(`${sub} is now ${on ? "ON" : "OFF"} for campaign ${campaignId}.`);
    out(`Campaign: ${marketingUrl(ctx.baseUrl ?? DEFAULT_BASE_URL, campaignId)}`);
    return 0;
  }

  if (sub === "send-test") {
    if (!campaignId) throw new CliError("cato marketing send-test needs --campaign <id>.");
    const email = flagString(flags, "email");
    if (!email) throw new CliError("cato marketing send-test needs --email <address>.");
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    if (gate.dryRun) {
      out(`DRY RUN — would send ONE test mail for campaign ${campaignId} to ${email}.`);
      out("The audience is not touched by this command.");
      out("Re-run with --no-dry-run --yes to send it.");
      return 0;
    }
    await build.sendTest(await clientFor(), campaignId, email);
    out(`Test mail for campaign ${campaignId} sent to ${email}.`);
    return 0;
  }


  // ---- full API coverage: noun + verb -------------------------------------
  const verbArg = positionals[flagString(flags, "campaign") ? 0 : 1];
  const jsonBody = (): Record<string, unknown> => {
    const raw = flagString(flags, "body");
    if (!raw) throw new CliError(`cato marketing ${sub} needs --body '<json>'.`);
    try { return JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new CliError("--body is not valid JSON."); }
  };
  const gateOrThrow = () => {
    const g = resolveWriteGate(flags);
    if (g.blockedReason) throw new CliError(g.blockedReason);
    return g;
  };
  const show = (v: unknown) => out(JSON.stringify(v, null, 2));
  const campaignUrl = () => marketingUrl(ctx.baseUrl ?? DEFAULT_BASE_URL, campaignId);

  if (sub === "access") { show(await marketing.getAccess(client)); return 0; }
  if (sub === "people") { show(await api.listPeopleOptions(client)); return 0; }
  if (sub === "filter-options") { show(await api.listContactFilterOptions(client)); return 0; }
  if (sub === "crm-picker") { show(await api.listCrmPicker(client)); return 0; }

  if (sub === "assets") {
    const verb = api.requireVerb("assets", verbArg, ["list", "create", "update"]);
    if (verb === "list") { show(await api.listAssets(client)); return 0; }
    const g = gateOrThrow();
    const body = jsonBody();
    if (verb === "create") {
      const type = flagString(flags, "type");
      if (!type) throw new CliError("cato marketing assets create needs --type <text>.");
      if (g.dryRun) { out(api.renderWriteDryRun(`create ${type} asset`, [JSON.stringify(body)])); return 0; }
      show(await api.createAsset(client, type, body)); return 0;
    }
    const assetId = flagString(flags, "asset");
    if (!assetId) throw new CliError("cato marketing assets update needs --asset <uuid>.");
    if (g.dryRun) { out(api.renderWriteDryRun("update asset", [assetId, JSON.stringify(body)])); return 0; }
    show(await api.updateAsset(client, assetId, body)); return 0;
  }

  if (sub === "research") {
    const verb = api.requireVerb("research", verbArg, ["status", "start", "stop", "target"]);
    if (verb === "status") {
      out(api.renderResearchProgress(api.summariseResearch(await api.listTargets(client, campaignId))));
      out(`\nCampaign: ${campaignUrl()}`);
      return 0;
    }
    const g = gateOrThrow();
    if (verb === "target") {
      const targetId = flagString(flags, "target");
      if (!targetId) throw new CliError("cato marketing research target needs --target <uuid>.");
      if (g.dryRun) { out(api.renderWriteDryRun("research", [`Target: ${targetId}`], 1)); return 0; }
      show(await api.researchTarget(client, campaignId, targetId)); return 0;
    }
    if (verb === "stop") {
      if (g.dryRun) { out(api.renderWriteDryRun("stop research", [`Campaign: ${campaignId}`])); return 0; }
      show(await api.stopResearch(client, campaignId)); return 0;
    }
    const progress = api.summariseResearch(await api.listTargets(client, campaignId));
    if (g.dryRun) {
      out(api.renderWriteDryRun("start research", [
        `Campaign: ${campaignId}`,
        "Research calls an LLM per company and writes contact CANDIDATES, not members.",
        "Nothing is mailed by this.",
      ], progress.outstanding || progress.total));
      return 0;
    }
    show(await api.startResearch(client, campaignId));
    out(`\nStarted over ${progress.total} target(s). Follow with: cato marketing research status --campaign ${campaignId}`);
    return 0;
  }

  if (sub === "verify") {
    const [rawCandidates, targets, campaign] = await Promise.all([
      api.listSelectionCandidates(client, campaignId),
      api.listTargets(client, campaignId),
      marketing.getCampaign(client, campaignId),
    ]);

    const candidates: verify.ResearchCandidate[] = rawCandidates.map((c) => ({
      companyId: String(c.companyId ?? ""),
      companyName: String(c.companyName ?? c.company ?? "?"),
      companyDomain: (c.companyDomain ?? c.domainName ?? null) as string | null,
      displayName: String(c.displayName ?? "?"),
      jobTitle: (c.jobTitle ?? null) as string | null,
      primaryEmail: (c.primaryEmail ?? null) as string | null,
      sourceUrl: (c.sourceUrl ?? null) as string | null,
      validationWarnings: (c.validationWarnings ?? null) as unknown[] | null,
    }));

    const domains = candidates
      .map((c) => verify.emailDomain(c.primaryEmail))
      .filter((d): d is string => d !== null);
    const { undeliverable, unresolved } = await verify.checkDeliverability(domains);

    const assessment = verify.assessAcceptance({
      candidates,
      targets: targets.map((t) => ({
        companyId: String(t.companyId ?? ""),
        companyName: String(t.companyName ?? "?"),
        status: String(t.status ?? "unknown"),
      })),
      maxPerCompany: Number((campaign as Record<string, unknown>).maxTitleCandidatesPerCompany ?? 4),
      undeliverableDomains: undeliverable,
      unresolvedDomains: unresolved,
    });

    out(ctx.json ? JSON.stringify(assessment, null, 2) : verify.renderAcceptance(assessment));
    return assessment.verdict === "do-not-send" ? 1 : 0;
  }

  if (sub === "candidates") {
    const verb = api.requireVerb("candidates", verbArg, ["list", "attach", "remove", "attach-crm", "staged"]);
    if (verb === "list") {
      const rows = await api.listSelectionCandidates(client, campaignId);
      out(render(rows, { json: ctx.json, csv: ctx.csv }));
      if (!ctx.json && !ctx.csv) out(`\n${rows.length} candidate(s).`);
      return 0;
    }
    if (verb === "staged") { show(await api.listContactCandidates(client, campaignId)); return 0; }
    const g = gateOrThrow();
    const ids = api.requireIds(flagString(flags, "ids"), verb === "attach-crm" ? "person" : "candidate");
    if (g.dryRun) { out(api.renderWriteDryRun(verb, [`Campaign: ${campaignId}`, `Ids: ${ids.join(", ")}`], ids.length)); return 0; }
    const result = verb === "attach" ? await api.attachCandidates(client, campaignId, ids)
      : verb === "remove" ? await api.removeCandidates(client, campaignId, ids)
      : await api.attachCrmContacts(client, campaignId, ids);
    show(result); out(`\nCampaign: ${campaignUrl()}`); return 0;
  }

  if (sub === "members") {
    const verb = api.requireVerb("members", verbArg,
      ["list", "add", "bulk", "attach-matching", "remove", "stop", "mark-todo"]);
    if (verb === "list") {
      const rows = await api.listMembers(client, campaignId);
      out(render(rows, { json: ctx.json, csv: ctx.csv }));
      if (!ctx.json && !ctx.csv) out(`\n${rows.length} member(s).`);
      return 0;
    }
    const g = gateOrThrow();
    if (verb === "attach-matching") {
      const filter = build.buildAudienceFilter({
        sourceSystem: flagString(flags, "source-system"),
        segment: flagString(flags, "segment"),
        branche: flagString(flags, "branche"),
      });
      if (g.dryRun) { out(build.renderAudienceDryRun(filter, campaignId, "members")); return 0; }
      show(await api.attachMatchingMembers(client, campaignId, filter)); return 0;
    }
    if (verb === "mark-todo") {
      if (g.dryRun) { out(api.renderWriteDryRun("mark members as todo", [`Campaign: ${campaignId}`])); return 0; }
      show(await api.markMembersAsTodo(client, campaignId)); return 0;
    }
    if (verb === "remove" || verb === "stop") {
      const memberId = flagString(flags, "member");
      if (!memberId) throw new CliError(`cato marketing members ${verb} needs --member <uuid>.`);
      if (g.dryRun) { out(api.renderWriteDryRun(verb, [`Member: ${memberId}`], 1)); return 0; }
      show(verb === "remove" ? await api.removeMember(client, campaignId, memberId)
                             : await api.stopMember(client, campaignId, memberId));
      return 0;
    }
    const ids = api.requireIds(flagString(flags, "ids"), "person");
    if (g.dryRun) { out(api.renderWriteDryRun(verb, [`Campaign: ${campaignId}`, `People: ${ids.join(", ")}`], ids.length)); return 0; }
    show(verb === "add" ? await api.attachPerson(client, campaignId, ids[0]!)
                        : await api.bulkAttachMembers(client, campaignId, ids));
    return 0;
  }

  if (sub === "targets") {
    const verb = api.requireVerb("targets", verbArg, ["add-matching", "list", "add", "remove"]);
    if (verb === "list") {
      const rows = await api.listTargets(client, campaignId);
      out(render(rows, { json: ctx.json, csv: ctx.csv }));
      if (!ctx.json && !ctx.csv) out(`\n${rows.length} company target(s).`);
      return 0;
    }
    const g = gateOrThrow();
    if (verb === "remove") {
      const targetId = flagString(flags, "target");
      if (!targetId) throw new CliError("cato marketing targets remove needs --target <uuid>.");
      if (g.dryRun) { out(api.renderWriteDryRun("remove target", [targetId], 1)); return 0; }
      show(await api.removeTarget(client, campaignId, targetId)); return 0;
    }
    if (verb === "add") {
      const ids = api.requireIds(flagString(flags, "ids"), "company");
      if (g.dryRun) { out(api.renderWriteDryRun("add targets", [`Companies: ${ids.join(", ")}`], ids.length)); return 0; }
      show(await api.addTargets(client, campaignId, ids)); return 0;
    }
    const filter = build.buildAudienceFilter({
      sourceSystem: flagString(flags, "source-system"),
      segment: flagString(flags, "segment"),
      branche: flagString(flags, "branche"),
    });
    if (g.dryRun) { out(build.renderAudienceDryRun(filter, campaignId, "company-targets")); return 0; }
    show(await api.addMatchingTargets(client, campaignId, filter));
    out(`\nCampaign: ${campaignUrl()}`);
    return 0;
  }

  if (sub === "prompts" || sub === "search-settings" || sub === "schedule") {
    const verb = api.requireVerb(sub, verbArg, ["get", "set"]);
    if (verb === "get") {
      show(sub === "prompts" ? await api.getPrompts(client, campaignId)
         : sub === "search-settings" ? await api.getSearchSettings(client, campaignId)
         : await marketing.getSchedule(client, campaignId));
      return 0;
    }
    const g = gateOrThrow();
    const body = jsonBody();
    if (g.dryRun) { out(api.renderWriteDryRun(`set ${sub}`, [`Campaign: ${campaignId}`, JSON.stringify(body)])); return 0; }
    show(sub === "prompts" ? await api.setPrompts(client, campaignId, body)
       : sub === "search-settings" ? await api.setSearchSettings(client, campaignId, body)
       : await api.setSchedule(client, campaignId, body));
    return 0;
  }

  if (sub === "update" || sub === "archive" || sub === "restore" || sub === "delete") {
    const g = gateOrThrow();
    if (sub === "update") {
      const body = jsonBody();
      if (g.dryRun) { out(api.renderWriteDryRun("update campaign", [campaignId, JSON.stringify(body)])); return 0; }
      show(await api.updateCampaign(client, campaignId, body)); return 0;
    }
    if (g.dryRun) { out(api.renderWriteDryRun(`${sub} campaign`, [`Campaign: ${campaignId}`])); return 0; }
    show(sub === "archive" ? await api.archiveCampaign(client, campaignId)
       : sub === "restore" ? await api.restoreCampaign(client, campaignId)
       : await api.deleteCampaign(client, campaignId));
    return 0;
  }

  if (sub === "regenerate") {
    const touchpointId = flagString(flags, "touchpoint") ?? positionals[0];
    if (!touchpointId) throw new CliError("cato marketing regenerate needs --touchpoint <uuid>.");
    const g = gateOrThrow();
    if (g.dryRun) { out(api.renderWriteDryRun("regenerate draft", [`Touchpoint: ${touchpointId}`], 1)); return 0; }
    show(await api.regenerateTouchpoint(client, touchpointId)); return 0;
  }

  if (sub === "bulk-approve") {
    const g = gateOrThrow();
    const queue = await marketing.listReviewQueue(client, campaignId);
    const pending = marketing.filterReviewQueue(queue, "pending");
    if (g.dryRun) {
      out(api.renderWriteDryRun("bulk-approve", [
        `Campaign: ${campaignId}`,
        "Approving marks these drafts ready; the scheduler may then send them in the next window.",
      ], pending.length));
      return 0;
    }
    out(`Approving ${pending.length} pending draft(s) for campaign ${campaignId}.`);
    show(await api.bulkApproveDrafts(client, campaignId));
    return 0;
  }

  if (sub === "tracking-simulate") {
    const g = gateOrThrow();
    if (g.dryRun) { out(api.renderWriteDryRun("simulate tracking", [`Campaign: ${campaignId}`])); return 0; }
    show(await api.simulateTracking(client, campaignId)); return 0;
  }

  throw new CliError(`Unknown marketing subcommand '${sub}'.`);
}

const code = await main(process.argv.slice(2)).catch((err: unknown) => {
  const e = err as Error;
  if (e instanceof CliError || e instanceof FilterError || e instanceof auth.AuthError || e instanceof marketing.MarketingAuthError) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  process.stderr.write(`error: ${e.message ?? String(err)}\n`);
  return 1;
});
process.exit(code);
