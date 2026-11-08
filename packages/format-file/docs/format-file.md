# The file format

`createFileFormat({ name?, sections? })` gives a `PersistenceInterface` with two additions.

| Member | Does |
| --- | --- |
| `save(rest, { shape? })` | Writes the dataset to its project, and gives `{ written, removed }` |
| `project(rest)` | Gives the `Project` of a dataset already read, to reach its other sections |
| `release(rest)` | Forgets a dataset held in memory, without touching the disk, so its next use reads the disk again |

## Reading and saving

The first use of a `rest` reads the project at that path, and the dataset then lives in memory. Reading again would discard what memory holds, so a change made on disk afterwards is not seen.

`save` puts the state of the dataset in `modules`, `model` and `data`, keeps every other section, and writes only the files whose bytes differ. A new project is saved as a folder, unless its path ends with `.json`.

Files that no reader knows stay as they are on disk at the time of the save, so a tool can change them meanwhile.

## A change made on disk meanwhile

`save` refuses with `project_changed_on_disk` when the sections on disk are not what was last read or written. A difference of formatting only is not a change. Nothing is merged: the host opens the project again.

## Deleting

`deleteDataset` forgets the dataset in memory and leaves the disk alone. A format does not remove a folder that may hold the files of other tools.

## Limits

- Between `save` calls, the changes exist only in memory, and a crash loses them.
- The built-in dataset of an area is never a project on disk.
- `save` is not atomic across the files of a folder.
