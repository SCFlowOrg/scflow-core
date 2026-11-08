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

The `data` section is written in a fixed form, so an unchanged dataset gives the same bytes and a change of one instance changes the lines of that instance:

- `name`, `data_major_version` and `data_minor_version` come first, the other properties of the dataset follow sorted by key, and `instances` comes next. Model versions equal to zero are left out.
- Schemas in `instances` are sorted by name, and the instances of a schema by key, each with the keys of every object sorted. A schema with no instance is left out.
- The key of an instance is its `id` when it has one, and its `name` otherwise. An instance stored under another key is written under `other_instances`, by schema and then by key, which is left out when empty.
- The sections `modules` and `model` keep the order of the modules of the dataset.

The **digest** of a module is `sha256:` followed by the lowercase hexadecimal SHA-256 of the canonical form of its manifest: JSON in UTF-8, with the keys of every object sorted and no white space. A reader compares it with the embedded manifest to detect a hand-edited snapshot.

## Shapes

A project has two shapes, which hold the same content.

- **Single file.** One JSON document, which serves for exchange.
- **Folder.** A file `project.json` holds the envelope keys. Each section is a file `<section>.json`, or a sub-folder `<section>/` that its owner organizes. The folder is readable in Git: an upgrade changes `modules.json` and `model.json` in one readable commit, and data diffs stay clean. A reader keeps the files and the sub-folders it does not know.

A file or a sub-folder that no reader knows belongs to the folder: the single file has no place for it, so converting a folder to a single file leaves it out. A file `<section>.json` that does not hold valid JSON and whose section nobody declares is such a file.

A section key that cannot name a file, or the key `project`, cannot be written in the folder shape, and the writer refuses it. A folder file is never written outside the folder.

### Bytes

A writer gives the same content the same bytes, with stable key order, so a change in Git is the change that was made.

- JSON is written with two spaces of indentation, line feeds and one final line feed.
- The envelope keys come first, in the order of the table above. The sections follow: `modules`, `model` and `data`, then the others sorted by key, by code unit. The keys inside a section stay in the order its owner gives them.
- **What did not change keeps its bytes.** A file read and written back with the same content is written with the bytes it was read with, even when another writer formatted it differently. In the folder shape this holds for each file on its own, so a change of one section touches one file.

### Errors

| Exception | Thrown when |
| --- | --- |
| `not_a_project` | The `format` is not `scflow-project`, or the folder has no `project.json` |
| `unsupported_version` | The `version` of the format is not known to the reader |
| `invalid_project` | The JSON of the envelope or of a declared section is not valid, the `type` or the `title` is missing, or `project.json` holds a key that is not an envelope key |
| `section_clash` | Two owners declare the same section |
| `unsupported_section_version` | A declared section has a version newer than its owner's, or an older one that its owner cannot migrate |
| `invalid_section_key` | A section key cannot be written in the folder shape |
| `invalid_file_path` | The path of a folder file leaves the folder |

## References to data

A section that points to data records the data version of the dataset it was written against, as `data_version`, the text `<major>.<minor>`. When another tool changed the data in between, the owner checks its references on open and drops the dangling ones. Structured data that must stay consistent belongs in `data`, under a module, where actions keep it consistent.

## Sample projects

The `conformance` package gives sample projects in both shapes, with unknown sections, in `samples/project-file`. Every implementation reads them and writes them back without loss.
