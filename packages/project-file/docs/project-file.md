# Using the project file

The [specification](../../core/docs/spec/project-file.md) gives the format. This page gives the API.

## A project in memory

`Project` is the same for both shapes:

| Field | Holds |
| --- | --- |
| `type`, `title` | The envelope keys that vary |
| `sections` | A `Map` of every section, by key, known or not |
| `files` | The files and sub-folders only the folder shape can hold, by relative path |
| `shape` | The shape it was read from |

`createProject({ type, title })` makes a new one. A host changes `sections` directly.

## Reading and writing

| Function | Entry | Does |
| --- | --- | --- |
| `readSingleFile(text, options?)` | main | Reads the single file |
| `writeSingleFile(project)` | main | Gives its text |
| `readFolder(files, options?)` | main | Reads a `Map` of relative path to bytes |
| `writeFolder(project, options?)` | main | Gives `{ files, removed }` |
| `readProject(path, options?)` | `/node` | Reads a folder or a single file |
| `writeProject(path, project, options?)` | `/node` | Writes, and gives `{ written, removed }` |

`writeProject` writes a folder if `path` is one, or the shape the project was read from, unless `shape` says otherwise. It goes through a temporary file, and it does not touch a file that already holds the right bytes. `.git` and `node_modules` are not read as part of a folder, and stay where they are.

A section key or a folder path is data from a file: `writeFolder` refuses one that would leave the folder.

## Sections

An owner declares its sections in a registry, which refuses two owners of one key:

```ts
const sections = createSectionRegistry([
  {
    key: "ui",
    owner: "documents",
    version: 2,
    migrate: (value, fromVersion) => upgradeUi(value, fromVersion),
  },
]);
```

- `version` and `migrate` run when a section is read: an older section is migrated, and a newer one, or an older one with no `migrate`, is refused.
- `folder` makes the section a sub-folder in the folder shape, with a `read` and a `write` that the owner gives. Without it, the section is `<key>.json`.
- A section nobody declares is read and written as it is.

The digest of a module and the meaning of `modules`, `model` and `data` belong to the workspace: this package only puts those sections first.

## Errors

Every refusal is a `ProjectFileError` with a `code`, as listed in the specification.
