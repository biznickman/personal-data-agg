import fs from "fs";
import path from "path";

const SOURCES_FILE = path.join(
  process.env.HOME || "~",
  "clawd/research/x-news-sources.md"
);

export function loadSources(): string[] {
  const md = fs.readFileSync(SOURCES_FILE, "utf8");
  const handles: string[] = [];
  for (const line of md.split("\n")) {
    const match = line.match(/\|\s*\d+\s*\|\s*@(\w+)/);
    if (match) handles.push(match[1]);
  }
  return handles;
}
