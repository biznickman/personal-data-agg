import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";

const OPENCLAW_DATA = path.join(process.env.HOME || "~", ".openclaw/agents");

const TRANSCRIPT_DIRS = [
  path.join(OPENCLAW_DATA, "main", "sessions"),
  path.join(OPENCLAW_DATA, "tempo", "sessions"),
  path.join(OPENCLAW_DATA, "x-growth", "sessions"),
  path.join(OPENCLAW_DATA, "byte", "sessions"),
];

type MessageContentPart = {
  type?: string;
  text?: string;
};

interface TranscriptMessage {
  content?: string | MessageContentPart[];
  timestamp?: number;
  role?: string;
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: TranscriptMessage;
}

interface ParsedMessage {
  content: string | MessageContentPart[];
  timestamp: number;
}

interface MessageRow {
  timestamp: string;
  message_text: string;
  session_key: string;
  message_hash: string;
}

function hashMessage(text: string, timestamp: string): string {
  return crypto
    .createHash("sha256")
    .update(`${timestamp}:${text}`)
    .digest("hex")
    .slice(0, 32);
}

function extractTextFromContent(content: string | MessageContentPart[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && !!part.text)
      .map((part) => part.text)
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
  const trimmed = text.trim();
  return SYSTEM_PATTERNS.some((pattern) => pattern.test(trimmed));
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

async function readJsonlFile(filePath: string): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (
        entry.type === "message" &&
        entry.message?.role === "user" &&
        entry.message.content
      ) {
        const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
        const timestamp = entry.message.timestamp ?? fallbackTs;
        if (!Number.isFinite(timestamp)) continue;

        messages.push({
          content: entry.message.content,
          timestamp,
        });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return messages;
}

function findJsonlFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(dir, file));
      }
    }
  }
  return files;
}

async function getExistingMessageHashes(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("message_log")
    .select("message_hash")
    .limit(10000);

  if (error) {
    throw new Error(`Supabase existing hash lookup failed: ${error.message}`);
  }

  return new Set(
    (data ?? [])
      .map((row) => row.message_hash)
      .filter((hash): hash is string => typeof hash === "string")
  );
}

async function insertMessageRows(rows: MessageRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from("message_log")
      .upsert(batch, { onConflict: "message_hash" });

    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    inserted += batch.length;
  }
  return inserted;
}

/**
 * Message Log Ingest — extracts user messages from session transcripts every 30 minutes
 */
export const messageLogIngest = inngest.createFunction(
  {
    id: "message-log-ingest",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    try {
      const files = await step.run("discover-transcripts", async () => {
        return findJsonlFiles(TRANSCRIPT_DIRS);
      });

      const result = await step.run("scan-and-insert", async () => {
        const knownHashes = await getExistingMessageHashes();
        const newRows: MessageRow[] = [];
        let totalScanned = 0;

        for (const file of files) {
          const sessionKey = path.basename(file, ".jsonl");
          try {
            const messages = await readJsonlFile(file);
            totalScanned += messages.length;

            for (const message of messages) {
              const text = extractTextFromContent(message.content);
              if (!text || isSystemMessage(text)) continue;

              const cleanText = cleanMessageText(text);
              if (!cleanText) continue;

              const timestamp = new Date(message.timestamp).toISOString();
              const hash = hashMessage(cleanText, timestamp);
              if (knownHashes.has(hash)) continue;

              knownHashes.add(hash);
              newRows.push({
                timestamp,
                message_text: cleanText.replace(/\u0000/g, "").slice(0, 5000),
                session_key: sessionKey,
                message_hash: hash,
              });
            }
          } catch (error) {
            const errMessage =
              error instanceof Error ? error.message : "Unknown error";
            console.error(`Skipping unreadable transcript ${file}: ${errMessage}`);
          }
        }

        const inserted = newRows.length > 0 ? await insertMessageRows(newRows) : 0;
        return { scanned: totalScanned, files: files.length, inserted };
      });

      const summary = {
        status: "ok",
        ...result,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "message-log-ingest",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "message-log-ingest",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
