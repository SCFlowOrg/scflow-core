#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProjectHost } from "@scfloworg/workspace/host";
import { createMcpServer } from "./index.js";

const args = process.argv.slice(2);
const flag = args.indexOf("--modules");
const modules = flag >= 0 ? args[flag + 1] : undefined;
const path = args.find((_, index) => flag < 0 || (index !== flag && index !== flag + 1));

if (path === undefined || (flag >= 0 && modules === undefined)) {
  console.error("usage: scflow-mcp <project> [--modules <folder>]");
  process.exitCode = 2;
} else {
  const server = await createMcpServer({ host: await createProjectHost({ modules }), path });
  await server.connect(new StdioServerTransport());
}
