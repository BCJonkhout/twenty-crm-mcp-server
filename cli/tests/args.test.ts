import { describe, expect, it } from "bun:test";
import {
  flagBool, flagList, flagNumber, flagString, parseArgs, resolveWriteGate,
} from "../src/args.ts";
import { COMMAND_TREE, flagSpecsFor } from "../src/commands.ts";

const parse = (argv: string[]) => parseArgs(argv, COMMAND_TREE, flagSpecsFor);

describe("parseArgs — command resolution", () => {
  it("resolves a group + subcommand", () => {
    const r = parse(["people", "list", "--limit", "5"]);
    expect(r.command).toEqual(["people", "list"]);
    expect(r.errors).toEqual([]);
    expect(flagNumber(r.flags, "limit")).toBe(5);
  });

  it("resolves a group with no subcommand tree (import)", () => {
    const r = parse(["import", "--csv", "leads.csv"]);
    expect(r.command).toEqual(["import"]);
    expect(flagString(r.flags, "csv")).toBe("leads.csv");
    expect(r.errors).toEqual([]);
  });

  it("reports an unknown group", () => {
    const r = parse(["persons", "list"]);
    expect(r.command).toEqual([]);
    expect(r.errors[0]).toContain("Unknown command: 'persons'");
  });

  it("reports an unknown subcommand and names the valid ones", () => {
    const r = parse(["people", "delete"]);
    expect(r.command).toEqual(["people"]);
    expect(r.errors[0]).toContain("Unknown subcommand 'delete'");
    expect(r.errors[0]).toContain("list, get, search");
  });

  it("keeps a trailing positional after a subcommand", () => {
    const r = parse(["people", "get", "abc-123"]);
    expect(r.command).toEqual(["people", "get"]);
    expect(r.positionals).toEqual(["abc-123"]);
  });
});

describe("parseArgs — flag parsing", () => {
  it("accepts --flag=value and --flag value identically", () => {
    const a = parse(["people", "list", "--job-title=advocaat"]);
    const b = parse(["people", "list", "--job-title", "advocaat"]);
    expect(flagString(a.flags, "job-title")).toBe("advocaat");
    expect(flagString(b.flags, "job-title")).toBe("advocaat");
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    // The whole point: a typo must not silently widen a selection.
    const r = parse(["people", "list", "--segement", "twente"]);
    expect(r.errors).toEqual(["Unknown flag: --segement"]);
  });

  it("rejects a non-numeric value for a number flag", () => {
    const r = parse(["people", "list", "--limit", "veel"]);
    expect(r.errors[0]).toContain("expects a number");
    expect(flagNumber(r.flags, "limit")).toBeUndefined();
  });

  it("rejects a value-taking flag with no value", () => {
    const r = parse(["people", "list", "--job-title", "--json"]);
    expect(r.errors[0]).toContain("--job-title expects a value");
  });

  it("supports a short alias", () => {
    const r = parse(["auth", "create", "-y"]);
    expect(flagBool(r.flags, "yes")).toBe(true);
  });

  it("supports --no-<flag> to negate a boolean", () => {
    const r = parse(["auth", "create", "--no-dry-run"]);
    expect(flagBool(r.flags, "dry-run")).toBe(false);
  });

  it("accumulates a repeatable string[] flag and splits on commas", () => {
    const r = parse(["people", "list", "--product", "LEO", "--product", "VERA,ZIA"]);
    expect(flagList(r.flags, "product")).toEqual(["LEO", "VERA", "ZIA"]);
  });

  it("treats everything after -- as positional", () => {
    const r = parse(["people", "search", "--", "--json"]);
    expect(r.positionals).toEqual(["--json"]);
    expect(flagBool(r.flags, "json")).toBeUndefined();
  });

  it("accepts a negative number as a flag value", () => {
    const r = parse(["companies", "list", "--min-employees", "-5"]);
    expect(flagNumber(r.flags, "min-employees")).toBe(-5);
    expect(r.errors).toEqual([]);
  });

  it("scopes flags to their command: --stage is unknown outside opportunities", () => {
    expect(parse(["opportunities", "list", "--stage", "NEW"]).errors).toEqual([]);
    expect(parse(["notes", "list", "--stage", "NEW"]).errors[0]).toBe("Unknown flag: --stage");
  });
});

describe("resolveWriteGate", () => {
  it("defaults to a dry run when no flags are given", () => {
    const gate = resolveWriteGate(parse(["auth", "create"]).flags);
    expect(gate.dryRun).toBe(true);
    expect(gate.blockedReason).toBeNull();
  });

  it("still dry-runs when only --yes is given", () => {
    const gate = resolveWriteGate(parse(["auth", "create", "--yes"]).flags);
    expect(gate.dryRun).toBe(true);
  });

  it("blocks --no-dry-run without --yes", () => {
    const gate = resolveWriteGate(parse(["auth", "create", "--no-dry-run"]).flags);
    expect(gate.dryRun).toBe(false);
    expect(gate.blockedReason).toContain("--yes");
  });

  it("only permits a write with --no-dry-run AND --yes", () => {
    const gate = resolveWriteGate(parse(["auth", "create", "--no-dry-run", "--yes"]).flags);
    expect(gate.dryRun).toBe(false);
    expect(gate.confirmed).toBe(true);
    expect(gate.blockedReason).toBeNull();
  });
});
