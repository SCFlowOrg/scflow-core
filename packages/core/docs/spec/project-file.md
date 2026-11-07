# The project file

*Feature.*

A project file holds one document: a [dataset](meta-model.md#dataset), the [modules](meta-model.md#module) it uses, and whatever else the tools around it save. Several tools write the same file, and each one knows only part of it, so the file is a sectioned envelope: each owner reads its own section and writes the others back unchanged. This format does not depend on MCL or on a user interface.

```json
{
  "format": "scflow-project",
  "version": 1,
  "type": "acme:tasks",
  "title": "Demo project",
  "modules": { "acme:tasks": { "version": "1.0.0", "digest": "sha256:..." } },
  "model": { "acme:tasks": { "name": "acme:tasks", "namespace": "tasks", "version": "1.0.0" } },
  "data": { "name": "demo", "data_major_version": 1, "data_minor_version": 2, "instances": {} },
  "ui": { "version": 1, "data_version": "1.2", "views": [] }
}
```

## Envelope

The envelope keys are written the same way by every reader.

| Key | Meaning |
| --- | --- |
| `format` | Always `scflow-project` |
| `version` | The version of this format, an integer. A reader refuses a version it does not know |
| `type` | The type of document, as `publisher:type` |
| `title` | The title of the document |

## Sections

Every other top-level key is a **section**.

- A section has one owner, and an owner declares the sections it reads. Two owners cannot declare the same key.
- An owner versions its own section, with a `version` key inside it when it needs one.
- **A reader writes back every section it does not know, unchanged.** Reading and writing a file loses nothing that a reader does not own.

Three sections belong to the document:

| Section | Holds |
| --- | --- |
| `modules` | One entry per module the dataset uses, by module name, with its `version` and `digest` |
| `model` | One entry per module, by module name: its manifest, embedded |
| `data` | The dataset: its `name`, its data versions and its `instances`, by qualified schema name, in the order of their keys |

The **digest** of a module is `sha256:` followed by the lowercase hexadecimal SHA-256 of the canonical form of its manifest: JSON in UTF-8, with the keys of every object sorted and no white space. A reader compares it with the embedded manifest to detect a hand-edited snapshot.

## Shapes

A project has two shapes, which hold the same content.

- **Single file.** One JSON document, which serves for exchange.
- **Folder.** A file `project.json` holds the envelope keys. Each section is a file `<section>.json`, or a sub-folder `<section>/` that its owner organizes. The folder is readable in Git: an upgrade changes `modules.json` and `model.json` in one readable commit, and data diffs stay clean. A reader keeps the files and the sub-folders it does not know.

A writer gives the same content the same bytes, with stable key order, so a change in Git is the change that was made.

## References to data

A section that points to data records the data version of the dataset it was written against, as `data_version`, the text `<major>.<minor>`. When another tool changed the data in between, the owner checks its references on open and drops the dangling ones. Structured data that must stay consistent belongs in `data`, under a module, where actions keep it consistent.

## Sample projects

The `conformance` package gives sample projects in both shapes, with unknown sections, in `samples/project-file`. Every implementation reads them and writes them back without loss.
