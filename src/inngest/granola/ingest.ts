import fs from "fs";
import path from "path";
import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";

const GRANOLA_CREDS_PATH = path.join(
  process.env.HOME || "~",
  "Library/Application Support/Granola/supabase.json"
);

interface GranolaTokenPayload {
  access_token?: string;
}

interface GranolaCreds {
  workos_tokens?: string | GranolaTokenPayload;
}

interface GranolaTextNode {
  type?: string;
  text?: string;
  content?: GranolaTextNode[];
}

interface GranolaTranscriptSegment {
  speaker?: string;
  text?: string;
}

interface GranolaDoc {
  id: string;
  title?: string;
  created_at?: string;
  notes?: { content?: GranolaTextNode[] };
  transcript?:
    | string
    | {
        text?: string;
        segments?: GranolaTranscriptSegment[];
      };
}

interface GranolaDocsResponse {
  docs?: GranolaDoc[];
  documents?: GranolaDoc[];
}

interface VoiceNoteRow {
  granola_id: string;
  title: string;
  created_at: string;
  notes_text: string | null;
  transcript: string | null;
}

function loadGranolaToken(): string {
  if (!fs.existsSync(GRANOLA_CREDS_PATH)) {
    throw new Error(`Granola credentials not found at ${GRANOLA_CREDS_PATH}`);
  }

  const rawCreds = JSON.parse(fs.readFileSync(GRANOLA_CREDS_PATH, "utf8")) as
    | GranolaCreds
    | undefined;

  const workosTokens = rawCreds?.workos_tokens;
  const parsedTokens: GranolaTokenPayload | undefined =
    typeof workosTokens === "string"
      ? (JSON.parse(workosTokens) as GranolaTokenPayload)
      : workosTokens;

  if (!parsedTokens?.access_token) {
    throw new Error("Granola access token missing from credentials");
  }

  return parsedTokens.access_token;
}

function extractText(doc: GranolaDoc): string {
  const noteContent = doc.notes?.content;
  if (!noteContent) return "";

  const parts: string[] = [];

  function walk(nodes: GranolaTextNode[]): void {
    for (const node of nodes) {
      if (node.type === "text" && node.text) {
        parts.push(node.text);
      }
      if (node.type === "hardBreak") {
        parts.push("\n");
      }
      if (Array.isArray(node.content)) {
        walk(node.content);
      }
      if (
        ["paragraph", "heading", "bulletList", "listItem"].includes(node.type ?? "") &&
        parts.length > 0
      ) {
        parts.push("\n");
      }
    }
  }

  walk(noteContent);
  return parts.join("").trim();
}

function extractTranscript(doc: GranolaDoc): string | null {
  if (!doc.transcript) return null;

  if (typeof doc.transcript === "string") {
    return doc.transcript;
  }

  if (doc.transcript.text) {
    return doc.transcript.text;
  }

  if (Array.isArray(doc.transcript.segments)) {
    return doc.transcript.segments
      .map((segment) => `${segment.speaker || "Speaker"}: ${segment.text || ""}`)
      .join("\n");
  }

  return JSON.stringify(doc.transcript);
}

async function fetchGranolaDocs(token: string): Promise<GranolaDoc[]> {
  const res = await fetch("https://api.granola.ai/v2/get-documents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-client-type": "electron",
      "x-client-version": "7.14.2",
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Granola API: ${res.status} ${txt}`);
  }

  const data = (await res.json()) as GranolaDocsResponse;
  return data.docs || data.documents || [];
}

function toVoiceNoteRow(doc: GranolaDoc): VoiceNoteRow {
  return {
    granola_id: doc.id,
    title: doc.title || "(untitled)",
    created_at: doc.created_at || new Date().toISOString(),
    notes_text: extractText(doc).replace(/\u0000/g, "") || null,
    transcript: extractTranscript(doc)?.replace(/\u0000/g, "") || null,
  };
}

/**
 * Granola Voice Notes Ingest — syncs meeting notes every 30 minutes
 */
export const granolaIngest = inngest.createFunction(
  {
    id: "granola-ingest",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    try {
      const docs = await step.run("fetch-granola-docs", async () => {
        const token = loadGranolaToken();
        return fetchGranolaDocs(token);
      });

      const result = await step.run("upsert-notes", async () => {
        if (docs.length === 0) {
          return { fetched: 0, upserted: 0, newCount: 0 };
        }

        const { data: existingRows, error: existingError } = await supabase
          .from("voice_notes")
          .select("granola_id");

        if (existingError) {
          throw new Error(
            `Supabase existing note lookup failed: ${existingError.message}`
          );
        }

        const existingIds = new Set(
          (existingRows ?? [])
            .map((row) => row.granola_id)
            .filter((id): id is string => typeof id === "string")
        );

        const rows = docs.map(toVoiceNoteRow);
        const newCount = rows.filter((row) => !existingIds.has(row.granola_id))
          .length;

        let upserted = 0;
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error } = await supabase
            .from("voice_notes")
            .upsert(batch, { onConflict: "granola_id" });

          if (error) {
            throw new Error(`Supabase upsert failed: ${error.message}`);
          }

          upserted += batch.length;
        }

        return { fetched: docs.length, upserted, newCount };
      });

      const summary = {
        status: "ok",
        ...result,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "granola-ingest",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "granola-ingest",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
