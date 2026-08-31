import { describe, expect, it } from "bun:test";
import { transformBodyField, transformPersonData } from "../src/transforms.ts";

describe("transformPersonData", () => {
  it("builds the composite name from both halves", () => {
    expect(transformPersonData({ firstName: "Beau", lastName: "Jonkhout" }).name)
      .toEqual({ firstName: "Beau", lastName: "Jonkhout" });
  });

  // A PATCH that carries lastName:"" wipes the surname of an existing person.
  it("omits the half that was not supplied instead of blanking it", () => {
    expect(transformPersonData({ firstName: "Beau" }).name).toEqual({ firstName: "Beau" });
    expect(transformPersonData({ lastName: "Jonkhout" }).name).toEqual({ lastName: "Jonkhout" });
  });

  it("leaves name out entirely when neither half is given", () => {
    expect(transformPersonData({ jobTitle: "Advocaat" })).not.toHaveProperty("name");
  });

  it("maps email and phone onto their composite fields", () => {
    const t = transformPersonData({ email: "a@b.nl", phone: "0612345678" });
    expect(t.emails).toEqual({ primaryEmail: "a@b.nl" });
    expect(t.phones).toEqual({ primaryPhoneNumber: "0612345678" });
    expect(t).not.toHaveProperty("email");
  });
});

// De taakbody's die agents schrijven zijn markdown. Tot 31-08-2026 maakte
// transformBodyField van élke regel een platte alinea, dus koppen, opsommingen
// en vet kwamen als letterlijke tekens in CATO te staan — en elke lege regel
// werd een leeg blok, wat de editor halverwege liet stoppen.
describe("transformBodyField — markdown naar BlockNote", () => {
  const blocks = (md: string) =>
    JSON.parse((transformBodyField({ body: md }).bodyV2 as { blocknote: string }).blocknote);

  it("bewaart de markdown ongewijzigd naast de blokken", () => {
    const md = "# Kop\n\ntekst";
    const body = transformBodyField({ body: md }).bodyV2 as { markdown: string };
    expect(body.markdown).toBe(md);
  });

  it("maakt van een #-regel een heading met het juiste niveau", () => {
    const b = blocks("# Een\n## Twee\n### Drie");
    expect(b.map((x: { type: string }) => x.type)).toEqual(["heading", "heading", "heading"]);
    expect(b.map((x: { props: { level: number } }) => x.props.level)).toEqual([1, 2, 3]);
    expect(b[0].content[0].text).toBe("Een");
  });

  it("maakt lijstblokken van opsommings- en nummerregels", () => {
    const b = blocks("- een\n* twee\n1. drie\n2. vier");
    expect(b.map((x: { type: string }) => x.type)).toEqual([
      "bulletListItem", "bulletListItem", "numberedListItem", "numberedListItem",
    ]);
    expect(b[0].content[0].text).toBe("een");
    expect(b[2].content[0].text).toBe("drie");
  });

  it("zet **vet**, *cursief* en `code` om in styles in plaats van letterlijke tekens", () => {
    const [b] = blocks("Dit is **vet** en *schuin* en `code`.");
    expect(b.content).toEqual([
      { type: "text", text: "Dit is ", styles: {} },
      { type: "text", text: "vet", styles: { bold: true } },
      { type: "text", text: " en ", styles: {} },
      { type: "text", text: "schuin", styles: { italic: true } },
      { type: "text", text: " en ", styles: {} },
      { type: "text", text: "code", styles: { code: true } },
      { type: "text", text: ".", styles: {} },
    ]);
  });

  it("maakt van [tekst](url) een link", () => {
    const [b] = blocks("zie [het rapport](https://prudai.com/x) hier");
    expect(b.content[1]).toEqual({
      type: "link",
      href: "https://prudai.com/x",
      content: [{ type: "text", text: "het rapport", styles: {} }],
    });
  });

  it("slaat lege regels over in plaats van er lege blokken van te maken", () => {
    expect(blocks("een\n\n\ntwee")).toHaveLength(2);
  });

  it("laat losse sterretjes en streepjes met rust", () => {
    const [b] = blocks("5 * 3 = 15 en a-b");
    expect(b.type).toBe("paragraph");
    expect(b.content).toEqual([{ type: "text", text: "5 * 3 = 15 en a-b", styles: {} }]);
  });

  it("laat body ongemoeid als er geen body is meegegeven", () => {
    expect(transformBodyField({ title: "x" })).not.toHaveProperty("bodyV2");
  });
});
