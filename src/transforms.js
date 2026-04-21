// Flat-input → Twenty composite-field transforms. Ported verbatim from the
// original index.js so existing callers keep working.

export function transformPersonData(data) {
  const t = { ...data };
  if (t.firstName || t.lastName) {
    t.name = { firstName: t.firstName || "", lastName: t.lastName || "" };
    delete t.firstName;
    delete t.lastName;
  }
  if (t.email) {
    t.emails = { primaryEmail: t.email };
    delete t.email;
  }
  if (t.phone) {
    t.phones = { primaryPhoneNumber: t.phone };
    delete t.phone;
  }
  if (t.linkedinUrl) {
    t.linkedinLink = { url: t.linkedinUrl, label: "LinkedIn" };
    delete t.linkedinUrl;
  }
  return t;
}

export function transformCompanyData(data) {
  const t = { ...data };
  if (typeof t.domainName === "string") {
    const domain = t.domainName;
    t.domainName = {
      primaryLinkLabel: domain,
      primaryLinkUrl: domain.startsWith("http") ? domain : `https://${domain}`,
      secondaryLinks: [],
    };
  }
  if (typeof t.address === "string") {
    t.address = {
      addressStreet1: t.address,
      addressStreet2: "",
      addressCity: "",
      addressPostcode: "",
      addressState: "",
      addressCountry: "",
      addressLat: null,
      addressLng: null,
    };
  }
  if (t.linkedinUrl) {
    t.linkedinLink = {
      primaryLinkLabel: "LinkedIn",
      primaryLinkUrl: t.linkedinUrl,
      secondaryLinks: [],
    };
    delete t.linkedinUrl;
  }
  if (t.xUrl) {
    t.xLink = {
      primaryLinkLabel: "X",
      primaryLinkUrl: t.xUrl,
      secondaryLinks: [],
    };
    delete t.xUrl;
  }
  if (typeof t.annualRecurringRevenue === "number") {
    t.annualRecurringRevenue = {
      amountMicros: t.annualRecurringRevenue * 1_000_000,
      currencyCode: "EUR",
    };
  }
  return t;
}

export function transformBodyField(data) {
  const t = { ...data };
  if (t.body === undefined) return t;
  const text = t.body;
  const blocks = text.split("\n").map((line, i) => ({
    id: `block-${Date.now()}-${i}`,
    type: "paragraph",
    props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
    content: [{ type: "text", text: line, styles: {} }],
    children: [],
  }));
  t.bodyV2 = {
    blocknote: JSON.stringify(blocks),
    markdown: text,
  };
  delete t.body;
  return t;
}

export async function createTargetsForRecord(client, type, recordId, targetPersonIds = [], targetCompanyIds = []) {
  const endpoint = type === "note" ? "/rest/noteTargets" : "/rest/taskTargets";
  const idField = type === "note" ? "noteId" : "taskId";
  const created = [];
  for (const personId of targetPersonIds ?? []) {
    const target = await client.request(endpoint, {
      method: "POST",
      body: { [idField]: recordId, targetPersonId: personId },
    });
    created.push(target);
  }
  for (const companyId of targetCompanyIds ?? []) {
    const target = await client.request(endpoint, {
      method: "POST",
      body: { [idField]: recordId, targetCompanyId: companyId },
    });
    created.push(target);
  }
  return created;
}

export function extractId(result) {
  // Twenty responses nest the record under varying keys (data.createX, data.X).
  // Return the first plausible id.
  if (!result) return null;
  if (result.id) return result.id;
  const data = result.data;
  if (!data) return null;
  if (data.id) return data.id;
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v && typeof v === "object" && v.id) return v.id;
  }
  return null;
}
