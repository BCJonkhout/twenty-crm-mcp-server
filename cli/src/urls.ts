// Deep links into the CATO web app.
//
// Every command that touches a record should be able to say "open it here",
// so a result can be shown to someone instead of only read in a terminal.
// Route shapes are taken from twenty-shared/src/types/AppPath.ts:
//   RecordShowPage  = '/object/:objectNameSingular/:objectRecordId'
//   RecordIndexPage = '/objects/:objectNamePlural'
//   Marketing       = '/marketing'

export const DEFAULT_BASE_URL = "https://crm.prudai.com";

function trimBase(baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Link to a single record, e.g. .../object/company/<uuid>. */
export function recordUrl(baseUrl: string, objectNameSingular: string, recordId: string): string {
  if (!recordId) throw new Error("recordUrl needs a record id");
  return `${trimBase(baseUrl)}/object/${objectNameSingular}/${encodeURIComponent(recordId)}`;
}

/** Link to a record list, e.g. .../objects/companies. */
export function indexUrl(baseUrl: string, objectNamePlural: string): string {
  return `${trimBase(baseUrl)}/objects/${objectNamePlural}`;
}

/** Link to the marketing module; with a campaign id when we have one. */
export function marketingUrl(baseUrl: string, campaignId?: string): string {
  const base = `${trimBase(baseUrl)}/marketing`;
  return campaignId ? `${base}/campaigns/${encodeURIComponent(campaignId)}` : base;
}

const SINGULAR: Record<string, string> = {
  people: "person",
  companies: "company",
  opportunities: "opportunity",
  notes: "note",
  tasks: "task",
};

/** Maps the CLI's plural command group onto Twenty's singular route segment. */
export function singularFor(group: string): string {
  return SINGULAR[group] ?? group.replace(/s$/, "");
}

/**
 * Adds a `url` key to each record so `--json` output is directly clickable.
 * Records without an `id` are passed through untouched rather than guessed at.
 */
export function withUrls<T extends Record<string, unknown>>(
  records: T[],
  baseUrl: string,
  group: string,
): Array<T & { url?: string }> {
  const singular = singularFor(group);
  return records.map((record) => {
    const id = record.id;
    if (typeof id !== "string" || id === "") return record;
    return { ...record, url: recordUrl(baseUrl, singular, id) };
  });
}
