# @scfloworg/docs

The neutral documentation package: the topic format (Markdown with front
matter), the contract of a documentation source, the catalogue that merges
sources with locale fallback, an audience filter, id and help-key resolution
and a keyword search, the manifest `docs-manifest.json`, and the contract of
the read tool a host hands to an AI.

It depends on no other package and knows no MCL, module, plugin or user
interface. A source is whatever owns documentation; the module source lives in
`@scfloworg/environment`. The use of the package is in [docs/docs.md](docs/docs.md).

```ts
import { createCatalogue, createDocsTool, createMemorySource } from "@scfloworg/docs";

const source = createMemorySource("demo", [
  "---\nid: demo/undo\ntitle: Undo\nsummary: Undo a change.\nkind: how-to\naudience: user\n---\nPress Ctrl+Z.",
]);
const catalogue = await createCatalogue([source]);
await catalogue.search("undo", { audience: "user" });
const tool = createDocsTool(catalogue, { audience: "user" }); // read_docs
```
