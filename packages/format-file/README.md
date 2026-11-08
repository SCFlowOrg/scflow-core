# @scfloworg/format-file

The `file` persistent format of MCL: a dataset stored in a [project file](../core/docs/spec/project-file.md), in either shape. An unchanged project saves to identical bytes.

```ts
import { createEngine } from "@scfloworg/core";
import { createFileFormat } from "@scfloworg/format-file";

const file = createFileFormat();
const engine = createEngine({ formats: [file] });

// ... commands on the locator "file:./lyon-plant" ...

await file.save("./lyon-plant");
```

- The `rest` of a locator is the path of the project: a folder, or a single file.
- `@scfloworg/format-file/browser` gives the same format over sections in memory, for a host that keeps the file itself.
- A dataset is read on its first use and held in memory. Only `save` writes the disk, so transactions and undo never touch it.
- See [docs/format-file.md](docs/format-file.md).
