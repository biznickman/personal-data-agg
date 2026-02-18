import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { inngest } from "../client";
import { supabase } from "@/lib/supabase";

const OPENCLAW_DATA = path.join(
  process.env.HOME || "~",
  ".openclaw/agents"
);

const TRANSCRIPT_DIRS = [
  path.join(OPENCLAW_DATA, "main", "sessions"),
  path.join(OPENCLAW_DATA, "tempo", "sessions"),
  path.join(OPENCLAW_DATA, "x-growth", "sessions"),
  path.join(OPENCLAW_DATA, "byte", "sessions"),
];

function hashMessage(text: string, timestamp: string): string {
  return crypto
    .createHash("sha256")
    .update(`${timestamp}:${text}`)
    .digest("hex")
    .slice(0, 32);
}

function extractTextFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  }
  return "";
}

const SYSTEM_PATTERNS = [
  /^Read HEARTBEAT\.md/,
  /^Pre-compaction memory flush/,
  /^Compaction/,
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^GatewayRestart:/,
  /^System:/,
  /^\[cron:/,
  /^\[Queued (announce )?messages while agent was busy\]/,
  /^Run the X (Story Scan|Viral Check|Video Analytics|News Ingest|Video Transcription)/,
  /^Run a QUICK viral opportunity check/,
  /^Send Nick's morning digest/,
  /^Run the weekly X performance report/,
  /^Run the Miami Events Weekly Scan/,
  /^Run a git backup/,
  /^Morning tasks prep time/,
  /^Evening review time/,
  /^Weekly planning session/,
  /^Run Slack-to-Things integration/,
  /^Daily org summary time/,
  /^Run the message log ingest/,
  /^A background task .* just completed/,
  /^A subagent task .* just completed/,
  /^\[Queued messages while agent was busy\]/,
  /^\[Queued announce messages/,
  /^Agent-to-agent announce/,
  /^\[.*\] Agent Scout/,
  /^Hey Scout/,
  /^✅ \*\*Documented/,
  /^Nick updated the BTC/,
  /^Exec failed/,
  /^\[.*\] Cron:/,
  /^\[cron:/i,
];

function isSystemMessage(text: string): boolean {
  const t = text.trim();
  return SYSTEM_PATTERNS.some((p) => p.test(t));
}

function cleanMessageText(text: string): string {
  return text
    .replace(
      /^Conversation info \(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```\s*/s,
      ""
    )
    .replace(/^\[Telegram Choose Rich Nick[^\]]*\]\s*/s, "")
    .replace(/^\[media attached:[^\]]*\]\s*/s, "")
    .replace(/\s*\[message_id:\s*\d+\]\s*$/s, "")
    .trim();
}

async function readJsonlFile(
  filePath: string
): Promise<{ content: any; timestamp: number }[]> {
  const messages: { content: any; timestamp: number }[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry.type === "message" &&
        entry.message &&
        entry.message.role === "user"
      ) {
        messages.push({
          content: entry.message.content,
          timestamp:
            entry.message.timestamp || new Date(entry.timestamp).getTime(),
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

function findJsonlFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".jsonl")) {
        files.push(path.join(dir, f));
      }
    }
  }
  return files;
}

/**
 * Message Log Ingest — extracts Nick's messages from session transcripts every 30 minutes
 */
export const messageLogIngest = inngest.createFunction(
  {
    id: "message-log-ingest",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    const files = findJsonlFiles(TRANSCRIPT_DIRS);

    // Get existing hashes
    const existingHashList = await step.run("get-existing-hashes", async () => {
      const { data } = await supabase
        .from("message_log")
        .select("message_hash")
        .limit(10000);

      return (data || []).map((r: any) => r.message_hash);
    });

    const result = await step.run("process-transcripts", async () => {
      const hashSet = new Set<string>(existingHashList);
      const newRows: any[] = [];
      let totalScanned = 0;

      for (const file of files) {
        const sessionKey = path.basename(file, ".jsonl");
        try {
          const messages = await readJsonlFile(file);
          totalScanned += messages.length;

          for (const msg of messages) {
            const text = extractTextFromContent(msg.content);
            if (!text || isSystemMessage(text)) continue;

            const cleanText = cleanMessageText(text);
            if (!cleanText) continue;

            const ts = new Date(msg.timestamp).toISOString();
            const hash = hashMessage(cleanText, ts);

            if (hashSet.has(hash)) continue;
            hashSet.add(hash);

            newRows.push({
              timestamp: ts,
              message_text: cleanText.replace(/\u0000/g, "").slice(0, 5000),
              session_key: sessionKey,
              message_hash: hash,
            });
          }
        } catch {
          // Skip unreadable files
        }
      }

      return { newRows, totalScanned, filesProcessed: files.length };
    });

    if (result.newRows.length === 0) {
      return {
        status: "ok",
        scanned: result.totalScanned,
        files: result.filesProcessed,
        inserted: 0,
      };
    }

    const inserted = await step.run("insert-messages", async () => {
      let count = 0;
      for (let i = 0; i < result.newRows.length; i += 50) {
        const batch = result.newRows.slice(i, i + 50);
        const { error } = await supabase
          .from("message_log")
          .upsert(batch, { onConflict: "message_hash" });

        if (!error) count += batch.length;
      }
      return count;
    });

    return {
      status: "ok",
      scanned: result.totalScanned,
      files: result.filesProcessed,
      inserted,
    };
  }
);
