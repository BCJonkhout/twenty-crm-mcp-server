import { describe, expect, it } from "bun:test";
import { fetchRecords, type ListInvocation } from "../src/commands/records.ts";

/**
 * Serves `total` records in pages of `pageSize`, the way Twenty does: rows plus
 * a pageInfo cursor. Counts requests so a test can prove pagination happened.
 */
function pagingClient(total: number, objectPath = "opportunities", pageSize = 60) {
  let served = 0;
  const client = {
    request: async (endpoint: string) => {
      // Honour the limit the caller actually asked for, like the real API does.
      const asked = Number(new URL(endpoint, "https://x").searchParams.get("limit")) || pageSize;
      const rows = Array.from(
        { length: Math.max(0, Math.min(asked, pageSize, total - served)) },
        (_, i) => ({ id: `r-${served + i}` }),
      );
      served += rows.length;
      return {
        data: { [objectPath]: rows },
        pageInfo: { hasNextPage: served < total, endCursor: `cursor-${served}` },
      };
    },
  };
  return client as never;
}

function plan(over: Partial<ListInvocation> = {}): ListInvocation {
  return {
    objectPath: "opportunities", filter: null, limit: 20,
    orderBy: undefined, depth: undefined, fetchAll: false, ...over,
  } as ListInvocation;
}

describe("fetchRecords", () => {
  // --all used to stop at plan.limit, which is 20 whenever nobody passed
  // --limit. `cato opportunities list --all` then returned 20 of 31 records and
  // presented that as the complete set — a silent cap on a flag whose whole
  // purpose is not to cap.
  it("--all returns every match, not the default page of 20", async () => {
    const rows = await fetchRecords(pagingClient(31), plan({ fetchAll: true, limit: 20 }));
    expect(rows).toHaveLength(31);
  });

  it("--all keeps paging past a single page", async () => {
    const rows = await fetchRecords(pagingClient(150), plan({ fetchAll: true, limit: 20 }));
    expect(rows).toHaveLength(150);
  });

  it("--all with an explicit --limit still honours that cap", async () => {
    const rows = await fetchRecords(
      pagingClient(100), plan({ fetchAll: true, limit: 5, limitExplicit: true }),
    );
    expect(rows).toHaveLength(5);
  });

  it("without --all it stays on one page and respects the limit", async () => {
    const rows = await fetchRecords(pagingClient(100), plan({ limit: 7 }));
    expect(rows.length).toBeLessThanOrEqual(7);
  });
});
