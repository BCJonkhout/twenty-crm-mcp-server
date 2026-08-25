import { describe, expect, it } from "bun:test";
import { buildTaskFilter, FilterError, isKnownTaskStatus, normaliseTaskStatus } from "../src/filters.ts";
import { planList } from "../src/commands/records.ts";
import { parseArgs, resolveWriteGate } from "../src/args.ts";
import { COMMAND_TREE, flagSpecsFor } from "../src/commands.ts";
import {
  buildTaskBody, buildTaskUpdateBody, createTaskWithTargets, describeTaskTargets,
  parseFieldAssignments, RecordWriteError, renderWriteDryRun, renderWriteSuccess,
} from "../src/commands/recordWrite.ts";
import {
  enrichTasks, fetchTargetsForTasks, fetchTasks, formatDue, listWorkspaceMembers, parseDueAt,
  renderTaskDetail, renderTaskList, resolveMember, statusHint, TaskError, taskIdsForTarget,
  type WorkspaceMember,
} from "../src/commands/tasks.ts";
import { toTable } from "../src/output.ts";

const BASE = "https://crm.prudai.com";
const NOW = new Date("2026-08-24T12:00:00.000Z");

/**
 * Routes requests by endpoint substring, in order of declaration, and records
 * every call — enough to prove which filter went to the CRM and what came back.
 */
function routedClient(routes: Array<[string, unknown]>, fallback: unknown = { data: {} }) {
  const calls: Array<{ endpoint: string; method: string; body: unknown }> = [];
  const client = {
    request: async (endpoint: string, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ endpoint, method: opts.method ?? "GET", body: opts.body ?? null });
      const hit = routes.find(([needle]) => decodeURIComponent(endpoint).includes(needle));
      const value = hit ? hit[1] : fallback;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { client: client as never, calls, decoded: () => calls.map((c) => decodeURIComponent(c.endpoint)) };
}

const MEMBERS: WorkspaceMember[] = [
  { id: "356e0364-5f38-4288-bfd9-20e6166c676d", firstName: "Beau", lastName: "Jonkhout", email: "jonkhout@prudai.com" },
  { id: "dcceb2d7-2c76-4ca6-a06e-4e809ea9bdc9", firstName: "Geert", lastName: "Haisma", email: "haisma@prudai.com" },
  { id: "5f67ccd4-7501-48c2-8458-864a238bae29", firstName: "Bas", lastName: "Bönhke", email: "bonhke@prudai.com" },
  { id: "b89fc8f9-526c-48d1-9ac1-89ef91e442b3", firstName: "Bas", lastName: "van de Weerd", email: "van.de.weerd@prudai.com" },
];

// ---- status -----------------------------------------------------------------

describe("task status", () => {
  it("normalises the spellings people actually type", () => {
    expect(normaliseTaskStatus("in progress")).toBe("IN_PROGRESS");
    expect(normaliseTaskStatus("in-progress")).toBe("IN_PROGRESS");
    expect(normaliseTaskStatus(" done ")).toBe("DONE");
    expect(normaliseTaskStatus("On_Hold")).toBe("ON_HOLD");
  });

  // The stage enum refuses unknown values; the status enum deliberately does
  // not, so a status added in CATO's UI works without a CLI release. The CRM
  // still answers HTTP 400 on a typo — verified live on 2026-08-24.
  it("passes an unknown status through and only hints", () => {
    expect(isKnownTaskStatus("todo")).toBe(true);
    expect(isKnownTaskStatus("HIGH_PRIORITY")).toBe(false);
    expect(buildTaskBody({ title: "t", status: "high priority" })).toMatchObject({ status: "HIGH_PRIORITY" });
    expect(statusHint("high priority")).toContain("HIGH_PRIORITY");
    expect(statusHint("done")).toBeNull();
    expect(statusHint(undefined)).toBeNull();
  });
});

// ---- filters ----------------------------------------------------------------

describe("buildTaskFilter", () => {
  it("always adds the soft-delete guard", () => {
    expect(buildTaskFilter({})).toBe("deletedAt[is]:NULL");
  });

  it("filters on status, assignee and title search", () => {
    const f = buildTaskFilter({ status: "todo", assigneeId: "wm-1", search: "bel" })!;
    expect(f).toContain('status[eq]:"TODO"');
    expect(f).toContain('assigneeId[eq]:"wm-1"');
    expect(f).toContain('title[ilike]:"%bel%"');
  });

  // A card that is due "before 4 September" is still due on the 4th itself.
  it("treats --due-before <day> as inclusive of that day", () => {
    // Amsterdam midnight, i.e. the moment the 5th starts here — not 00:00Z.
    expect(buildTaskFilter({ dueBefore: "2026-09-04" })!).toContain('dueAt[lt]:"2026-09-04T22:00:00.000Z"');
    expect(buildTaskFilter({ dueAfter: "2026-09-01" })!).toContain('dueAt[gte]:"2026-08-31T22:00:00.000Z"');
    // A timestamp is taken literally, zone and all.
    expect(buildTaskFilter({ dueBefore: "2026-09-04T10:00:00.000Z" })!).toContain('dueAt[lt]:"2026-09-04T10:00:00.000Z"');
  });

  /**
   * The contract, not the literals: a task written with `--due D` has to fall
   * inside every window that says it should. The two sides used to disagree —
   * `--due` anchored the day in Europe/Amsterdam, the filter bounds in UTC — so
   * `--due-after D` silently skipped the cards written with `--due D`. Asserting
   * the boundary strings alone could not see that, because both sides were
   * internally consistent; only comparing them catches it.
   */
  it("builds windows that actually contain the tasks --due writes", () => {
    const bound = (f: string | null, op: string) =>
      new Date(new RegExp(`dueAt\\[${op}\\]:"([^"]+)"`).exec(f ?? "")![1]!).getTime();

    for (const day of ["2026-09-04", "2026-01-15", "2026-03-29", "2026-10-25"]) {
      const due = new Date(parseDueAt(day)).getTime();
      const [y, m, d] = day.split("-").map(Number);
      const nextDay = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
      const prevDay = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);

      // due on D is inside [D, …] and inside […, D], and outside both neighbours.
      expect(due).toBeGreaterThanOrEqual(bound(buildTaskFilter({ dueAfter: day }), "gte"));
      expect(due).toBeLessThan(bound(buildTaskFilter({ dueBefore: day }), "lt"));
      expect(due).toBeLessThan(bound(buildTaskFilter({ dueAfter: nextDay }), "gte"));
      expect(due).toBeGreaterThanOrEqual(bound(buildTaskFilter({ dueBefore: prevDay }), "lt"));
    }

    // A time on the last day of the window still counts as inside it.
    const late = new Date(parseDueAt("2026-09-04T23:30")).getTime();
    expect(late).toBeLessThan(bound(buildTaskFilter({ dueBefore: "2026-09-04" }), "lt"));
  });

  // Two tasks on the live board have no status at all; a bare status[neq]:DONE
  // would hide them from --overdue although they are exactly the cards it is for.
  it("--overdue means past due and not DONE, with a NULL status counting as open", () => {
    const f = buildTaskFilter({ overdue: true, now: NOW })!;
    expect(f).toContain('dueAt[lt]:"2026-08-24T12:00:00.000Z"');
    expect(f).toContain('or(status[is]:NULL,status[neq]:"DONE")');
  });

  it("refuses --overdue together with --status DONE instead of returning nothing", () => {
    expect(() => buildTaskFilter({ overdue: true, status: "done" })).toThrow(FilterError);
  });

  it("rejects a malformed date loudly", () => {
    expect(() => buildTaskFilter({ dueBefore: "04-09-2026" })).toThrow(FilterError);
    expect(() => buildTaskFilter({ dueAfter: "gisteren" })).toThrow(FilterError);
  });
});

describe("planList for tasks", () => {
  it("wires the list flags through to the filter", () => {
    const parsed = parseArgs(["tasks", "list", "--overdue", "--status", "todo", "--assignee-id", "wm-1", "--limit", "5"], COMMAND_TREE, flagSpecsFor);
    expect(parsed.errors).toEqual([]);
    const plan = planList("tasks", parsed.flags);
    expect(plan.objectPath).toBe("tasks");
    expect(plan.filter).toContain('status[eq]:"TODO"');
    expect(plan.filter).toContain('assigneeId[eq]:"wm-1"');
    expect(plan.filter).toContain("dueAt[lt]:");
    expect(plan.limit).toBe(5);
    expect(plan.limitExplicit).toBe(true);
  });

  it("knows every tasks verb and keeps --field values whole", () => {
    for (const verb of ["list", "get", "search", "create", "update", "complete", "delete"]) {
      expect(COMMAND_TREE.tasks).toContain(verb);
    }
    const parsed = parseArgs(
      ["tasks", "create", "--title", "x", "--field", "labels=a,b", "--field", "bord=Prudai"],
      COMMAND_TREE, flagSpecsFor,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.flags.field).toEqual(["labels=a,b", "bord=Prudai"]);
    const complete = parseArgs(["tasks", "complete", "t-1", "--no-dry-run", "--yes"], COMMAND_TREE, flagSpecsFor);
    expect(complete.command).toEqual(["tasks", "complete"]);
    expect(complete.positionals).toEqual(["t-1"]);
    expect(resolveWriteGate(complete.flags).dryRun).toBe(false);
  });
});

// ---- due dates --------------------------------------------------------------

describe("parseDueAt", () => {
  // A bare day is midnight in Amsterdam, so the card shows that date in the UI
  // (not the evening before) and is overdue from the start of the day.
  it("reads a bare day as midnight Europe/Amsterdam", () => {
    expect(parseDueAt("2026-09-04")).toBe("2026-09-03T22:00:00.000Z"); // CEST, UTC+2
    expect(parseDueAt("2026-12-04")).toBe("2026-12-03T23:00:00.000Z"); // CET, UTC+1
  });

  it("reads a wall-clock time in Europe/Amsterdam, DST-aware", () => {
    expect(parseDueAt("2026-09-04T10:00")).toBe("2026-09-04T08:00:00.000Z");
    expect(parseDueAt("2026-12-04 10:00")).toBe("2026-12-04T09:00:00.000Z");
    expect(parseDueAt("2026-09-04T10:00:30")).toBe("2026-09-04T08:00:30.000Z");
  });

  it("takes a timestamp with an explicit zone literally", () => {
    expect(parseDueAt("2026-09-04T10:00Z")).toBe("2026-09-04T10:00:00.000Z");
    expect(parseDueAt("2026-09-04T10:00:00+02:00")).toBe("2026-09-04T08:00:00.000Z");
  });

  it("refuses dates that are not dates", () => {
    expect(() => parseDueAt("04-09-2026")).toThrow(TaskError);
    expect(() => parseDueAt("2026-02-30")).toThrow(/not a real date/);
    expect(() => parseDueAt("2026-09-04T25:00")).toThrow(/not a real date/);
    expect(() => parseDueAt("morgen")).toThrow(TaskError);
  });

  it("round-trips through formatDue", () => {
    expect(formatDue(parseDueAt("2026-09-04"))).toBe("2026-09-04");
    expect(formatDue(parseDueAt("2026-09-04T10:00"))).toBe("2026-09-04 10:00");
    expect(formatDue(null)).toBe("");
  });
});

// ---- --field ----------------------------------------------------------------

describe("parseFieldAssignments", () => {
  it("writes key=value as a string and key:=json as JSON", () => {
    expect(parseFieldAssignments(["bord=Prudai", "prio:=3", "labels:=[\"a\",\"b\"]", "flag:=true", "x:=null"]))
      .toEqual({ bord: "Prudai", prio: 3, labels: ["a", "b"], flag: true, x: null });
  });

  it("keeps a comma and an = inside the value", () => {
    expect(parseFieldAssignments(["labels=a,b", "note=x=y"])).toEqual({ labels: "a,b", note: "x=y" });
  });

  it("refuses fields that have their own flag, so they cannot skip validation", () => {
    expect(() => parseFieldAssignments(["status=FOO"])).toThrow(/own flag/);
    expect(() => parseFieldAssignments(["dueAt=2026-09-04"])).toThrow(RecordWriteError);
  });

  it("refuses malformed input and invalid JSON", () => {
    expect(() => parseFieldAssignments(["nokey"])).toThrow(/key=value/);
    expect(() => parseFieldAssignments(["1bad=x"])).toThrow(RecordWriteError);
    expect(() => parseFieldAssignments(["prio:={oops"])).toThrow(/not valid JSON/);
  });
});

// ---- bodies -----------------------------------------------------------------

describe("buildTaskBody", () => {
  it("writes both markdown and blocknote, like a note, and normalises the rest", () => {
    const body = buildTaskBody({
      title: "  Bel terug  ", body: "regel een\nregel twee", status: "in progress",
      dueAt: "2026-09-03T22:00:00.000Z", assigneeId: "wm-1", fields: { bord: "Prudai" },
    }) as { title: string; bodyV2: { markdown: string; blocknote: string }; status: string; dueAt: string; assigneeId: string; bord: string };
    expect(body.title).toBe("Bel terug");
    expect(body.bodyV2.markdown).toBe("regel een\nregel twee");
    expect(JSON.parse(body.bodyV2.blocknote)).toHaveLength(2);
    expect(body.status).toBe("IN_PROGRESS");
    expect(body.dueAt).toBe("2026-09-03T22:00:00.000Z");
    expect(body.assigneeId).toBe("wm-1");
    expect(body.bord).toBe("Prudai");
  });

  it("needs a title but not a body — the board holds plain to-dos", () => {
    expect(() => buildTaskBody({ body: "x" })).toThrow(/--title/);
    expect(buildTaskBody({ title: "Alleen kop" })).toEqual({ title: "Alleen kop" });
  });

  it("omits an empty body instead of writing an empty paragraph", () => {
    expect(buildTaskBody({ title: "t", body: "   " })).not.toHaveProperty("bodyV2");
  });
});

describe("buildTaskUpdateBody", () => {
  it("PATCHes only what was passed", () => {
    expect(buildTaskUpdateBody({ status: "done" })).toEqual({ status: "DONE" });
    expect(buildTaskUpdateBody({ fields: { bord: "Prudai" } })).toEqual({ bord: "Prudai" });
    expect(buildTaskUpdateBody({ title: "  ", dueAt: "2026-09-03T22:00:00.000Z" })).toEqual({ dueAt: "2026-09-03T22:00:00.000Z" });
  });

  // The create path had this covered; the update path did not, so a regression
  // that wrote markdown without blocknote would only have shown up in the UI.
  it("writes markdown AND blocknote on an update too", () => {
    const body = buildTaskUpdateBody({ body: "regel een\nregel twee" }) as
      { bodyV2: { markdown: string; blocknote: string } };
    expect(body.bodyV2.markdown).toBe("regel een\nregel twee");
    expect(JSON.parse(body.bodyV2.blocknote)).toHaveLength(2);
  });

  it("refuses an empty update", () => {
    expect(() => buildTaskUpdateBody({})).toThrow(/Nothing to write/);
    expect(() => buildTaskUpdateBody({ title: " ", fields: {} })).toThrow(RecordWriteError);
  });
});

// ---- create with targets ----------------------------------------------------

describe("createTaskWithTargets", () => {
  it("creates the task and links company, person and opportunity through taskTargets", async () => {
    const { client, calls } = routedClient([["/rest/tasks", { data: { createTask: { id: "t-1" } } }]]);
    const outcome = await createTaskWithTargets(
      client, { title: "t" }, { companyId: "c-1", personId: "p-1", opportunityId: "o-1" }, BASE,
    );
    expect(outcome).toEqual({ action: "create", object: "tasks", id: "t-1", url: `${BASE}/object/task/t-1` });
    expect(calls[0]).toMatchObject({ endpoint: "/rest/tasks", method: "POST" });
    const targets = calls.filter((c) => c.endpoint === "/rest/taskTargets");
    expect(targets.every((c) => c.method === "POST")).toBe(true);
    expect(targets.map((c) => c.body)).toEqual([
      { taskId: "t-1", targetPersonId: "p-1" },
      { taskId: "t-1", targetCompanyId: "c-1" },
      { taskId: "t-1", targetOpportunityId: "o-1" },
    ]);
  });

  it("creates no target rows for a plain to-do", async () => {
    const { client, calls } = routedClient([["/rest/tasks", { data: { createTask: { id: "t-2" } } }]]);
    await createTaskWithTargets(client, { title: "t" }, {}, BASE);
    expect(calls).toHaveLength(1);
  });

  // Same contract as notes: a task that lost its link is a card nobody finds.
  it("removes the task again when linking fails", async () => {
    const { client, calls } = routedClient([
      ["/rest/taskTargets", new Error("HTTP 400 no such company")],
      ["/rest/tasks", { data: { createTask: { id: "t-3" } } }],
    ]);
    await expect(createTaskWithTargets(client, { title: "t" }, { companyId: "nope" }, BASE))
      .rejects.toThrow(/task t-3 was removed again/);
    expect(calls).toContainEqual({ endpoint: "/rest/tasks/t-3", method: "DELETE", body: null });
  });

  it("describes the links for the confirmation", () => {
    expect(describeTaskTargets({ companyId: "c-1", opportunityId: "o-1" }))
      .toEqual(["linked to company c-1", "linked to opportunity o-1"]);
    expect(describeTaskTargets({})).toEqual([]);
  });
});

// ---- dry run ----------------------------------------------------------------

describe("write gate for tasks", () => {
  it("is a dry run unless --no-dry-run --yes", () => {
    expect(resolveWriteGate({}).dryRun).toBe(true);
    expect(resolveWriteGate({ yes: true }).dryRun).toBe(true);
    expect(resolveWriteGate({ "dry-run": false }).blockedReason).toMatch(/--yes/);
    expect(resolveWriteGate({ "dry-run": false, yes: true })).toMatchObject({ dryRun: false, blockedReason: null });
  });

  it("names the task object in the dry-run and success text", () => {
    expect(renderWriteDryRun("create", "tasks", { title: "t" })).toContain("DRY RUN — no task was created.");
    // The links belong with the body, above the "re-run with" footer.
    const dry = renderWriteDryRun("create", "tasks", { title: "t" }, undefined, undefined, ["linked to company c-1"]);
    expect(dry.indexOf("linked to company c-1")).toBeLessThan(dry.indexOf("Re-run with"));
    // Measured: a REST delete on a task drops the row, so the dry run must not
    // reassure the operator that it can be undone.
    const del = renderWriteDryRun("delete", "tasks", null, "t-1");
    expect(del).toContain("Deleting is permanent: the task leaves the database");
    const text = renderWriteSuccess(
      { action: "update", object: "tasks", id: "t-1", url: `${BASE}/object/task/t-1` },
      { status: "DONE", bodyV2: { markdown: "x", blocknote: "[]" } },
    );
    expect(text).toContain("Updated task t-1");
    expect(text).toContain("status: DONE");
    expect(text).toContain("body: (rich text)");
    expect(text).toContain(`${BASE}/object/task/t-1`);
  });
});

// ---- assignees --------------------------------------------------------------

describe("resolveMember", () => {
  it("finds a member by first name, last name, full name, e-mail or its local part", () => {
    expect(resolveMember(MEMBERS, "beau").id).toBe(MEMBERS[0]!.id);
    expect(resolveMember(MEMBERS, "Haisma").id).toBe(MEMBERS[1]!.id);
    expect(resolveMember(MEMBERS, "geert haisma").id).toBe(MEMBERS[1]!.id);
    expect(resolveMember(MEMBERS, "haisma@prudai.com").id).toBe(MEMBERS[1]!.id);
    expect(resolveMember(MEMBERS, "bonhke").id).toBe(MEMBERS[2]!.id);
    expect(resolveMember(MEMBERS, MEMBERS[0]!.id).id).toBe(MEMBERS[0]!.id);
  });

  it("refuses an ambiguous name and lists the candidates", () => {
    expect(() => resolveMember(MEMBERS, "bas")).toThrow(/matches 2 workspace members/);
    expect(() => resolveMember(MEMBERS, "bas")).toThrow(/Bönhke/);
  });

  // An API key is not a workspace member, so "me" has nothing to resolve to.
  it("refuses 'me' and unknown names with a usable message", () => {
    expect(() => resolveMember(MEMBERS, "me")).toThrow(/API key has no workspace member/);
    expect(() => resolveMember(MEMBERS, "roland")).toThrow(/No workspace member matches 'roland'/);
    expect(() => resolveMember(MEMBERS, "  ")).toThrow(TaskError);
  });

  it("reads members off the REST shape", async () => {
    const { client } = routedClient([["/rest/workspaceMembers", { data: { workspaceMembers: [
      { id: "wm-1", name: { firstName: "Beau", lastName: "Jonkhout" }, userEmail: "jonkhout@prudai.com" },
      { id: "", name: {}, userEmail: "" },
    ] } }]]);
    expect(await listWorkspaceMembers(client)).toEqual([
      { id: "wm-1", firstName: "Beau", lastName: "Jonkhout", email: "jonkhout@prudai.com" },
    ]);
  });
});

// ---- targets ----------------------------------------------------------------

describe("taskIdsForTarget", () => {
  it("is null without a target flag, so the list is not scoped by accident", async () => {
    const { client, calls } = routedClient([]);
    expect(await taskIdsForTarget(client, {})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("asks taskTargets for the company and returns the task ids", async () => {
    const { client, decoded } = routedClient([["targetCompanyId[eq]", { data: { taskTargets: [
      { id: "tt-1", taskId: "t-1" }, { id: "tt-2", taskId: "t-2" },
    ] } }]]);
    expect(await taskIdsForTarget(client, { companyId: "c-1" })).toEqual(["t-1", "t-2"]);
    expect(decoded()[0]).toContain('and(targetCompanyId[eq]:"c-1",deletedAt[is]:NULL)');
  });

  it("intersects when two targets are given — a target row carries one kind", async () => {
    const { client } = routedClient([
      ["targetCompanyId[eq]", { data: { taskTargets: [{ taskId: "t-1" }, { taskId: "t-2" }] } }],
      ["targetPersonId[eq]", { data: { taskTargets: [{ taskId: "t-2" }, { taskId: "t-3" }] } }],
    ]);
    expect(await taskIdsForTarget(client, { companyId: "c-1", personId: "p-1" })).toEqual(["t-2"]);
  });
});

describe("fetchTargetsForTasks", () => {
  it("maps depth=1 rows onto named targets per task", async () => {
    const { client, decoded } = routedClient([["/rest/taskTargets", { data: { taskTargets: [
      { taskId: "t-1", targetCompanyId: "c-1", targetCompany: { name: "Bouwman Advocaten" } },
      { taskId: "t-1", targetPersonId: "p-1", targetPerson: { name: { firstName: "Anne", lastName: "Jansen" } } },
      { taskId: "t-2", targetOpportunityId: "o-1", targetOpportunity: { name: "LEO pilot" } },
      { taskId: "t-3" },
    ] } }]]);
    const map = await fetchTargetsForTasks(client, ["t-1", "t-2", "t-3"]);
    expect(map.get("t-1")).toEqual([
      { kind: "company", id: "c-1", name: "Bouwman Advocaten" },
      { kind: "person", id: "p-1", name: "Anne Jansen" },
    ]);
    expect(map.get("t-2")).toEqual([{ kind: "opportunity", id: "o-1", name: "LEO pilot" }]);
    expect(map.has("t-3")).toBe(false);
    expect(decoded()[0]).toContain("depth=1");
    expect(decoded()[0]).toContain('taskId[in]:["t-1","t-2","t-3"]');
  });

  it("asks nothing for no tasks", async () => {
    const { client, calls } = routedClient([]);
    expect((await fetchTargetsForTasks(client, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ---- fetching ---------------------------------------------------------------

describe("fetchTasks", () => {
  const plan = (over = {}) => ({
    objectPath: "tasks" as const, filter: "deletedAt[is]:NULL", limit: 20, limitExplicit: false,
    orderBy: "dueAt[AscNullsLast]", depth: undefined, fetchAll: false, ...over,
  });

  it("goes to the server with the plan when there is no target scope", async () => {
    const { client, decoded } = routedClient([["/rest/tasks", { data: { tasks: [{ id: "t-1" }] } }]]);
    expect(await fetchTasks(client, plan(), null)).toEqual([{ id: "t-1" }]);
    expect(decoded()[0]).toContain("order_by=dueAt[AscNullsLast]");
    expect(decoded()[0]).toContain("limit=20");
  });

  it("returns nothing, and asks nothing, for an empty target scope", async () => {
    const { client, calls } = routedClient([]);
    expect(await fetchTasks(client, plan(), [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // The server cannot order across id[in] chunks, so the CLI sorts the merged
  // set itself: due first, undated last — and only then applies the limit.
  it("fetches scoped ids in chunks of 100, sorts due-first and applies the limit", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t-${i}`);
    // One response per chunk, deliberately different, so the assertion below
    // can only hold if the two pages were merged and sorted together.
    const pages = [
      { data: { tasks: [
        { id: "t-a", dueAt: null, createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "t-b", dueAt: "2026-09-04T00:00:00.000Z", createdAt: "2026-08-02T00:00:00.000Z" },
      ] } },
      { data: { tasks: [
        { id: "t-c", dueAt: "2026-08-20T00:00:00.000Z", createdAt: "2026-08-03T00:00:00.000Z" },
        { id: "t-d", dueAt: "2026-09-04T00:00:00.000Z", createdAt: "2026-08-05T00:00:00.000Z" },
        { id: "t-e", dueAt: null, createdAt: "2026-08-06T00:00:00.000Z" },
      ] } },
    ];
    const calls: string[] = [];
    const client = { request: async (endpoint: string) => pages[calls.push(endpoint) - 1] } as never;

    const rows = await fetchTasks(client, plan({ limit: 4 }), ids);
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[0]!)).toContain('id[in]:["t-0","t-1"');
    expect(decodeURIComponent(calls[1]!)).toContain('id[in]:["t-100","t-101"');
    // Due first (t-c), then the 09-04 pair newest-created first, then the
    // undated tail on the same tie-break; the limit is applied after sorting,
    // so the oldest undated task (t-a) drops off.
    expect(rows.map((r) => r.id)).toEqual(["t-c", "t-d", "t-b", "t-e"]);
  });
});

// ---- rendering --------------------------------------------------------------

const RAW_TASKS = [
  {
    id: "11111111-2222-3333-4444-555555555555", title: "Bel terug over offerte", status: "TODO",
    dueAt: "2026-09-03T22:00:00.000Z", assigneeId: MEMBERS[0]!.id, createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z", position: 3,
    createdBy: { name: "cato-cli", source: "API" },
    bodyV2: { markdown: "- eerst bellen\n- dan mailen", blocknote: "[]" },
  },
  { id: "66666666-7777-8888-9999-000000000000", title: "Zonder alles", status: null, dueAt: null, assigneeId: "wm-unknown" },
];
const TARGETS = new Map([[RAW_TASKS[0]!.id, [
  { kind: "company" as const, id: "c-1", name: "Bouwman Advocaten" },
  { kind: "opportunity" as const, id: "o-1", name: "LEO pilot" },
]]]);

describe("enrichTasks + renderTaskList", () => {
  const rows = enrichTasks(RAW_TASKS, TARGETS, MEMBERS, BASE);

  it("adds names, a formatted due date and a clickable url", () => {
    expect(rows[0]).toMatchObject({
      due: "2026-09-04", assignee: "Beau Jonkhout",
      targets: [{ kind: "company", id: "c-1", name: "Bouwman Advocaten" }, { kind: "opportunity", id: "o-1", name: "LEO pilot" }],
      url: `${BASE}/object/task/${RAW_TASKS[0]!.id}`,
    });
    // An assignee the workspace does not know is shown by id, not swallowed.
    expect(rows[1]).toMatchObject({ due: "", assignee: "wm-unknown", targets: [], status: null });
  });

  it("renders the table with short ids, names and an unclamped url", () => {
    const table = renderTaskList(rows, { json: false, csv: false });
    const [header, , first] = table.split("\n");
    expect(header).toMatch(/^id\s+title\s+status\s+due\s+assignee\s+targets\s+url/);
    expect(first).toContain("11111111  ");
    expect(first).toContain("Beau Jonkhout");
    expect(first).toContain("company: Bouwman Advocaten; opportunity: LEO pilot");
    expect(first).toContain(`${BASE}/object/task/${RAW_TASKS[0]!.id}`);
    expect(first).not.toContain("…");
  });

  it("gives --json the full rows and --csv a header plus one line per task", () => {
    const json = JSON.parse(renderTaskList(rows, { json: true, csv: false }));
    expect(json).toHaveLength(2);
    expect(json[0].id).toBe(RAW_TASKS[0]!.id);
    expect(json[0].targets[0].name).toBe("Bouwman Advocaten");
    const csv = renderTaskList(rows, { json: false, csv: true }).split("\n");
    expect(csv[0]).toBe("id,title,status,due,assignee,targets,url");
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain("11111111,Bel terug over offerte,TODO,2026-09-04,Beau Jonkhout,");
  });

  it("says so when there is nothing", () => {
    expect(renderTaskList([], { json: false, csv: false })).toBe("(no records)");
    expect(renderTaskList([], { json: true, csv: false })).toBe("[]");
  });
});

describe("renderTaskDetail", () => {
  const row = enrichTasks(RAW_TASKS, TARGETS, MEMBERS, BASE)[0]!;

  it("shows every field, the targets with ids, and the body as markdown", () => {
    const text = renderTaskDetail(row, { json: false, csv: false });
    expect(text).toContain(`id          ${RAW_TASKS[0]!.id}`);
    expect(text).toContain("status      TODO");
    expect(text).toContain("due         2026-09-04");
    expect(text).toContain("assignee    Beau Jonkhout");
    expect(text).toContain("createdBy   cato-cli (API)");
    // The second target lines up under the first, in the value column.
    expect(text).toContain("targets     company: Bouwman Advocaten (c-1)\n            opportunity: LEO pilot (o-1)");
    expect(text).toContain("body:\n  - eerst bellen\n  - dan mailen");
    expect(text).toContain(`${BASE}/object/task/${RAW_TASKS[0]!.id}`);
    expect(text).not.toContain("[object Object]");
  });

  it("handles a task without body and a missing task", () => {
    const bare = enrichTasks(RAW_TASKS, TARGETS, MEMBERS, BASE)[1]!;
    expect(renderTaskDetail(bare, { json: false, csv: false })).toContain("body:\n  (empty)");
    expect(renderTaskDetail(null, { json: false, csv: false })).toBe("(not found)");
    expect(renderTaskDetail(null, { json: true, csv: false })).toBe("null");
  });
});

// ---- table clamp ------------------------------------------------------------

describe("toTable url column", () => {
  // A record url is 74 characters; the 48-character clamp used to cut every
  // one off at "…/object/company/00026545-…" — unclickable.
  it("never clamps the url column, and still clamps the others", () => {
    const url = `${BASE}/object/company/00026545-6d96-4e8a-85c7-68c0907eb912`;
    const table = toTable([{ name: "x".repeat(80), url }], ["name", "url"]);
    expect(table).toContain(url);
    expect(table).toContain("…");
  });

  it("honours a per-column width override", () => {
    const table = toTable([{ title: "y".repeat(60) }], ["title"], { title: 60 });
    expect(table).not.toContain("…");
  });
});
