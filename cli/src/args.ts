// Spec-driven argv parser for the `cato` CLI.
//
// Deliberately hand-rolled (no dependency): the CLI is the *auditable* seam in
// front of a production CRM, so flag handling has to be boring, total, and
// unit-testable without a network. Unknown flags are errors, never silently
// ignored — a typo'd `--segement` must not widen a segment selection to
// "everyone".

export type FlagType = "string" | "number" | "boolean" | "string[]";

export interface FlagSpec {
  type: FlagType;
  alias?: string;
  description: string;
  /** Placeholder shown in help for value-taking flags. */
  placeholder?: string;
  /**
   * For `string[]` flags: keep each occurrence as one value instead of also
   * splitting on commas. Needed when the value itself may contain a comma
   * (`--field labels=a,b`); the flag is then repeatable only.
   */
  noSplit?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

export type FlagValue = string | number | boolean | string[];

export interface ParseResult {
  /** Resolved command path, e.g. ["people", "list"]. Empty when none matched. */
  command: string[];
  /** Positional arguments left over after the command path. */
  positionals: string[];
  flags: Record<string, FlagValue>;
  errors: string[];
}

/**
 * Flags every command understands. `--dry-run` defaults to ON and is only
 * meaningful for commands that write; read commands ignore it.
 */
export const GLOBAL_FLAGS: FlagSpecs = {
  json: { type: "boolean", description: "Emit raw JSON (default for machine use)." },
  csv: { type: "boolean", description: "Emit CSV instead of a table." },
  limit: { type: "number", placeholder: "<n>", description: "Max records to return (default 20; segments build defaults to 1000)." },
  "dry-run": { type: "boolean", description: "Show what would happen without writing. ON by default for every writing command." },
  yes: { type: "boolean", alias: "y", description: "Confirm a writing command. Required together with --no-dry-run." },
  profile: { type: "string", placeholder: "<name>", description: "Credential profile to use (default: 'default', or $CATO_PROFILE)." },
  "base-url": { type: "string", placeholder: "<url>", description: "Override the CATO base URL (default https://crm.prudai.com)." },
  help: { type: "boolean", alias: "h", description: "Show help for the command." },
  version: { type: "boolean", description: "Print the CLI version." },
};

interface NormalizedFlag {
  canonical: string;
  spec: FlagSpec;
}

function buildLookup(specs: FlagSpecs): Map<string, NormalizedFlag> {
  const lookup = new Map<string, NormalizedFlag>();
  for (const [canonical, spec] of Object.entries(specs)) {
    lookup.set(canonical, { canonical, spec });
    if (spec.alias) lookup.set(spec.alias, { canonical, spec });
  }
  return lookup;
}

/**
 * Walk `argv` against a command tree, then parse the remaining tokens as flags
 * and positionals. `commandTree` maps a command name to its subcommand names
 * (empty array = leaf).
 */
export function parseArgs(
  argv: readonly string[],
  commandTree: Record<string, readonly string[]>,
  flagSpecsFor: (command: readonly string[]) => FlagSpecs,
): ParseResult {
  const errors: string[] = [];
  const command: string[] = [];
  const rest: string[] = [];

  // Phase 1 — peel off the command path from the *leading* non-flag tokens.
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token.startsWith("-")) break;
    if (command.length === 0) {
      if (!(token in commandTree)) break;
      command.push(token);
      i++;
      continue;
    }
    if (command.length === 1) {
      const subs = commandTree[command[0]!] ?? [];
      if (!subs.includes(token)) break;
      command.push(token);
      i++;
      continue;
    }
    break;
  }
  rest.push(...argv.slice(i));

  if (command.length === 0) {
    const first = argv[i];
    if (first !== undefined && !first.startsWith("-")) {
      errors.push(`Unknown command: '${first}'. Run 'cato --help' for the command list.`);
    }
  } else if (command.length === 1) {
    const subs = commandTree[command[0]!] ?? [];
    if (subs.length > 0) {
      const next = rest[0];
      if (next === undefined || next.startsWith("-")) {
        // A bare group like `cato people` — help will be shown by the caller.
      } else {
        errors.push(
          `Unknown subcommand '${next}' for '${command[0]}'. Valid: ${subs.join(", ")}.`,
        );
      }
    }
  }

  // Phase 2 — flags and positionals.
  const specs = { ...GLOBAL_FLAGS, ...flagSpecsFor(command) };
  const lookup = buildLookup(specs);
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  let onlyPositionals = false;
  for (let j = 0; j < rest.length; j++) {
    const token = rest[j]!;

    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // --name=value | --name value | -a value | --no-name
    const isLong = token.startsWith("--");
    const body = isLong ? token.slice(2) : token.slice(1);
    const eq = body.indexOf("=");
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (isLong && rawName.startsWith("no-")) {
      const negated = rawName.slice(3);
      const entry = lookup.get(negated);
      if (entry && entry.spec.type === "boolean") {
        if (inlineValue !== undefined) {
          errors.push(`Flag --no-${negated} does not take a value.`);
          continue;
        }
        flags[entry.canonical] = false;
        continue;
      }
    }

    const entry = lookup.get(rawName);
    if (!entry) {
      errors.push(`Unknown flag: ${isLong ? "--" : "-"}${rawName}`);
      continue;
    }

    const { canonical, spec } = entry;

    if (spec.type === "boolean") {
      if (inlineValue !== undefined) {
        if (inlineValue === "true" || inlineValue === "false") {
          flags[canonical] = inlineValue === "true";
        } else {
          errors.push(`Flag --${canonical} expects true/false, got '${inlineValue}'.`);
        }
        continue;
      }
      flags[canonical] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = rest[j + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !/^-\d/.test(next))) {
        errors.push(`Flag --${canonical} expects a value.`);
        continue;
      }
      value = next;
      j++;
    }

    if (spec.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`Flag --${canonical} expects a number, got '${value}'.`);
        continue;
      }
      flags[canonical] = n;
      continue;
    }

    if (spec.type === "string[]") {
      // Repeatable AND comma-separable: --product LEO --product VERA == --product LEO,VERA
      // (unless the spec says noSplit — then only repeatable).
      const parts = spec.noSplit
        ? [value]
        : value.split(",").map((p) => p.trim()).filter(Boolean);
      const existing = flags[canonical];
      flags[canonical] = Array.isArray(existing) ? [...existing, ...parts] : parts;
      continue;
    }

    flags[canonical] = value;
  }

  return { command, positionals, flags, errors };
}

// ---- typed accessors -------------------------------------------------------

export function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(flags: Record<string, FlagValue>, name: string): number | undefined {
  const v = flags[name];
  return typeof v === "number" ? v : undefined;
}

export function flagBool(flags: Record<string, FlagValue>, name: string): boolean | undefined {
  const v = flags[name];
  return typeof v === "boolean" ? v : undefined;
}

export function flagList(flags: Record<string, FlagValue>, name: string): string[] | undefined {
  const v = flags[name];
  return Array.isArray(v) ? v : undefined;
}

/**
 * Resolve the write-gate. Writing commands must be *explicitly* let out of
 * dry-run AND confirmed: `--no-dry-run --yes`. `--yes` alone is not enough,
 * and the default (no flags at all) is always a dry run.
 */
export interface WriteGate {
  dryRun: boolean;
  confirmed: boolean;
  /** Non-null when the command may not proceed; message explains why. */
  blockedReason: string | null;
}

export function resolveWriteGate(flags: Record<string, FlagValue>): WriteGate {
  const dryRunFlag = flagBool(flags, "dry-run");
  const confirmed = flagBool(flags, "yes") === true;
  const dryRun = dryRunFlag !== false;

  if (dryRun) return { dryRun: true, confirmed, blockedReason: null };
  if (!confirmed) {
    return {
      dryRun: false,
      confirmed: false,
      blockedReason:
        "Refusing to write: --no-dry-run given without --yes. Add --yes to confirm you intend to change production CATO.",
    };
  }
  return { dryRun: false, confirmed: true, blockedReason: null };
}
