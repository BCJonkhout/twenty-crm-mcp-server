/**
 * E2E integration tests for Twenty CRM MCP server.
 *
 * Requires TWENTY_API_KEY and TWENTY_BASE_URL env vars.
 * Runs via `bun test`.
 *
 * All test data is created and cleaned up within each test.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";

const API_KEY = process.env.TWENTY_API_KEY;
const BASE_URL = process.env.TWENTY_BASE_URL || "https://crm.prudai.com";

if (!API_KEY) {
  console.error("TWENTY_API_KEY is required. Set it in your environment.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api<T = any>(endpoint: string, method: string = "GET", data: unknown = null): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (data && method !== "GET") {
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function encFilter(expr: string): string {
  return encodeURIComponent(expr);
}

// ---------------------------------------------------------------------------
// Fixtures — shared person + company created once, cleaned up at the end
// ---------------------------------------------------------------------------

let testPersonId: string;
let testCompanyId: string;

beforeAll(async () => {
  const person = await api<{ data: { createPerson: { id: string } } }>("/rest/people", "POST", {
    name: { firstName: "MCPTest", lastName: "Suite" },
    emails: { primaryEmail: "mcp-test-suite@test.local" },
    city: "Enschede",
  });
  testPersonId = person.data.createPerson.id;

  const company = await api<{ data: { createCompany: { id: string } } }>("/rest/companies", "POST", {
    name: "MCP Test Suite Corp",
    domainName: {
      primaryLinkLabel: "mcp-test-suite.local",
      primaryLinkUrl: "https://mcp-test-suite.local",
      secondaryLinks: [],
    },
  });
  testCompanyId = company.data.createCompany.id;
});

afterAll(async () => {
  await api(`/rest/people/${testPersonId}`, "DELETE").catch(() => {});
  await api(`/rest/companies/${testCompanyId}`, "DELETE").catch(() => {});
});

// ---------------------------------------------------------------------------
// Person CRUD
// ---------------------------------------------------------------------------

describe("Person CRUD", () => {
  let personId: string;

  it("create_person with composite fields", async () => {
    const res = await api<any>("/rest/people", "POST", {
      name: { firstName: "Test", lastName: "PersonCRUD" },
      emails: { primaryEmail: "crud@test.local" },
      phones: { primaryPhoneNumber: "+31600000001" },
      city: "Amsterdam",
      jobTitle: "Tester",
    });
    personId = res.data.createPerson.id;
    expect(personId).toBeTruthy();
    expect(res.data.createPerson.name).toEqual({
      firstName: "Test",
      lastName: "PersonCRUD",
    });
  });

  it("get_person", async () => {
    const res = await api<any>(`/rest/people/${personId}`);
    expect(res.data).toBeTruthy();
  });

  it("update_person with composite name", async () => {
    const res = await api<any>(`/rest/people/${personId}`, "PUT", {
      name: { firstName: "Updated", lastName: "PersonCRUD" },
    });
    expect(res.data.updatePerson.name.firstName).toBe("Updated");
  });

  it("list_people", async () => {
    const res = await api<any>("/rest/people?limit=2");
    expect(Array.isArray(res.data.people)).toBe(true);
  });

  it("delete_person", async () => {
    const res = await api<any>(`/rest/people/${personId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Company CRUD
// ---------------------------------------------------------------------------

describe("Company CRUD", () => {
  let companyId: string;

  it("create_company with composite fields", async () => {
    const res = await api<any>("/rest/companies", "POST", {
      name: "TestCorp CRUD",
      domainName: {
        primaryLinkLabel: "testcorp-crud.local",
        primaryLinkUrl: "https://testcorp-crud.local",
        secondaryLinks: [],
      },
      address: {
        addressStreet1: "Teststraat 1",
        addressStreet2: "",
        addressCity: "Enschede",
        addressPostcode: "7500AA",
        addressState: "",
        addressCountry: "NL",
        addressLat: null,
        addressLng: null,
      },
    });
    companyId = res.data.createCompany.id;
    expect(companyId).toBeTruthy();
    expect(res.data.createCompany.name).toBe("TestCorp CRUD");
  });

  it("update_company", async () => {
    const res = await api<any>(`/rest/companies/${companyId}`, "PUT", {
      name: "TestCorp CRUD Updated",
    });
    expect(res.data.updateCompany.name).toBe("TestCorp CRUD Updated");
  });

  it("list_companies", async () => {
    const res = await api<any>("/rest/companies?limit=2");
    expect(Array.isArray(res.data.companies)).toBe(true);
  });

  it("delete_company", async () => {
    const res = await api<any>(`/rest/companies/${companyId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Note CRUD + bodyV2 format
// ---------------------------------------------------------------------------

describe("Note CRUD with bodyV2", () => {
  let noteId: string;

  it("create_note with RICH_TEXT_V2 bodyV2", async () => {
    const res = await api<any>("/rest/notes", "POST", {
      title: "Test Note CRUD",
      bodyV2: {
        blocknote:
          '[{"id":"b1","type":"paragraph","props":{"textColor":"default","backgroundColor":"default","textAlignment":"left"},"content":[{"type":"text","text":"Hello from tests.","styles":{}}],"children":[]}]',
        markdown: "Hello from tests.",
      },
    });
    noteId = res.data.createNote.id;
    expect(noteId).toBeTruthy();
    expect(res.data.createNote.title).toBe("Test Note CRUD");
  });

  it("update_note bodyV2", async () => {
    const res = await api<any>(`/rest/notes/${noteId}`, "PUT", {
      title: "Test Note CRUD Updated",
      bodyV2: {
        blocknote:
          '[{"id":"b1","type":"paragraph","props":{"textColor":"default","backgroundColor":"default","textAlignment":"left"},"content":[{"type":"text","text":"Updated.","styles":{}}],"children":[]}]',
        markdown: "Updated.",
      },
    });
    expect(res.data.updateNote.title).toBe("Test Note CRUD Updated");
  });

  it("list_notes", async () => {
    const res = await api<any>("/rest/notes?limit=2");
    expect(Array.isArray(res.data.notes)).toBe(true);
  });

  it("delete_note", async () => {
    const res = await api<any>(`/rest/notes/${noteId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task CRUD + bodyV2 + status transitions
// ---------------------------------------------------------------------------

describe("Task CRUD with bodyV2 and status", () => {
  let taskId: string;

  it("create_task", async () => {
    const res = await api<any>("/rest/tasks", "POST", {
      title: "Test Task CRUD",
      status: "TODO",
      bodyV2: {
        blocknote: "[]",
        markdown: "Task body.",
      },
    });
    taskId = res.data.createTask.id;
    expect(taskId).toBeTruthy();
    expect(res.data.createTask.status).toBe("TODO");
  });

  it("update_task status TODO → IN_PROGRESS", async () => {
    const res = await api<any>(`/rest/tasks/${taskId}`, "PUT", {
      status: "IN_PROGRESS",
    });
    expect(res.data.updateTask.status).toBe("IN_PROGRESS");
  });

  it("update_task status IN_PROGRESS → DONE", async () => {
    const res = await api<any>(`/rest/tasks/${taskId}`, "PUT", {
      status: "DONE",
    });
    expect(res.data.updateTask.status).toBe("DONE");
  });

  it("list_tasks", async () => {
    const res = await api<any>("/rest/tasks?limit=2");
    expect(Array.isArray(res.data.tasks)).toBe(true);
  });

  it("delete_task", async () => {
    const res = await api<any>(`/rest/tasks/${taskId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NoteTarget CRUD + auto-link + list_notes_for_person
// ---------------------------------------------------------------------------

describe("NoteTarget lifecycle", () => {
  let noteId: string;
  let ntPersonId: string;
  let ntCompanyId: string;

  it("create_note for target tests", async () => {
    const res = await api<any>("/rest/notes", "POST", {
      title: "Note for targeting",
      bodyV2: { blocknote: "[]", markdown: "target test" },
    });
    noteId = res.data.createNote.id;
    expect(noteId).toBeTruthy();
  });

  it("create_note_target for person", async () => {
    const res = await api<any>("/rest/noteTargets", "POST", {
      noteId,
      targetPersonId: testPersonId,
    });
    ntPersonId = res.data.createNoteTarget.id;
    expect(ntPersonId).toBeTruthy();
    expect(res.data.createNoteTarget.noteId).toBe(noteId);
    expect(res.data.createNoteTarget.targetPersonId).toBe(testPersonId);
  });

  it("create_note_target for company", async () => {
    const res = await api<any>("/rest/noteTargets", "POST", {
      noteId,
      targetCompanyId: testCompanyId,
    });
    ntCompanyId = res.data.createNoteTarget.id;
    expect(ntCompanyId).toBeTruthy();
    expect(res.data.createNoteTarget.targetCompanyId).toBe(testCompanyId);
  });

  it("list_note_targets by noteId", async () => {
    const filter = encFilter(`noteId[eq]:${noteId}`);
    const res = await api<any>(`/rest/noteTargets?filter=${filter}&limit=10`);
    const targets = res.data.noteTargets as Array<any>;
    expect(targets.length).toBe(2);
    const personTarget = targets.find((t) => t.targetPersonId === testPersonId);
    const companyTarget = targets.find((t) => t.targetCompanyId === testCompanyId);
    expect(personTarget).toBeTruthy();
    expect(companyTarget).toBeTruthy();
  });

  it("list_notes_for_person via noteTarget filter", async () => {
    const filter = encFilter(`targetPersonId[eq]:${testPersonId}`);
    const res = await api<any>(`/rest/noteTargets?filter=${filter}&limit=50`);
    const targets = res.data.noteTargets as Array<any>;
    expect(targets.length >= 1).toBe(true);
    const match = targets.find((t) => t.noteId === noteId);
    expect(match).toBeTruthy();
  });

  it("delete_note_target (person)", async () => {
    const res = await api<any>(`/rest/noteTargets/${ntPersonId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });

  it("delete_note_target (company)", async () => {
    const res = await api<any>(`/rest/noteTargets/${ntCompanyId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });

  it("cleanup: delete_note", async () => {
    await api(`/rest/notes/${noteId}`, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// TaskTarget CRUD + list_tasks_for_person
// ---------------------------------------------------------------------------

describe("TaskTarget lifecycle", () => {
  let taskId: string;
  let ttId: string;

  it("create_task for target tests", async () => {
    const res = await api<any>("/rest/tasks", "POST", {
      title: "Task for targeting",
      status: "TODO",
      bodyV2: { blocknote: "[]", markdown: "task target test" },
    });
    taskId = res.data.createTask.id;
    expect(taskId).toBeTruthy();
  });

  it("create_task_target for person", async () => {
    const res = await api<any>("/rest/taskTargets", "POST", {
      taskId,
      targetPersonId: testPersonId,
    });
    ttId = res.data.createTaskTarget.id;
    expect(ttId).toBeTruthy();
    expect(res.data.createTaskTarget.taskId).toBe(taskId);
  });

  it("list_task_targets by taskId", async () => {
    const filter = encFilter(`taskId[eq]:${taskId}`);
    const res = await api<any>(`/rest/taskTargets?filter=${filter}&limit=10`);
    expect(res.data.taskTargets.length).toBe(1);
    expect(res.data.taskTargets[0].targetPersonId).toBe(testPersonId);
  });

  it("list_tasks_for_person via taskTarget filter", async () => {
    const filter = encFilter(`targetPersonId[eq]:${testPersonId}`);
    const res = await api<any>(`/rest/taskTargets?filter=${filter}&limit=50`);
    const match = (res.data.taskTargets as Array<any>).find((t) => t.taskId === taskId);
    expect(match).toBeTruthy();
  });

  it("delete_task_target", async () => {
    const res = await api<any>(`/rest/taskTargets/${ttId}`, "DELETE");
    expect(res.data).toBeTruthy();
  });

  it("cleanup: delete_task", async () => {
    await api(`/rest/tasks/${taskId}`, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// Metadata — name resolution
// ---------------------------------------------------------------------------

describe("Metadata name resolution", () => {
  let allObjects: Array<{ id: string; nameSingular: string }>;

  it("get_metadata_objects", async () => {
    const res = await api<any>("/rest/metadata/objects");
    allObjects = res.data.objects;
    expect(Array.isArray(allObjects)).toBe(true);
    expect(allObjects.length > 0).toBe(true);
  });

  it("resolve noteTarget by nameSingular", async () => {
    const nt = allObjects.find((o) => o.nameSingular === "noteTarget");
    expect(nt).toBeTruthy();
    const res = await api<any>(`/rest/metadata/objects/${nt!.id}`);
    expect(res.data).toBeTruthy();
  });

  it("resolve taskTarget by nameSingular", async () => {
    const tt = allObjects.find((o) => o.nameSingular === "taskTarget");
    expect(tt).toBeTruthy();
  });

  it("resolve person by nameSingular", async () => {
    const p = allObjects.find((o) => o.nameSingular === "person");
    expect(p).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("Search", () => {
  it("search_records returns results", async () => {
    const res = await api<any>("/rest/people?search=MCPTest&limit=5");
    expect(Array.isArray(res.data.people)).toBe(true);
    expect(res.data.people.length >= 1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for the helper modules
// ---------------------------------------------------------------------------

import { buildListQuery } from "./src/rest.ts";
import { escapeFilterValue, andExpr, orExpr, combineWithSoftDelete, clause } from "./src/filter.ts";
import { buildWrappedSql } from "./src/psql.ts";
import { transformPersonData, transformCompanyData, transformBodyField } from "./src/transforms.ts";

describe("filter.ts", () => {
  it("escapeFilterValue handles strings, numbers, arrays, null", () => {
    expect(escapeFilterValue("Enschede")).toBe('"Enschede"');
    expect(escapeFilterValue(42)).toBe("42");
    expect(escapeFilterValue(true)).toBe("true");
    expect(escapeFilterValue(null)).toBe("NULL");
    expect(escapeFilterValue(["a", "b"])).toBe('["a","b"]');
    expect(escapeFilterValue('with "quote"')).toBe('"with \\"quote\\""');
  });

  it("clause builds field[op]:value", () => {
    expect(clause("jobTitle", "like", "%architect%")).toBe('jobTitle[like]:"%architect%"');
    expect(clause("address.addressCity", "in", ["Enschede", "Hengelo"])).toBe('address.addressCity[in]:["Enschede","Hengelo"]');
  });

  it("andExpr / orExpr compose", () => {
    expect(andExpr("a[eq]:1")).toBe("a[eq]:1");
    expect(andExpr("a[eq]:1", "b[eq]:2")).toBe("and(a[eq]:1,b[eq]:2)");
    expect(orExpr("a[eq]:1", "b[eq]:2", "c[eq]:3")).toBe("or(a[eq]:1,b[eq]:2,c[eq]:3)");
    expect(andExpr()).toBeNull();
  });

  it("combineWithSoftDelete appends deletedAt guard", () => {
    expect(combineWithSoftDelete(null, false)).toBe("deletedAt[is]:NULL");
    expect(combineWithSoftDelete("a[eq]:1", false)).toBe("and(a[eq]:1,deletedAt[is]:NULL)");
    expect(combineWithSoftDelete("a[eq]:1", true)).toBe("a[eq]:1");
  });
});

describe("rest.ts buildListQuery", () => {
  it("omits unset params", () => {
    expect(buildListQuery({})).toBe("");
  });
  it("encodes filter, limit, cursor, order_by (brackets encoded, parens kept)", () => {
    const qs = buildListQuery({
      filter: 'and(a[eq]:"x",b[in]:[1,2])',
      limit: 50,
      after: "CURSOR",
      order_by: "createdAt[DescNullsFirst]",
    });
    expect(qs).toMatch(/^\?/);
    expect(qs).toMatch(/filter=and\(a%5Beq%5D%3A%22x%22%2Cb%5Bin%5D%3A%5B1%2C2%5D\)/);
    expect(qs).toMatch(/limit=50/);
    expect(qs).toMatch(/starting_after=CURSOR/);
    expect(qs).toMatch(/order_by=createdAt%5BDescNullsFirst%5D/);
  });
  it("passes soft-delete guard through when provided by caller", () => {
    const qs = buildListQuery({ filter: "deletedAt[is]:NULL" });
    expect(qs).toMatch(/deletedAt%5Bis%5D%3ANULL/);
  });
});

describe("psql.ts safety guard", () => {
  it("wraps sql with read-only settings", () => {
    const out = buildWrappedSql("SELECT 1", "ws_x");
    expect(out).toMatch(/default_transaction_read_only = on/);
    expect(out).toMatch(/statement_timeout = '30s'/);
    expect(out).toMatch(/search_path TO "ws_x"/);
    expect(out).toMatch(/SELECT 1;/);
  });

  it("assertReadonly rejects writes via runReadonlySql", async () => {
    const { runReadonlySql } = await import("./src/psql.ts");
    expect(runReadonlySql("DELETE FROM person")).rejects.toThrow(/must start with SELECT/);
    expect(runReadonlySql("INSERT INTO person VALUES (1)")).rejects.toThrow(/must start with SELECT/);
    expect(runReadonlySql("SELECT 1; DROP TABLE x")).rejects.toThrow(/forbidden keyword/);
    expect(runReadonlySql("SELECT 1; SELECT 2")).rejects.toThrow(/Multiple statements/);
    expect(runReadonlySql("")).rejects.toThrow(/SQL is empty/);
  });
});

describe("transforms.ts", () => {
  it("transformPersonData maps flat → composite", () => {
    const t = transformPersonData({ firstName: "A", lastName: "B", email: "a@b.c", phone: "0612345678", linkedinUrl: "https://li.example" });
    expect(t.name).toEqual({ firstName: "A", lastName: "B" });
    expect(t.emails).toEqual({ primaryEmail: "a@b.c" });
    expect(t.phones).toEqual({ primaryPhoneNumber: "0612345678" });
    expect(t.firstName).toBeUndefined();
    expect(t.email).toBeUndefined();
  });

  it("transformCompanyData wraps domainName string", () => {
    const t = transformCompanyData({ name: "X", domainName: "example.nl" });
    expect((t.domainName as any).primaryLinkUrl).toBe("https://example.nl");
  });

  it("transformBodyField builds bodyV2 with blocknote + markdown", () => {
    const t = transformBodyField({ body: "Line 1\nLine 2" });
    expect((t.bodyV2 as any).blocknote).toBeTruthy();
    const blocks = JSON.parse((t.bodyV2 as any).blocknote);
    expect(blocks.length).toBe(2);
    expect(blocks[0].content[0].text).toBe("Line 1");
    expect((t.bodyV2 as any).markdown).toBe("Line 1\nLine 2");
  });
});
