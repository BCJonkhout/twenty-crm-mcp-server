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
  executeWrites, planWrites, renderWritePlan, type ImportRow,
} from "./commands/importWrite.ts";
import * as auth from "./commands/auth.ts";
import * as marketing from "./commands/marketing.ts";
import * as build from "./commands/campaignBuild.ts";
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
  ctx: { json: boolean; csv: boolean },
): Promise<number> {
  const creds = await resolveAuth(flags);
  const client = restClient(creds);

  if (sub === "get") {
    const id = positionals[0];
    if (!id) throw new CliError(`cato ${objectPath} get needs a record id as its argument.`);
    out(await runGet(client, objectPath, id, flags, ctx));
    return 0;
  }

  if (sub === "search") {
    const query = flagString(flags, "query") ?? positionals[0];
    if (!query) throw new CliError(`cato ${objectPath} search needs a search term.`);
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
  const gate = resolveWriteGate(flags);
  if (gate.blockedReason) throw new CliError(gate.blockedReason);

  if (gate.dryRun) {
    out(renderWritePlan(plan, sourceSystem, ctx.json));
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
    const userToken = marketing.assertMarketingAuth(creds.userToken);
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

  // `create` is the one subcommand that brings a campaign into existence, so it
  // is the one subcommand that cannot be asked for a campaign id.
  if (sub !== "create" && !campaignId) {
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

  if (sub === "targets" || sub === "contacts") {
    if (!campaignId) throw new CliError(`cato marketing ${sub} needs --campaign <id>.`);
    const filter = build.buildAudienceFilter({
      sourceSystem: flagString(flags, "source-system"),
      segment: flagString(flags, "segment"),
      branche: flagString(flags, "branche"),
    });
    const gate = resolveWriteGate(flags);
    if (gate.blockedReason) throw new CliError(gate.blockedReason);
    if (gate.dryRun) {
      out(build.renderAudienceDryRun(filter, campaignId, sub === "targets" ? "company-targets" : "members"));
      return 0;
    }
    const authed = await clientFor();
    const result = sub === "targets"
      ? await build.addMatchingCompanyTargets(authed, campaignId, filter)
      : await build.attachMatchingMembers(authed, campaignId, filter);
    out(JSON.stringify(result, null, 2));
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
