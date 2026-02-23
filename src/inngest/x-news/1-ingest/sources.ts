import fs from "fs";
import path from "path";

// Hardcoded source handles — canonical list of X accounts to monitor.
// Update here when adding/removing sources (no longer depends on local filesystem).
const DEFAULT_SOURCES: string[] = [
  "AggrNews",
  "ashcrypto",
  "autismcapital",
  "blockworks_",
  "bobloukas",
  "cointelegraph",
  "cryptohayes",
  "cryptoslate",
  "crypto_briefing",
  "deitaone",
  "decryptmedia",
  "degeneratenews",
  "ericbalchunas",
  "geiger_capital",
  "jseyff",
  "kobeissiletter",
  "luckytraderHQ",
  "messaricrypto",
  "moonoverlord",
  "roundtablespace",
  "solanafloor",
  "techmeme",
  "theblockcampus",
  "theblock__",
  "thestalwart",
  "thetranscript_",
  "treenewsfeed",
  "tyler_did_it",
  "walterbloomberg",
  "watcherguru",
  "whaleinsider",
  "blocknewsdotcom",
  "bubblemaps",
  "coinbureau",
  "coingecko",
  "cryptodotnews",
  "cryptorover",
  "glassnode",
  "intangiblecoins",
  "ramahluwalia",
  "rektmando",
  "scottmelker",
  "solidintel_x",
  "tedtalksmacro",
  "tier10k",
  "tokenterminal",
  "unusual_whales",
  "xdaily",
  "xerocooleth",
  "zachxbt",
];

const SOURCES_FILE = path.join(
  process.env.HOME || "~",
  "clawd/research/x-news-sources.md"
);

export function loadSources(): string[] {
  // Try local file first (for dev/local runs where file may have been updated)
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const md = fs.readFileSync(SOURCES_FILE, "utf8");
      const handles = new Set<string>();
      for (const line of md.split("\n")) {
        const match = line.match(/\|\s*\d+\s*\|\s*@(\w+)/);
        if (match?.[1]) {
          handles.add(match[1].toLowerCase());
        }
      }
      if (handles.size > 0) {
        return Array.from(handles);
      }
    }
  } catch {
    // Fall through to defaults
  }

  // Deployed environment — use hardcoded list
  return [...DEFAULT_SOURCES];
}
