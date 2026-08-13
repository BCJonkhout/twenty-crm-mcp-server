import { describe, expect, it } from "bun:test";
import { SEARCHABLE_FIELDS, UnsearchableObjectError, searchExpr } from "../src/filter.ts";

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
    expect(() => searchExpr("workflows", "anything")).toThrow(UnsearchableObjectError);
    expect(() => searchExpr("workflows", "anything")).toThrow(/not supported for 'workflows'/);
  });

  it("names the searchable objects in the error, so a caller can recover", () => {
    expect(() => searchExpr("workflows", "x")).toThrow(/companies, notes, opportunities, people, tasks/);
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

  it("keeps the field lists non-empty, so no object silently matches nothing", () => {
    for (const [object, fields] of Object.entries(SEARCHABLE_FIELDS)) {
      expect(fields.length, `${object} has no searchable fields`).toBeGreaterThan(0);
    }
  });
});
