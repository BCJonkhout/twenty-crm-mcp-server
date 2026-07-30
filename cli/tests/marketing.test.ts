import { describe, expect, it } from "bun:test";
import {
  assertMarketingAuth, filterReviewQueue, MarketingAuthError, normalizeApprovalState,
  renderApproveDryRun, renderSendNowDryRun, type Campaign, type ReviewQueueItem,
} from "../src/commands/marketing.ts";

const QUEUE: ReviewQueueItem[] = [
  { touchpointId: "t1", approvalState: "pending", personEmail: "a@x.nl", personName: "A", subject: "S1" },
  { touchpointId: "t2", approvalState: "approved", personEmail: "b@x.nl", personName: "B", subject: "S2" },
  { touchpointId: "t3", approvalState: "APPROVED", personEmail: "c@x.nl", personName: "C", subject: "S3" },
  { touchpointId: "t4", approvalState: "rejected", personEmail: "d@x.nl", personName: "D", subject: "S4" },
];

describe("assertMarketingAuth", () => {
  it("refuses to proceed with only an API key", () => {
    // The marketing module gives any non-user auth context accessLevel 'none',
    // so failing here with an explanation beats a bare 403 from the server.
    expect(() => assertMarketingAuth(undefined)).toThrow(MarketingAuthError);
    expect(() => assertMarketingAuth(undefined)).toThrow(/USER session token/);
  });

  it("passes a user token through", () => {
    expect(assertMarketingAuth("usr-token")).toBe("usr-token");
  });
});

describe("normalizeApprovalState", () => {
  it("lower-cases a valid state", () => {
    expect(normalizeApprovalState("PENDING")).toBe("pending");
  });
  it("returns null when no state was requested", () => {
    expect(normalizeApprovalState(undefined)).toBeNull();
  });
  it("rejects an invalid state", () => {
    expect(() => normalizeApprovalState("sent")).toThrow(/not valid/);
  });
});

describe("filterReviewQueue", () => {
  it("returns everything when no state is given", () => {
    expect(filterReviewQueue(QUEUE, null)).toHaveLength(4);
  });
  it("filters case-insensitively", () => {
    expect(filterReviewQueue(QUEUE, "approved").map((i) => i.touchpointId)).toEqual(["t2", "t3"]);
  });
  it("finds the pending review queue", () => {
    expect(filterReviewQueue(QUEUE, "pending").map((i) => i.touchpointId)).toEqual(["t1"]);
  });
});

describe("write-action dry runs", () => {
  it("shows the recipient count of a single approve", () => {
    const text = renderApproveDryRun(QUEUE[0]!, "approve");
    expect(text).toContain("DRY RUN — touchpoint NOT approved.");
    expect(text).toContain("Recipients affected: 1");
    expect(text).toContain("a@x.nl");
    expect(text).toContain("--no-dry-run --yes");
  });

  it("does not claim that approving sends the mail", () => {
    expect(renderApproveDryRun(QUEUE[0]!, "approve")).toContain("It does not send it immediately.");
  });

  it("counts every recipient before a send-now", () => {
    const campaign: Campaign = { id: "c1", name: "Advocatuur Q3" };
    const approved = filterReviewQueue(QUEUE, "approved");
    const text = renderSendNowDryRun(campaign, approved);
    expect(text).toContain("Approved touchpoints: 2");
    expect(text).toContain("Recipients affected : 2");
    expect(text).toContain("b@x.nl");
    expect(text).toContain("real e-mail via SendGrid to real people");
  });

  it("truncates the recipient preview but still reports the full count", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      touchpointId: `t${i}`, approvalState: "approved", personEmail: `p${i}@x.nl`,
    }));
    const text = renderSendNowDryRun({ id: "c", name: "C" }, many);
    expect(text).toContain("Recipients affected : 25");
    expect(text).toContain("and 15 more");
  });
});
