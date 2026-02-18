import fs from "fs";
import path from "path";

const SOURCES_FILE = path.join(
  process.env.HOME || "~",
  "clawd/research/x-news-sources.md"
);

export function loadSources(): string[] {
  if (!fs.existsSync(SOURCES_FILE)) {
    throw new Error(`Sources file not found: ${SOURCES_FILE}`);
  }

  const md = fs.readFileSync(SOURCES_FILE, "utf8");
  const handles = new Set<string>();
  for (const line of md.split("\n")) {
    const match = line.match(/\|\s*\d+\s*\|\s*@(\w+)/);
    if (match?.[1]) {
      handles.add(match[1].toLowerCase());
    }
  }

  return Array.from(handles);
}
