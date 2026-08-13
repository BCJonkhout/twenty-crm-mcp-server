import { describe, expect, it } from "bun:test";
import {
  SEARCHABLE_FIELDS, UnsearchableObjectError, requireSearchExpr, searchExpr, searchExprForType,
} from "../src/filter.ts";

describe("searchExpr", () => {
  it("builds an ilike OR over every searchable field of the object", () => {
    expect(searchExpr("companies", "Teamgenoten")).toBe(
      'or(name[ilike]:"%Teamgenoten%",domainName.primaryLinkUrl[ilike]:"%Teamgenoten%")',
    );
  });

  it("drops the or() wrapper when the object has a single searchable field", () => {
    expect(searchExpr("notes", "escalatie")).toBe('title[ilike]:"%escalatie%"');
  });

  it("throws for an object with no verified searchable fields", () => {
    // The whole point: refusing is safe, silently ignoring the term is not —
    // that is what returned the full table and looked like a result set.
    expect(() => searchExprForType("workflows", "anything")).toThrow(UnsearchableObjectError);
    expect(() => searchExprForType("workflows", "anything")).toThrow(/not supported for 'workflows'/);
  });

  it("names the searchable objects in the error, so a caller can recover", () => {
    expect(() => searchExprForType("workflows", "x")).toThrow(/companies, notes, opportunities, people, tasks/);
  });

  it("covers the same person fields the CRM's own search does", () => {
    // Narrower than this and `cato people search "advocaat"` — a documented
    // workflow — silently returns nothing, because it matches on jobTitle.
    expect(SEARCHABLE_FIELDS.people).toContain("jobTitle");
    expect(SEARCHABLE_FIELDS.people).toContain("phones.primaryPhoneNumber");
    expect(searchExpr("people", "advocaat")).toContain('jobTitle[ilike]:"%advocaat%"');
  });

  it("treats a blank or whitespace-only term as no search at all", () => {
    expect(searchExpr("companies", "")).toBeNull();
    expect(searchExpr("companies", "   ")).toBeNull();
  });

  it("trims the term rather than searching for the spaces", () => {
    expect(searchExpr("notes", "  escalatie  ")).toBe('title[ilike]:"%escalatie%"');
  });

  it("escapes quotes so a term cannot break out of the filter expression", () => {
    const expr = searchExpr("notes", 'a"b');
    expect(expr).toBe('title[ilike]:"%a\\"b%"');
  });

  it("refuses a blank term at a search-only entry point", () => {
    // searchExpr returning null is fine when the term is one optional filter
    // among many, but a search command with a blank term would fall through to
    // an unfiltered list — the original bug in a different disguise.
    expect(() => requireSearchExpr("companies", "")).toThrow(/non-empty term/);
    expect(() => requireSearchExpr("companies", "   ")).toThrow(/non-empty term/);
    expect(requireSearchExpr("companies", "Acme")).toContain('name[ilike]:"%Acme%"');
  });

  it("still refuses an unsearchable object at a search-only entry point", () => {
    expect(() => requireSearchExpr("workflows", "x")).toThrow(UnsearchableObjectError);
  });

  it("keeps the field lists non-empty, so no object silently matches nothing", () => {
    for (const [object, fields] of Object.entries(SEARCHABLE_FIELDS)) {
      expect(fields.length, `${object} has no searchable fields`).toBeGreaterThan(0);
    }
  });
});
