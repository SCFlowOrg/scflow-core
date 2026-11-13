import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@scfloworg/core";
import { generateReference } from "../src/reference.js";

/** The reference topics generated from a manifest (Reference in docs/module-packages.md). */

const manifest = readModuleManifest(`
name: acme:shop
namespace: shop
version: 1.0.0
mcl: ^1.0
title: Shop
scalar_types:
  - name: kind
    extends: string
    enum: [small, big]
schemas:
  - name: customer
    description: Someone who buys
    is_root: true
    properties:
      - name: name
        type: string
        min_length: 1
      - name: tags
        type: string
        is_array: true
  - name: order
    description: A purchase by a customer
    is_root: true
    properties:
      - name: customer
        type: customer
        mandatory: true
        inverse_name: orders
        inverse_is_array: true
      - name: size
        type: kind
  - name: hidden_base
    description: Not shown
    abstract: true
    properties: []
actions:
  - id: shop/create_order
    title: Create an order
    description: Creates an order for a customer.
    kind: action
    writes: [order]
    parameters:
      type: object
      properties:
        customer: {type: string, ref: customer, description: Id or name of the customer.}
        size: {type: string, enum: [small, big], description: The size.}
        note: {anyOf: [{type: string}, {type: object, additionalProperties: {type: string}}], description: A note.}
      required: [customer]
      additionalProperties: false
  - id: shop/find_orders
    title: Find orders
    description: Lists orders.
    kind: read
    parameters: {type: object, properties: {}, additionalProperties: false}
  - id: shop/delete_order
    title: Delete an order
    description: Deletes an order.
    kind: action
    destructive: true
    writes: [order]
    parameters:
      type: object
      properties:
        id: {type: string, ref: order, description: Id of the order.}
        cascade: {type: boolean, description: Also delete the dependents.}
      required: [id]
`);

describe("generateReference", () => {
  const topics = generateReference(manifest);
  const byId = (id: string) => topics.find((t) => t.topic.id === id)!;

  it("gives a concepts topic and an actions topic, generated reference with stable ids and files", () => {
    expect(topics.map((t) => t.topic.id)).toEqual(["shop/concepts", "shop/actions"]);
    for (const { topic } of topics) {
      expect(topic).toMatchObject({ kind: "reference", generated: true, locale: "en" });
    }
    expect(byId("shop/concepts").topic).toMatchObject({ audience: "user", file: "docs/reference/concepts.md", uses: [] });
    expect(byId("shop/actions").topic).toMatchObject({
      audience: "model-dev",
      file: "docs/reference/actions.md",
      uses: ["shop/create_order", "shop/find_orders", "shop/delete_order"],
    });
  });

  it("renders the concepts and their relations compactly, without abstract schemas", () => {
    const body = byId("shop/concepts").body;
    expect(body).toContain("### customer");
    expect(body).toContain("Someone who buys");
    expect(body).toMatch(/`customer`.*→ customer.*required.*inverse `orders`/);
    expect(body).toContain("small | big");
    expect(body).not.toContain("hidden_base");
  });

  it("renders each action with its parameters and example calls", () => {
    const body = byId("shop/actions").body;
    expect(body).toContain("### `shop/create_order`");
    expect(body).toContain("Creates an order for a customer.");
    expect(body).toContain("- `customer` (id or name of customer, required): Id or name of the customer.");
    expect(body).toContain('shop/create_order {"customer":"<customer>"}');
    expect(body).toContain('shop/create_order {"customer":"<customer>","size":"small","note":"text"}');
    expect(body).toContain("shop/find_orders {}");
    expect(body).toContain("read-only");
    expect(body).toContain("destructive");
    expect(body).toContain("`cascade`");
  });

  it("is deterministic", () => {
    expect(generateReference(manifest)).toEqual(topics);
  });
});
