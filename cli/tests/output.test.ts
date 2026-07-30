import { describe, expect, it } from "bun:test";
import { csvEscape, pick, toCsv, toTable } from "../src/output.ts";
import { assignWaves, buildSegment, renderSegment, toSegmentMember } from "../src/commands/segments.ts";
import { parseCsv, planImport, renderImportPlan } from "../src/commands/importCsv.ts";
import type { TwentyRecord } from "@twenty-crm/core";

describe("csvEscape", () => {
  it("quotes a value containing a comma", () => {
    expect(csvEscape("Jansen, Jan")).toBe('"Jansen, Jan"');
  });
  it("doubles embedded quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
  it("quotes a value containing a newline", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
  it("neutralises a spreadsheet formula", () => {
    // A job title really can start with '=' and Excel really will run it.
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  it("renders null and undefined as empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("pick", () => {
  it("reads a dotted path", () => {
    expect(pick({ name: { firstName: "Beau" } }, "name.firstName")).toBe("Beau");
  });
  it("returns undefined instead of throwing on a missing branch", () => {
    expect(pick({ name: null }, "name.firstName")).toBeUndefined();
  });
});

describe("toCsv / toTable", () => {
  const rows = [{ id: "1", name: { firstName: "Beau" } }, { id: "2", name: { firstName: "Bas" } }];

  it("emits a header plus one line per row", () => {
    expect(toCsv(rows, ["id", "name.firstName"])).toBe("id,name.firstName\n1,Beau\n2,Bas");
  });

  it("says so when there is nothing to show", () => {
    expect(toTable([], ["id"])).toBe("(no records)");
  });

  it("puts a rule under the header", () => {
    expect(toTable(rows, ["id"]).split("\n")[1]).toMatch(/^-+$/);
  });
});

describe("segments", () => {
  const records = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    name: { firstName: `First${i}`, lastName: `Last${i}` },
    emails: { primaryEmail: `p${i}@example.nl` },
    jobTitle: "Advocaat",
    branche: "ADVOCATUUR",
  })) as unknown as TwentyRecord[];

  it("flattens a person record into a segment member", () => {
    const member = toSegmentMember(records[0]!);
    expect(member).toMatchObject({ id: "p0", firstName: "First0", email: "p0@example.nl", branche: "ADVOCATUUR" });
  });

  it("assigns 1-based waves and puts the remainder in the last wave", () => {
    const members = assignWaves(records.map(toSegmentMember), 3);
    expect(members.map((m) => m.wave)).toEqual([1, 1, 1, 2, 2, 2, 3]);
  });

  it("leaves members unwaved when no wave size is given", () => {
    expect(assignWaves(records.map(toSegmentMember), undefined).every((m) => m.wave === undefined)).toBe(true);
  });

  it("records the exact filter so the selection is reproducible", () => {
    const segment = buildSegment("twente", 'branche[eq]:"ADVOCATUUR"', records, 3);
    expect(segment.filter).toBe('branche[eq]:"ADVOCATUUR"');
    expect(segment.count).toBe(7);
    expect(segment.waves).toBe(3);
  });

  it("renders CSV with the wave column", () => {
    const csv = renderSegment(buildSegment("s", null, records, 3), "csv");
    expect(csv.split("\n")[0]).toBe("id,firstName,lastName,email,jobTitle,companyId,branche,segment,wave");
    expect(csv.split("\n")[1]).toContain(",1");
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with commas and embedded newlines", () => {
    const table = parseCsv('a,b\n"x,1","line1\nline2"\n');
    expect(table.headers).toEqual(["a", "b"]);
    expect(table.rows).toEqual([["x,1", "line1\nline2"]]);
  });

  it("handles doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""\n').rows).toEqual([['say "hi"']]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿email\nx@y.nl\n").headers).toEqual(["email"]);
  });

  it("ignores blank lines", () => {
    expect(parseCsv("a\n1\n\n2\n").rows).toEqual([["1"], ["2"]]);
  });
});

describe("planImport", () => {
  const table = parseCsv(
    "Voornaam,Achternaam,E-mail,Functie,Onbekend\n" +
      "Jan,Jansen,jan@example.nl,Advocaat,x\n" +
      "Piet,Pietersen,piet@example.nl,Notaris,y\n" +
      "Jan,Duplicaat,jan@example.nl,Advocaat,z\n" +
      "Geen,Mail,,Jurist,q\n",
  );

  it("maps Dutch and English headers onto real Twenty fields", () => {
    const plan = planImport(table, { object: "people", file: "leads.csv" });
    expect(plan.mapped).toContainEqual({ header: "Voornaam", field: "name.firstName" });
    expect(plan.mapped).toContainEqual({ header: "E-mail", field: "emails.primaryEmail" });
  });

  it("reports unmapped columns instead of dropping them silently", () => {
    const plan = planImport(table, { object: "people", file: "leads.csv" });
    expect(plan.unmapped).toEqual(["Onbekend"]);
    expect(plan.warnings.some((w) => w.includes("Unmapped columns"))).toBe(true);
  });

  it("counts rows with no match value separately", () => {
    expect(planImport(table, { object: "people", file: "x" }).rowsMissingMatchValue).toBe(1);
  });

  it("detects duplicates inside the CSV itself", () => {
    expect(planImport(table, { object: "people", file: "x" }).duplicateMatchValues).toEqual(["jan@example.nl"]);
  });

  it("splits create vs update when existing values are supplied", () => {
    const plan = planImport(table, {
      object: "people",
      file: "x",
      existingMatchValues: new Set(["jan@example.nl"]),
    });
    expect(plan.wouldUpdate).toBe(2); // both 'jan' rows match an existing record
    expect(plan.wouldCreate).toBe(1);
  });

  it("warns that the split is an upper bound without a CATO lookup", () => {
    const plan = planImport(table, { object: "people", file: "x" });
    expect(plan.wouldCreate).toBe(3);
    expect(plan.warnings.some((w) => w.includes("upper bound"))).toBe(true);
  });

  it("always renders as a dry run — there is no write path", () => {
    const text = renderImportPlan(planImport(table, { object: "people", file: "x" }), false);
    expect(text).toContain("DRY RUN — nothing was written to CATO");
    expect(text).toContain("This command has no write path");
  });
});
