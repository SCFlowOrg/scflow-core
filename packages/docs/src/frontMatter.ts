import { docsError } from "./errors.js";
import { validateTopic, type Topic } from "./topic.js";

/** A topic file read: its metadata and its Markdown body. */
export interface ParsedTopic {
  readonly topic: Topic;
  readonly body: string;
}

function scalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~" || text === "") return null;
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** Cuts a trailing ` # comment` that is not inside quotes. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function flowList(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  const items: string[] = [];
  let current = "";
  let quote = "";
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items.map(scalar);
}

/**
 * Reads the YAML subset a topic uses: `key: value` lines with strings,
 * booleans, flow lists `[a, b]` and block lists of `- item` lines, and `#`
 * comments. Anything else is refused, so a topic never depends on a full YAML
 * reader.
 */
export function parseFrontMatterBlock(block: string, where = "topic"): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let list: unknown[] | null = null;
  for (const [index, original] of block.split("\n").entries()) {
    const line = stripComment(original).trimEnd();
    if (line.trim() === "") continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!list) throw docsError("invalid_topic", `${where}: front matter line ${index + 1} is a list item outside a list`);
      list.push(scalar(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair) throw docsError("invalid_topic", `${where}: front matter line ${index + 1} is not "key: value"`);
    const [, key, value] = pair;
    list = null;
    if (key in data) throw docsError("invalid_topic", `${where}: front matter key "${key}" appears twice`);
    if (value === undefined || value.trim() === "") {
      list = [];
      data[key] = list;
    } else if (value.trim().startsWith("[")) {
      if (!value.trim().endsWith("]")) throw docsError("invalid_topic", `${where}: the list of "${key}" must close on its line`);
      data[key] = flowList(value);
    } else data[key] = scalar(value);
  }
  return data;
}

/** Splits a file into its front matter block and its body; fails when there is no front matter. */
export function splitFrontMatter(source: string, where = "topic"): { block: string; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) throw docsError("invalid_topic", `${where}: the file has no front matter between "---" lines`);
  return { block: match[1], body: text.slice(match[0].length).replace(/^\n+/, "") };
}

/** Parses and validates a topic file: front matter and body. Fails with `invalid_topic`. */
export function parseTopic(source: string, where = "topic"): ParsedTopic {
  const { block, body } = splitFrontMatter(source, where);
  return { topic: validateTopic(parseFrontMatterBlock(block, where), where), body };
}
