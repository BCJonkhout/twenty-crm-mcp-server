import { COMMAND_SUMMARIES, COMMAND_TREE, flagSpecsFor } from "./commands.ts";
import { GLOBAL_FLAGS, type FlagSpecs } from "./args.ts";

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
  );
  return lines.join("\n");
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
