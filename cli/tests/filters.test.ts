import { describe, expect, it } from "bun:test";
import {
  buildCompanyFilter, buildNoteFilter, buildOpportunityFilter, buildPeopleFilter,
  FilterError, isoDate,
} from "../src/filters.ts";
import { planList } from "../src/commands/records.ts";
import { parseArgs } from "../src/args.ts";
import { COMMAND_TREE, flagSpecsFor } from "../src/commands.ts";

describe("buildPeopleFilter", () => {
  it("always adds the soft-delete guard", () => {
    expect(buildPeopleFilter({})).toBe("deletedAt[is]:NULL");
  });

  it("drops the soft-delete guard when deleted records are requested", () => {
    expect(buildPeopleFilter({ includeDeleted: true })).toBeNull();
  });

  it("uses ilike (case-insensitive) for job title, not like", () => {
    const f = buildPeopleFilter({ jobTitle: "advocaat" })!;
    expect(f).toContain('jobTitle[ilike]:"%advocaat%"');
    expect(f).not.toContain("[like]");
  });

  it("validates the branche enum and upper-cases it", () => {
    expect(buildPeopleFilter({ branche: "advocatuur" })!).toContain('branche[eq]:"ADVOCATUUR"');
    expect(() => buildPeopleFilter({ branche: "notariaat" })).toThrow(FilterError);
  });

  it("emits containsAny for the MULTI_SELECT product tag", () => {
    expect(buildPeopleFilter({ product: ["LEO", "VERA"] })!).toContain("product[containsAny]:[LEO,VERA]");
  });

  it("rejects an unknown product tag rather than sending it to the CRM", () => {
    expect(() => buildPeopleFilter({ product: ["ALEX"] })).toThrow(/not a valid value/);
  });

  it("treats a NULL doNotContact as contactable", () => {
    // Regression guard: doNotContact is nullable and NULL means "never
    // flagged". A bare doNotContact[eq]:false would silently drop every
    // contact that was never touched.
    const f = buildPeopleFilter({ contactable: true })!;
    expect(f).toContain("or(doNotContact[is]:NULL,doNotContact[eq]:false)");
    expect(f).toContain("marketingOptOutAt[is]:NULL");
    expect(f).toContain("emails.primaryEmail[is]:NOT_NULL");
  });

  it("leaves NULL / NOT_NULL unquoted for the is operator", () => {
    const f = buildPeopleFilter({ hasEmail: true })!;
    expect(f).toContain("emails.primaryEmail[is]:NOT_NULL");
    expect(f).not.toContain('[is]:"NOT_NULL"');
  });

  it("AND-combines several filters", () => {
    const f = buildPeopleFilter({ branche: "ADVOCATUUR", segment: "Twente" })!;
    expect(f).toBe('and(and(prudaiMarketingSourceSegment[eq]:"Twente",branche[eq]:"ADVOCATUUR"),deletedAt[is]:NULL)');
  });

  it("escapes quotes in a user-supplied value", () => {
    expect(buildPeopleFilter({ jobTitle: 'a"b' })!).toContain('jobTitle[ilike]:"%a\\"b%"');
  });

  it("normalises a bare date to an ISO timestamp", () => {
    expect(buildPeopleFilter({ createdSince: "2026-04-01" })!).toContain('createdAt[gte]:"2026-04-01T00:00:00.000Z"');
  });

  it("strips a leading @ from an e-mail domain", () => {
    expect(buildPeopleFilter({ emailDomain: "@prudai.com" })!).toContain('emails.primaryEmail[ilike]:"%@prudai.com"');
  });
});

describe("buildCompanyFilter", () => {
  it("OR-combines a city list", () => {
    const f = buildCompanyFilter({ cities: ["Enschede", "Hengelo"] })!;
    expect(f).toContain('or(address.addressCity[eq]:"Enschede",address.addressCity[eq]:"Hengelo")');
  });

  it("supports an employee range", () => {
    const f = buildCompanyFilter({ minEmployees: 10, maxEmployees: 50 })!;
    expect(f).toContain("employees[gte]:10");
    expect(f).toContain("employees[lte]:50");
  });
});

describe("buildOpportunityFilter / buildNoteFilter", () => {
  it("validates the opportunity stage enum", () => {
    expect(buildOpportunityFilter({ stage: "meeting" })!).toContain('stage[eq]:"MEETING"');
    expect(() => buildOpportunityFilter({ stage: "WON" })).toThrow(FilterError);
  });

  it("filters notes on title", () => {
    expect(buildNoteFilter({ title: "Juristi" })!).toContain('title[ilike]:"%Juristi%"');
  });
});

describe("isoDate", () => {
  it("rejects nonsense instead of producing Invalid Date", () => {
    expect(() => isoDate("created-since", "gisteren")).toThrow(/not a valid date/);
  });
});

describe("planList — flags to a list invocation", () => {
  const plan = (argv: string[]) => {
    const parsed = parseArgs(argv, COMMAND_TREE, flagSpecsFor);
    expect(parsed.errors).toEqual([]);
    return planList("people", parsed.flags);
  };

  it("defaults to a limit of 20", () => {
    expect(plan(["people", "list"]).limit).toBe(20);
  });

  it("threads the raw --filter into the built expression", () => {
    const p = plan(["people", "list", "--filter", 'city[eq]:"Enschede"']);
    expect(p.filter).toContain('city[eq]:"Enschede"');
    expect(p.filter).toContain("deletedAt[is]:NULL");
  });

  it("carries order-by and depth through untouched", () => {
    const p = plan(["people", "list", "--order-by", "createdAt[DescNullsFirst]", "--depth", "1"]);
    expect(p.orderBy).toBe("createdAt[DescNullsFirst]");
    expect(p.depth).toBe(1);
  });
});
