import { describe, it, expect, beforeEach } from "vitest";
import { type ObservableChange } from "../src/api.js";
import { createApiSession, deleteDataset, initDataset, registerPersistentFormat, subscribeObservable } from "../src/testing.js";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription, SCHEMA_ROLES } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

let formatCounter = 0;

function fakeFormat(): PersistenceInterface & {
  seedNodeSiteSchemas: (rest: string) => Promise<void>;
  seedRegionSchema: (rest: string) => Promise<void>;
} {
  const name = `test-obs-rel-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw new ModelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return state;
  }

  function getStore(rest: string, schema: string): Map<Key, TransientValue> {
    const state = getState(rest);
    let store = state.stores.get(schema);
    if (!store) {
      store = new Map();
      state.stores.set(schema, store);
    }
    return store;
  }

  const persistenceImpl = {
    name,
    supportsTransactions: true,

    async datasetExists(rest) {
      return datasets.has(rest);
    },
    async createDataset(rest, dsName) {
      const now = new Date().toISOString();
      const info: TransientObject = {
        name: dsName,
        model_major_version: 0,
        model_minor_version: 0,
        data_major_version: 0,
        data_minor_version: 0,
        created_at: now,
        updated_at: now,
      };
      datasets.set(rest, { info, stores: new Map() });
      return info;
    },
    async getDataset(rest) {
      return getState(rest).info;
    },
    async updateDataset(rest, patch) {
      const state = getState(rest);
      Object.assign(state.info, patch as object);
      return state.info;
    },
    async deleteDataset(rest) {
      getState(rest);
      datasets.delete(rest);
    },
    async getInstance(rest, schema, key) {
      const value = getStore(rest, schema).get(key);
      return value === undefined ? null : value;
    },
    async listInstances(rest, schema) {
      return [...getStore(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
    async nextId(rest, schema) {
      const store = getStore(rest, schema);
      return `${schema}_${store.size + 1}`;
    },
    
    async seedNodeSiteSchemas(rest: string): Promise<void> {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      // Site schema - observable at schema level, but not the relation property
      const siteSchema = processSchemaDescription(
        {
          name: "site",
          observable: true,
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }, { name: "label", type: "string" }],
        },
        ctx,
      );
      schemas.set("site", siteSchema);
      
      // Node schema - observable at schema level, with observable relation to site
      const nodeSchema = processSchemaDescription(
        {
          name: "node",
          observable: true,
          shared_by_name: true,
          properties: [
            { name: "name", type: "identifier" },
            { name: "site", type: "site", observable: true },
          ],
        },
        ctx,
      );
      
      await persistenceImpl.putInstance(rest, "schema", "site", siteSchema as unknown as TransientValue, {});
      await persistenceImpl.putInstance(rest, "schema", "node", nodeSchema as unknown as TransientValue, {});
    },
    
    async seedRegionSchema(rest: string): Promise<void> {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      // Load existing site schema first
      const siteSchemaRaw = await persistenceImpl.getInstance(rest, "schema", "site");
      if (siteSchemaRaw) {
        schemas.set("site", siteSchemaRaw as unknown as NormalizedSchema);
      }
      
      // Region schema - observable, with observable relation to site
      const regionSchema = processSchemaDescription(
        {
          name: "region",
          observable: true,
          shared_by_name: true,
          properties: [
            { name: "name", type: "identifier" },
            { name: "site", type: "site", observable: true },
          ],
        },
        ctx,
      );
      
      await persistenceImpl.putInstance(rest, "schema", "region", regionSchema as unknown as TransientValue, {});
    },
  };

  return persistenceImpl;
}

describe("T078c: related-change notification via observable relations", () => {
  let impl: ReturnType<typeof fakeFormat>;
  let locator: string;

  beforeEach(async () => {
    impl = fakeFormat();
    registerPersistentFormat(impl);
    locator = `${impl.name}:test-observable-relations`;
    try {
      await deleteDataset(locator);
    } catch {
      // Dataset may not exist
    }
  });

  describe("property-level observable constraint validation", () => {
    it("rejects observable on a non-relation property", async () => {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      expect(() =>
        processSchemaDescription(
          {
            name: "BadSchema",
            observable: true,
            properties: [
              { name: "title", type: "string", observable: true },
            ],
          },
          ctx,
        ),
      ).toThrow(/observable.*not a relation/i);
    });

    it("rejects observable relation on a schema that is not schema-level observable", async () => {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      // First create a target schema
      const targetSchema = processSchemaDescription(
        {
          name: "target",
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }],
        },
        ctx,
      );
      schemas.set("target", targetSchema);
      
      // Now try to create a non-observable schema with an observable relation
      expect(() =>
        processSchemaDescription(
          {
            name: "BadSchema",
            // No observable: true at schema level
            shared_by_name: true,
            properties: [
              { name: "name", type: "identifier" },
              { name: "target", type: "target", observable: true },
            ],
          },
          ctx,
        ),
      ).toThrow(/observable.*schema itself is not observable/i);
    });

    it("accepts observable relation on an observable schema", async () => {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      const targetSchema = processSchemaDescription(
        {
          name: "target",
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }],
        },
        ctx,
      );
      schemas.set("target", targetSchema);
      
      const schema = processSchemaDescription(
        {
          name: "GoodSchema",
          observable: true,
          shared_by_name: true,
          properties: [
            { name: "name", type: "identifier" },
            { name: "target", type: "target", observable: true },
          ],
        },
        ctx,
      );
      
      expect(schema.name).toBe("GoodSchema");
      expect(schema.constraints.observable).toBe(true);
      const targetProp = schema.properties.find(p => p.name === "target");
      expect(targetProp?.constraints.observable).toBe(true);
    });
  });

  describe("related-change semantics", () => {
    it("produces via entries when a site changes and nodes point at it", async () => {
      await initDataset(locator, "test");
      const rest = "test-observable-relations";
      await impl.seedNodeSiteSchemas(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      
      // Create a site
      const txId1 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "site",
        input: [{ name: "site1" }],
      });
      await session.commitTransaction(locator, txId1);
      
      changes.length = 0; // Clear site creation notification
      
      // Create nodes pointing at the site
      const txId2 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "node",
        input: [
          { name: "node1", site: "site1" },
          { name: "node2", site: "site1" },
        ],
      });
      await session.commitTransaction(locator, txId2);
      
      changes.length = 0; // Clear node creation notifications
      
      // Now update the site - should trigger via entries for both nodes
      // (the key cannot be updated, so the label changes)
      const txId3 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        update: "site",
        filters: { name: "site1" },
        input: { label: "changed" },
      });
      await session.commitTransaction(locator, txId3);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        const delta = changes[0].changes;
        
        // Should have 1 direct entry (site) + 2 via entries (nodes)
        expect(delta.length).toBe(3);
        
        const siteEntry = delta.find(e => e.schema === "site");
        expect(siteEntry).toBeDefined();
        expect(siteEntry?.via).toBeUndefined();
        
        const nodeEntries = delta.filter(e => e.schema === "node");
        expect(nodeEntries).toHaveLength(2);
        
        for (const entry of nodeEntries) {
          expect(entry.via).toBe("site");
          expect(entry.before).toEqual(entry.after); // Unchanged
          expect((entry.before as TransientObject)?.site).toBe("site1");
        }
      }

      unsubscribe();
    });

    it("does not require the target schema to be observable", async () => {
      await initDataset(locator, "test");
      const rest = "test-observable-relations";
      
      // Seed schemas where site is NOT observable
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { 
        resolveSchema: (n) => schemas.get(n), 
        resolveScalarType: () => undefined 
      };
      
      const siteSchema = processSchemaDescription(
        {
          name: "site",
          // No observable: true
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }, { name: "label", type: "string" }],
        },
        ctx,
      );
      schemas.set("site", siteSchema);
      
      const nodeSchema = processSchemaDescription(
        {
          name: "node",
          observable: true,
          shared_by_name: true,
          properties: [
            { name: "name", type: "identifier" },
            { name: "site", type: "site", observable: true },
          ],
        },
        ctx,
      );
      
      await impl.putInstance(rest, "schema", "site", siteSchema as unknown as TransientValue, {});
      await impl.putInstance(rest, "schema", "node", nodeSchema as unknown as TransientValue, {});

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      
      // Create a site and node
      const txId1 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "site",
        input: [{ name: "site1" }],
      });
      await session.runCommand(locator, {
        create: "node",
        input: [{ name: "node1", site: "site1" }],
      });
      await session.commitTransaction(locator, txId1);
      
      changes.length = 0;
      
      // Update the site - should still trigger via entry for node
      // even though site itself is not observable
      const txId2 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        update: "site",
        filters: { name: "site1" },
        input: { label: "changed" },
      });
      await session.commitTransaction(locator, txId2);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        const delta = changes[0].changes;
        
        // Should have only the via entry for node (site is not observable)
        expect(delta.length).toBe(1);
        expect(delta[0].schema).toBe("node");
        expect(delta[0].via).toBe("site");
      }

      unsubscribe();
    });

    it("does not duplicate entries for directly-touched instances", async () => {
      await initDataset(locator, "test");
      const rest = "test-observable-relations";
      await impl.seedNodeSiteSchemas(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      
      // Create site and node
      const txId1 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "site",
        input: [{ name: "site1" }],
      });
      await session.runCommand(locator, {
        create: "node",
        input: [{ name: "node1", site: "site1" }],
      });
      await session.commitTransaction(locator, txId1);
      
      changes.length = 0;
      
      // Update both the site AND the node in the same transaction
      const txId2 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        update: "site",
        filters: { name: "site1" },
        input: { label: "changed" },
      });
      // Delete and recreate node to trigger a change
      await session.runCommand(locator, {
        delete: "node",
        filters: { name: "node1" },
      });
      await session.runCommand(locator, {
        create: "node",
        input: [{ name: "node1", site: "site1" }],
      });
      await session.commitTransaction(locator, txId2);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        const delta = changes[0].changes;
        
        // Should have 2 entries: site (direct) and node (direct, no via)
        expect(delta.length).toBe(2);
        
        const nodeEntry = delta.find(e => e.schema === "node");
        expect(nodeEntry).toBeDefined();
        expect(nodeEntry?.via).toBeUndefined(); // Direct touch, not via
      }

      unsubscribe();
    });

    it("does not propagate beyond one hop", async () => {
      await initDataset(locator, "test");
      const rest = "test-observable-relations";
      await impl.seedNodeSiteSchemas(rest);
      await impl.seedRegionSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      
      // Create site, node pointing at site, region pointing at site
      const txId1 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "site",
        input: [{ name: "site1" }],
      });
      await session.runCommand(locator, {
        create: "node",
        input: [{ name: "node1", site: "site1" }],
      });
      await session.runCommand(locator, {
        create: "region",
        input: [{ name: "region1", site: "site1" }],
      });
      await session.commitTransaction(locator, txId1);
      
      changes.length = 0;
      
      // Update the site - should trigger via for node and region
      const txId2 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        update: "site",
        filters: { name: "site1" },
        input: { label: "changed" },
      });
      await session.commitTransaction(locator, txId2);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        const delta = changes[0].changes;
        
        // Should have site + node via + region via = 3 entries
        expect(delta.length).toBe(3);
        
        const viaEntries = delta.filter(e => e.via !== undefined);
        expect(viaEntries).toHaveLength(2);
      }
      
      changes.length = 0;
      
      // Now update the node - should NOT trigger via for region
      // (no two-hop propagation)
      // Delete and recreate to trigger a change
      const txId3 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        delete: "node",
        filters: { name: "node1" },
      });
      await session.runCommand(locator, {
        create: "node",
        input: [{ name: "node1", site: "site1" }],
      });
      await session.commitTransaction(locator, txId3);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        const delta = changes[0].changes;
        
        // Should have only the node entry, no via for region
        expect(delta.length).toBe(1);
        expect(delta[0].schema).toBe("node");
        expect(delta[0].via).toBeUndefined();
      }

      unsubscribe();
    });
  });
});
