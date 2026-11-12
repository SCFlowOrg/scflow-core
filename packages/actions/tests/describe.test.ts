import { describe, expect, it } from "vitest";
import { describeCall } from "../src/index.js";

const UUID = "3f2b8c1e-5d4a-4b7e-9c10-a1b2c3d4e5f6";
const action = {
  id: "scflow/create_flow",
  title: "Create flow",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", ref: "scflow/actor" },
      name: { type: "string" },
      tags: { type: "array", items: { type: "string", ref: "scflow/tag" } },
    },
  },
};
const label = (schema: string, id: string) => (id === UUID && schema === "scflow/actor" ? "Acme" : undefined);

describe("describeCall", () => {
  it("shows the name of a referenced instance, never its uuid", async () => {
    const text = await describeCall(action, { source: UUID, name: { en: "Main", fr: "Principal" } }, { label, language: "fr" });
    expect(text).toBe("Create flow: source=Acme, name=Principal");
    expect(text).not.toContain(UUID);
  });
  it("cuts a uuid that no instance has", async () => {
    expect(await describeCall(action, { tags: [UUID] }, { label })).toBe("Create flow: tags=…e5f6");
  });
  it("falls back to the id and drops empty values", async () => {
    expect(await describeCall({ id: "scflow/delete_actor" }, {})).toBe("Delete actor");
    expect(await describeCall(action, { name: "" })).toBe("Create flow");
  });
  it("uses translations when given", async () => {
    const t = (key: string) =>
      ({ "action.scflow/create_flow.title": "Créer un flux", "action.scflow/create_flow.param.source": "origine" })[key];
    expect(await describeCall(action, { source: UUID }, { label, t })).toBe("Créer un flux: origine=Acme");
  });
  it("lets a summary phrase take the variables", async () => {
    const t = (key: string, vars?: Readonly<Record<string, string>>) =>
      key.endsWith(".summary") ? `Flow from ${vars?.source}` : undefined;
    expect(await describeCall(action, { source: UUID }, { label, t })).toBe("Flow from Acme");
  });
});
