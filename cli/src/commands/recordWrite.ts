// Write path for the core CRM objects: people and companies.
//
// Twenty stores names, emails and phones as composite fields; `transformPersonData`
// and `transformCompanyData` in core do that mapping, so the CLI takes flat
// flags and never asks anyone to hand-write a composite object.

import type { RestClient } from "@twenty-crm/core";
import { transformCompanyData, transformPersonData } from "@twenty-crm/core";
import { recordUrl } from "../urls.ts";

export class RecordWriteError extends Error {}

export type WritableObject = "people" | "companies";

const SINGULAR: Record<WritableObject, string> = { people: "person", companies: "company" };

export interface PersonFlags {
  firstName?: string; lastName?: string; email?: string; phone?: string;
  jobTitle?: string; city?: string; linkedinUrl?: string;
  companyId?: string; assigneeId?: string;
}

export interface CompanyFlags {
  name?: string; domain?: string; city?: string; employees?: number;
  branche?: string; accountOwnerId?: string;
}

/** Drops undefined/blank flags so an update never blanks a field by accident. */
function present(input: PersonFlags | CompanyFlags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

export function buildPersonBody(flags: PersonFlags): Record<string, unknown> {
  const cleaned = present(flags);
  if (Object.keys(cleaned).length === 0) {
    throw new RecordWriteError("Nothing to write: pass at least one field.");
  }
  return transformPersonData(cleaned as never);
}

export function buildCompanyBody(flags: CompanyFlags): Record<string, unknown> {
  const cleaned = present(flags);
  if (Object.keys(cleaned).length === 0) {
    throw new RecordWriteError("Nothing to write: pass at least one field.");
  }
  return transformCompanyData(cleaned as never);
}

export function requireCreateFields(object: WritableObject, flags: PersonFlags & CompanyFlags): void {
  if (object === "companies" && !flags.name?.trim()) {
    throw new RecordWriteError("cato companies create needs --name.");
  }
  if (object === "people" && !flags.firstName?.trim() && !flags.lastName?.trim() && !flags.email?.trim()) {
    throw new RecordWriteError("cato people create needs at least --first-name, --last-name or --email.");
  }
}

/**
 * Twenty's "Sales Rep" role scopes Person visibility by
 * `assigneeId IS currentWorkspaceMember`. A person created against a company
 * without inheriting that company's accountOwnerId is invisible to the rep who
 * owns the account — so we inherit it unless the caller said otherwise.
 */
export async function resolveAssignee(
  client: RestClient,
  flags: PersonFlags,
): Promise<{ assigneeId?: string; inheritedFrom?: string }> {
  if (flags.assigneeId) return { assigneeId: flags.assigneeId };
  if (!flags.companyId) return {};

  const result = await client.request<{ data?: { company?: { accountOwnerId?: string | null } } }>(
    `/rest/companies/${flags.companyId}`,
  );
  const owner = result?.data?.company?.accountOwnerId;
  return owner ? { assigneeId: owner, inheritedFrom: flags.companyId } : {};
}

export interface WriteOutcome {
  action: "create" | "update" | "delete";
  object: WritableObject;
  id?: string;
  url?: string;
}

export async function createRecord(
  client: RestClient, object: WritableObject, body: Record<string, unknown>, baseUrl: string,
): Promise<WriteOutcome> {
  const singular = SINGULAR[object];
  const created = await client.request<Record<string, { [k: string]: { id?: string } }>>(
    `/rest/${object}`, { method: "POST", body },
  );
  const id = created?.data?.[`create${singular[0]!.toUpperCase()}${singular.slice(1)}`]?.id;
  return { action: "create", object, id, url: id ? recordUrl(baseUrl, singular, id) : undefined };
}

export async function updateRecord(
  client: RestClient, object: WritableObject, id: string,
  body: Record<string, unknown>, baseUrl: string,
): Promise<WriteOutcome> {
  await client.request(`/rest/${object}/${id}`, { method: "PATCH", body });
  return { action: "update", object, id, url: recordUrl(baseUrl, SINGULAR[object], id) };
}

export async function deleteRecord(
  client: RestClient, object: WritableObject, id: string,
): Promise<WriteOutcome> {
  await client.request(`/rest/${object}/${id}`, { method: "DELETE" });
  return { action: "delete", object, id };
}

export function renderWriteDryRun(
  action: "create" | "update" | "delete",
  object: WritableObject,
  body: Record<string, unknown> | null,
  id?: string,
  inheritedFrom?: string,
): string {
  const lines = [
    `DRY RUN — no ${SINGULAR[object]} was ${action}d.`,
    "",
    `Object: ${object}`,
  ];
  if (id) lines.push(`Id    : ${id}`);
  if (body) lines.push("Body  :", ...JSON.stringify(body, null, 2).split("\n").map((l) => `  ${l}`));
  if (inheritedFrom) {
    lines.push("", `Assignee inherited from company ${inheritedFrom}, so the record stays visible`,
      "to the rep who owns that account.");
  }
  if (action === "delete") lines.push("", "Deleting is a soft delete in Twenty, but still hides the record everywhere.");
  lines.push("", "Re-run with --no-dry-run --yes to apply.");
  return lines.join("\n");
}
