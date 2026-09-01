import { COMMAND_SUMMARIES, COMMAND_TREE, flagSpecsFor } from "./commands.ts";
import { GLOBAL_FLAGS, type FlagSpecs } from "./args.ts";
import { TASK_BOARD_VALUES, TASK_STATUS_VALUES } from "./filters.ts";

export const VERSION = "0.2.0";

function renderFlags(specs: FlagSpecs): string[] {
  const entries = Object.entries(specs);
  if (entries.length === 0) return [];
  const left = entries.map(([name, spec]) => {
    const alias = spec.alias ? `-${spec.alias}, ` : "";
    return `  ${alias}--${name}${spec.placeholder ? ` ${spec.placeholder}` : ""}`;
  });
  const width = Math.max(...left.map((l) => l.length));
  return entries.map(([, spec], i) => `${left[i]!.padEnd(width)}  ${spec.description}`);
}

export function topLevelHelp(): string {
  const lines = [
    `cato ${VERSION} — command line interface for PrudAI's Twenty CRM instance (CATO).`,
    "",
    "READ-FIRST BY DESIGN. Every command that changes production requires",
    "--no-dry-run --yes. `cato import` has no write path at all.",
    "",
    "Usage: cato <group> <command> [flags]",
    "",
    "Command groups:",
  ];
  for (const [group, subs] of Object.entries(COMMAND_TREE)) {
    const shown = subs.length ? subs.join(" | ") : "(no subcommand)";
    lines.push(`  ${group.padEnd(14)} ${shown}`);
  }
  lines.push("", "Global flags:", ...renderFlags(GLOBAL_FLAGS));
  lines.push(
    "",
    "Examples:",
    "  cato auth status",
    "  cato people list --branche ADVOCATUUR --contactable --limit 50 --csv",
    "  cato companies list --city Enschede --json",
    "  cato segments build --name twente-advocaten --branche ADVOCATUUR --city Enschede --wave-size 100 --csv",
    "  cato tasks list --overdue --assignee beau --board OPERATIONS",
    "  cato tasks create --title \"Bel terug\" --board SALES --company-id <uuid> --due 2026-09-04 --no-dry-run --yes",
    "  cato tasks claim <id> --assignee codex --no-dry-run --yes",
    "  cato tasks comment <id> --body \"🤖 opgepakt in sessie X\" --no-dry-run --yes",
    "  cato import --csv leads.csv               # dry run, always",
    "  cato marketing touchpoints --campaign <id> --state pending",
    "",
    "Run 'cato <group> --help' for group detail.",
    "Coding agent? Run 'cato guide' first — the task-board workflow and the write gate.",
  );
  return lines.join("\n");
}

/**
 * `cato guide` — the contract for a coding agent driving this CLI.
 *
 * It exists because the per-command help answers "what flags does this take?"
 * and an agent's actual questions are "how do I not break production?" and
 * "how do I leave a trace a human can read?". Those answers were previously
 * spread over a Dutch README and a handful of skill files that never travelled
 * with the binary; this one ships with the CLI and is therefore always the
 * version that matches the installed commands.
 */
export function agentGuide(): string {
  const boards = TASK_BOARD_VALUES.filter((b) => b !== "PRUDAI").join(", ");
  return [
    `cato ${VERSION} — guide for coding agents`,
    "",
    "CATO is PrudAI's CRM (a Twenty instance at crm.prudai.com). Its `task` object is",
    "the team's task board. If you are an agent doing work for PrudAI, the board is where",
    "your work becomes visible to a human — a task nobody updated is indistinguishable",
    "from work nobody did.",
    "",
    "1. CREDENTIALS",
    "   Resolution order, first hit wins:",
    "     --profile <name>  >  $CATO_API_KEY  >  default profile in the credentials file",
    "     >  OpenBao kv/prod/cato-cli/app (needs $CATO_BAO_TOKEN)",
    "   Unattended (CI, container, cron): export CATO_API_KEY.",
    "   Interactive: cato auth set --stdin   (never pass a key as a flag — shell history)",
    "   Check what you hold and what it may do:  cato auth status",
    "",
    "2. READ FREELY, WRITE DELIBERATELY",
    "   Reads are unrestricted. Add --json to anything you parse; --csv for a spreadsheet.",
    "   Every writing command is a DRY RUN unless you pass BOTH --no-dry-run and --yes.",
    "   That is deliberate: run it once to read the plan, then re-run with the gate. Do not",
    "   reach for the gate reflexively — the dry run is the only preview you get.",
    "   `cato import` has no write path at all, whatever flags you give it.",
    "",
    "3. TRACKING YOUR OWN WORK — the loop",
    "   find     cato tasks list --status TODO --board OPERATIONS --json",
    "   take     cato tasks claim <id> --assignee <you> --no-dry-run --yes",
    "   report   cato tasks comment <id> --body \"…what you did, where it landed…\" --no-dry-run --yes",
    "   finish   cato tasks done <id> --no-dry-run --yes",
    "   blocked  cato tasks park <id> --no-dry-run --yes        (ON_HOLD, due +14 days)",
    "   new      cato tasks create --title \"…\" --board <board> --due <date> --no-dry-run --yes",
    "",
    "   Comment BEFORE you finish. `done` on its own tells a reader that something",
    "   happened, not what — and the card is all they get.",
    "",
    "4. WHAT THE BOARD EXPECTS (house rules the CLI enforces)",
    `   boards    ${boards}`,
    `   statuses  ${TASK_STATUS_VALUES.join(", ")}`,
    "   create    --board is required; so is --due unless you pass --no-due, and a target",
    "             (--company-id / --person-id / --opportunity-id) unless --no-target.",
    "   triage    --source AGENT (also MEMO, CHAT) lands the task in INBOX, for a human to",
    "             triage. Agents create work for review; they do not schedule it themselves.",
    "   one card  A follow-up on the same thread is a comment, not a second task.",
    "",
    "5. EXIT CODES",
    "   0  fine.   2  you got it wrong (bad flags, bad filter, missing credential, refused",
    "   write) — the message on stderr says what.   1  something else broke; treat as",
    "   unknown state and check before retrying a write.",
    "",
    "6. WHAT YOU MAY NOT BE ABLE TO DO",
    "   Keys are scoped by role. An agent key typically reads everything and writes only",
    "   tasks and comments; a refused write comes back as PERMISSION_DENIED. That is the",
    "   design, not a bug — do not work around it, and do not ask for a broader key to get",
    "   past one command. `cato auth roles` shows what exists.",
    "",
    "7. DELETE IS FOREVER",
    "   `cato … delete` is a hard delete: the row leaves the database. The trash can in the",
    "   web UI is a soft delete; this is not. There is no undo and no backup you can reach",
    "   from here. Prefer `tasks park`, a status change, or asking a human.",
    "",
    "Full reference: cli/README.md in the repo. Per-command flags: cato <group> --help.",
  ].join("\n");
}

export function commandHelp(command: readonly string[]): string {
  const [group, sub] = command;
  if (!group) return topLevelHelp();

  const key = sub ? `${group} ${sub}` : group;
  const summary = COMMAND_SUMMARIES[key];
  const subs = COMMAND_TREE[group] ?? [];

  const lines = [`cato ${key}`, ""];
  if (summary) lines.push(summary, "");
  if (!sub && subs.length > 0) {
    lines.push("Subcommands:");
    for (const s of subs) {
      lines.push(`  ${s.padEnd(14)} ${COMMAND_SUMMARIES[`${group} ${s}`] ?? ""}`);
    }
    lines.push("");
  }

  const specs = flagSpecsFor(command);
  if (Object.keys(specs).length > 0) {
    lines.push("Flags:", ...renderFlags(specs), "");
  }
  lines.push("Global flags:", ...renderFlags(GLOBAL_FLAGS));
  return lines.join("\n");
}
