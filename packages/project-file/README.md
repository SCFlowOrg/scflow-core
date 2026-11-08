# @scfloworg/project-file

The SCFlow project file: a sectioned envelope that several tools write, each one knowing only its own part. The package has no dependency, no MCL and no UI, so the framework can use it as well as the workspace.

The format is specified in [project-file.md](../core/docs/spec/project-file.md). See [docs/project-file.md](docs/project-file.md) for the API.

```ts
import { createSectionRegistry, readSingleFile, writeSingleFile } from "@scfloworg/project-file";
import { readProject, writeProject } from "@scfloworg/project-file/node";

const sections = createSectionRegistry([{ key: "ui", owner: "documents", version: 1 }]);

const project = await readProject("./lyon-plant", { sections });
project.sections.set("ui", { version: 1, views: [] });
await writeProject("./lyon-plant", project, { sections });
```

- The main entry does no input or output and runs in a browser. `@scfloworg/project-file/node` reads and writes the disk.
- A reader keeps every section, file and sub-folder it does not know.
- What did not change keeps its bytes.
