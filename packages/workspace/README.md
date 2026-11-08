# @scfloworg/workspace

The workspace of SCFlow: documents, their sections, transactions and undo, over an environment and the `file` format. It has no UI; the CLI and the MCP server each create one.

`@scfloworg/workspace/browser` is the entry of a host that keeps the file itself: documents on sections in memory, with no disk and nothing from Node.

`@scfloworg/workspace/host` gives a host that reads projects from disk its environment, file format, workspace and the modules of a folder.

`doc.addModule(key)` adds an installed module and its missing dependencies to an open document, outside the undo history.

See [docs/workspace.md](docs/workspace.md).
