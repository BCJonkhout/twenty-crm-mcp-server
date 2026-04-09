#!/usr/bin/env node

/**
 * E2E integration tests for Twenty CRM MCP server.
 *
 * Requires TWENTY_API_KEY and TWENTY_BASE_URL env vars.
 * Uses Node built-in test runner (node --test).
 *
 * All test data is created and cleaned up within each test.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const API_KEY = process.env.TWENTY_API_KEY;
const BASE_URL = process.env.TWENTY_BASE_URL || "https://crm.prudai.com";

if (!API_KEY) {
  console.error("TWENTY_API_KEY is required. Set it in your environment.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api(endpoint, method = "GET", data = null) {
  const url = `${BASE_URL}${endpoint}`;
  const opts = {
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
  return res.json();
}

function encFilter(expr) {
  return encodeURIComponent(expr);
}

// ---------------------------------------------------------------------------
// Fixtures — shared person + company created once, cleaned up at the end
// ---------------------------------------------------------------------------

let testPersonId;
let testCompanyId;

before(async () => {
  const person = await api("/rest/people", "POST", {
    name: { firstName: "MCPTest", lastName: "Suite" },
    emails: { primaryEmail: "mcp-test-suite@test.local" },
    city: "Enschede",
  });
  testPersonId = person.data.createPerson.id;

  const company = await api("/rest/companies", "POST", {
    name: "MCP Test Suite Corp",
    domainName: {
      primaryLinkLabel: "mcp-test-suite.local",
      primaryLinkUrl: "https://mcp-test-suite.local",
      secondaryLinks: [],
    },
  });
  testCompanyId = company.data.createCompany.id;
});

after(async () => {
  await api(`/rest/people/${testPersonId}`, "DELETE").catch(() => {});
  await api(`/rest/companies/${testCompanyId}`, "DELETE").catch(() => {});
});

// ---------------------------------------------------------------------------
// Person CRUD
// ---------------------------------------------------------------------------

describe("Person CRUD", () => {
  let personId;

  it("create_person with composite fields", async () => {
    const res = await api("/rest/people", "POST", {
      name: { firstName: "Test", lastName: "PersonCRUD" },
      emails: { primaryEmail: "crud@test.local" },
      phones: { primaryPhoneNumber: "+31600000001" },
      city: "Amsterdam",
      jobTitle: "Tester",
    });
    personId = res.data.createPerson.id;
    assert.ok(personId, "Person ID should be returned");
    assert.deepStrictEqual(res.data.createPerson.name, {
      firstName: "Test",
      lastName: "PersonCRUD",
    });
  });

  it("get_person", async () => {
    const res = await api(`/rest/people/${personId}`);
    assert.ok(res.data, "Should return person data");
  });

  it("update_person with composite name", async () => {
    const res = await api(`/rest/people/${personId}`, "PUT", {
      name: { firstName: "Updated", lastName: "PersonCRUD" },
    });
    assert.equal(res.data.updatePerson.name.firstName, "Updated");
  });

  it("list_people", async () => {
    const res = await api("/rest/people?limit=2");
    assert.ok(Array.isArray(res.data.people), "Should return array");
  });

  it("delete_person", async () => {
    const res = await api(`/rest/people/${personId}`, "DELETE");
    assert.ok(res.data, "Should confirm deletion");
  });
});

// ---------------------------------------------------------------------------
// Company CRUD
// ---------------------------------------------------------------------------

describe("Company CRUD", () => {
  let companyId;

  it("create_company with composite fields", async () => {
    const res = await api("/rest/companies", "POST", {
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
    assert.ok(companyId);
    assert.equal(res.data.createCompany.name, "TestCorp CRUD");
  });

  it("update_company", async () => {
    const res = await api(`/rest/companies/${companyId}`, "PUT", {
      name: "TestCorp CRUD Updated",
    });
    assert.equal(res.data.updateCompany.name, "TestCorp CRUD Updated");
  });

  it("list_companies", async () => {
    const res = await api("/rest/companies?limit=2");
    assert.ok(Array.isArray(res.data.companies));
  });

  it("delete_company", async () => {
    const res = await api(`/rest/companies/${companyId}`, "DELETE");
    assert.ok(res.data);
  });
});

// ---------------------------------------------------------------------------
// Note CRUD + bodyV2 format
// ---------------------------------------------------------------------------

describe("Note CRUD with bodyV2", () => {
  let noteId;

  it("create_note with RICH_TEXT_V2 bodyV2", async () => {
    const res = await api("/rest/notes", "POST", {
      title: "Test Note CRUD",
      bodyV2: {
        blocknote:
          '[{"id":"b1","type":"paragraph","props":{"textColor":"default","backgroundColor":"default","textAlignment":"left"},"content":[{"type":"text","text":"Hello from tests.","styles":{}}],"children":[]}]',
        markdown: "Hello from tests.",
      },
    });
    noteId = res.data.createNote.id;
    assert.ok(noteId);
    assert.equal(res.data.createNote.title, "Test Note CRUD");
  });

  it("update_note bodyV2", async () => {
    const res = await api(`/rest/notes/${noteId}`, "PUT", {
      title: "Test Note CRUD Updated",
      bodyV2: {
        blocknote:
          '[{"id":"b1","type":"paragraph","props":{"textColor":"default","backgroundColor":"default","textAlignment":"left"},"content":[{"type":"text","text":"Updated.","styles":{}}],"children":[]}]',
        markdown: "Updated.",
      },
    });
    assert.equal(res.data.updateNote.title, "Test Note CRUD Updated");
  });

  it("list_notes", async () => {
    const res = await api("/rest/notes?limit=2");
    assert.ok(Array.isArray(res.data.notes));
  });

  it("delete_note", async () => {
    const res = await api(`/rest/notes/${noteId}`, "DELETE");
    assert.ok(res.data);
  });
});

// ---------------------------------------------------------------------------
// Task CRUD + bodyV2 + status transitions
// ---------------------------------------------------------------------------

describe("Task CRUD with bodyV2 and status", () => {
  let taskId;

  it("create_task", async () => {
    const res = await api("/rest/tasks", "POST", {
      title: "Test Task CRUD",
      status: "TODO",
      bodyV2: {
        blocknote: "[]",
        markdown: "Task body.",
      },
    });
    taskId = res.data.createTask.id;
    assert.ok(taskId);
    assert.equal(res.data.createTask.status, "TODO");
  });

  it("update_task status TODO → IN_PROGRESS", async () => {
    const res = await api(`/rest/tasks/${taskId}`, "PUT", {
      status: "IN_PROGRESS",
    });
    assert.equal(res.data.updateTask.status, "IN_PROGRESS");
  });

  it("update_task status IN_PROGRESS → DONE", async () => {
    const res = await api(`/rest/tasks/${taskId}`, "PUT", {
      status: "DONE",
    });
    assert.equal(res.data.updateTask.status, "DONE");
  });

  it("list_tasks", async () => {
    const res = await api("/rest/tasks?limit=2");
    assert.ok(Array.isArray(res.data.tasks));
  });

  it("delete_task", async () => {
    const res = await api(`/rest/tasks/${taskId}`, "DELETE");
    assert.ok(res.data);
  });
});

// ---------------------------------------------------------------------------
// NoteTarget CRUD + auto-link + list_notes_for_person
// ---------------------------------------------------------------------------

describe("NoteTarget lifecycle", () => {
  let noteId;
  let ntPersonId;
  let ntCompanyId;

  it("create_note for target tests", async () => {
    const res = await api("/rest/notes", "POST", {
      title: "Note for targeting",
      bodyV2: { blocknote: "[]", markdown: "target test" },
    });
    noteId = res.data.createNote.id;
    assert.ok(noteId);
  });

  it("create_note_target for person", async () => {
    const res = await api("/rest/noteTargets", "POST", {
      noteId,
      targetPersonId: testPersonId,
    });
    ntPersonId = res.data.createNoteTarget.id;
    assert.ok(ntPersonId);
    assert.equal(res.data.createNoteTarget.noteId, noteId);
    assert.equal(res.data.createNoteTarget.targetPersonId, testPersonId);
  });

  it("create_note_target for company", async () => {
    const res = await api("/rest/noteTargets", "POST", {
      noteId,
      targetCompanyId: testCompanyId,
    });
    ntCompanyId = res.data.createNoteTarget.id;
    assert.ok(ntCompanyId);
    assert.equal(res.data.createNoteTarget.targetCompanyId, testCompanyId);
  });

  it("list_note_targets by noteId", async () => {
    const filter = encFilter(`noteId[eq]:${noteId}`);
    const res = await api(`/rest/noteTargets?filter=${filter}&limit=10`);
    const targets = res.data.noteTargets;
    assert.equal(targets.length, 2, "Should have 2 targets (person + company)");
    const personTarget = targets.find((t) => t.targetPersonId === testPersonId);
    const companyTarget = targets.find(
      (t) => t.targetCompanyId === testCompanyId
    );
    assert.ok(personTarget, "Person target should exist");
    assert.ok(companyTarget, "Company target should exist");
  });

  it("list_notes_for_person via noteTarget filter", async () => {
    const filter = encFilter(`targetPersonId[eq]:${testPersonId}`);
    const res = await api(`/rest/noteTargets?filter=${filter}&limit=50`);
    const targets = res.data.noteTargets;
    assert.ok(targets.length >= 1, "Should find at least 1 noteTarget");
    const match = targets.find((t) => t.noteId === noteId);
    assert.ok(match, "Should find our test note in person's noteTargets");
  });

  it("delete_note_target (person)", async () => {
    const res = await api(`/rest/noteTargets/${ntPersonId}`, "DELETE");
    assert.ok(res.data);
  });

  it("delete_note_target (company)", async () => {
    const res = await api(`/rest/noteTargets/${ntCompanyId}`, "DELETE");
    assert.ok(res.data);
  });

  it("cleanup: delete_note", async () => {
    await api(`/rest/notes/${noteId}`, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// TaskTarget CRUD + list_tasks_for_person
// ---------------------------------------------------------------------------

describe("TaskTarget lifecycle", () => {
  let taskId;
  let ttId;

  it("create_task for target tests", async () => {
    const res = await api("/rest/tasks", "POST", {
      title: "Task for targeting",
      status: "TODO",
      bodyV2: { blocknote: "[]", markdown: "task target test" },
    });
    taskId = res.data.createTask.id;
    assert.ok(taskId);
  });

  it("create_task_target for person", async () => {
    const res = await api("/rest/taskTargets", "POST", {
      taskId,
      targetPersonId: testPersonId,
    });
    ttId = res.data.createTaskTarget.id;
    assert.ok(ttId);
    assert.equal(res.data.createTaskTarget.taskId, taskId);
  });

  it("list_task_targets by taskId", async () => {
    const filter = encFilter(`taskId[eq]:${taskId}`);
    const res = await api(`/rest/taskTargets?filter=${filter}&limit=10`);
    assert.equal(res.data.taskTargets.length, 1);
    assert.equal(res.data.taskTargets[0].targetPersonId, testPersonId);
  });

  it("list_tasks_for_person via taskTarget filter", async () => {
    const filter = encFilter(`targetPersonId[eq]:${testPersonId}`);
    const res = await api(`/rest/taskTargets?filter=${filter}&limit=50`);
    const match = res.data.taskTargets.find((t) => t.taskId === taskId);
    assert.ok(match, "Should find test task in person's taskTargets");
  });

  it("delete_task_target", async () => {
    const res = await api(`/rest/taskTargets/${ttId}`, "DELETE");
    assert.ok(res.data);
  });

  it("cleanup: delete_task", async () => {
    await api(`/rest/tasks/${taskId}`, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// Metadata — name resolution
// ---------------------------------------------------------------------------

describe("Metadata name resolution", () => {
  let allObjects;

  it("get_metadata_objects", async () => {
    const res = await api("/rest/metadata/objects");
    allObjects = res.data.objects;
    assert.ok(Array.isArray(allObjects), "Should return objects array");
    assert.ok(allObjects.length > 0, "Should have at least one object type");
  });

  it("resolve noteTarget by nameSingular", async () => {
    const nt = allObjects.find((o) => o.nameSingular === "noteTarget");
    assert.ok(nt, "noteTarget should exist in metadata");
    // Fetch by UUID to confirm resolution works
    const res = await api(`/rest/metadata/objects/${nt.id}`);
    assert.ok(res.data, "Should return metadata for noteTarget");
  });

  it("resolve taskTarget by nameSingular", async () => {
    const tt = allObjects.find((o) => o.nameSingular === "taskTarget");
    assert.ok(tt, "taskTarget should exist in metadata");
  });

  it("resolve person by nameSingular", async () => {
    const p = allObjects.find((o) => o.nameSingular === "person");
    assert.ok(p, "person should exist in metadata");
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("Search", () => {
  it("search_records returns results", async () => {
    const res = await api("/rest/people?search=MCPTest&limit=5");
    assert.ok(Array.isArray(res.data.people));
    assert.ok(
      res.data.people.length >= 1,
      "Should find at least the test person"
    );
  });
});
