import { describe, it, expect } from "vitest";
import { subscribeObservable } from "../src/index.js";
import type { ObservableChange, ObservableDelta, ObservableListener } from "../src/index.js";

/**
 * Acceptance test: confirms subscribeObservable and its related types
 * are exported from the package's public entry point, not just from an
 * internal file directly.
 */
describe("observability public export", () => {
  it("imports subscribeObservable from the package entry point", () => {
    expect(typeof subscribeObservable).toBe("function");
  });

  it("can use the exported types", () => {
    const listener: ObservableListener = (change: ObservableChange) => {
      if (change.kind === "delta") {
        const delta: ObservableDelta = change.changes;
        expect(Array.isArray(delta)).toBe(true);
      }
    };
    
    // Register and immediately unregister to confirm the API works
    const unsubscribe = subscribeObservable("test:locator", listener);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});
