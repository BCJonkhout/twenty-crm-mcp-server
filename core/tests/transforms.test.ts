import { describe, expect, it } from "bun:test";
import { transformPersonData } from "../src/transforms.ts";

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
