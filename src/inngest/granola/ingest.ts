import fs from "fs";
import path from "path";
import { inngest } from "../client";
import { supabase } from "@/lib/supabase";

const GRANOLA_CREDS_PATH = path.join(
  process.env.HOME || "~",
  "Library/Application Support/Granola/supabase.json"
);

function loadGranolaToken(): string {
  if (!fs.existsSync(GRANOLA_CREDS_PATH)) {
    throw new Error(`Granola credentials not found at ${GRANOLA_CREDS_PATH}`);
  }
  const creds = JSON.parse(fs.readFileSync(GRANOLA_CREDS_PATH, "utf8"));
  const wt =
    typeof creds.workos_tokens === "string"
      ? JSON.parse(creds.workos_tokens)
      : creds.workos_tokens;
  return wt.access_token;
}

function extractText(doc: any): string {
  const notes = doc.notes;
  if (!notes || !notes.content) return "";

  const parts: string[] = [];
  function walk(nodes: any[]) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.type === "text" && n.text) parts.push(n.text);
      if (n.type === "hardBreak") parts.push("\n");
      if (n.content) walk(n.content);
      if (
        ["paragraph", "heading", "bulletList", "listItem"].includes(n.type) &&
        parts.length > 0
      ) {
        parts.push("\n");
      }
    }
  }
  walk(notes.content);
  return parts.join("").trim();
}

function extractTranscript(doc: any): string | null {
  if (!doc.transcript) return null;
  if (typeof doc.transcript === "string") return doc.transcript;
  if (doc.transcript.text) return doc.transcript.text;
  if (doc.transcript.segments) {
    return doc.transcript.segments
      .map((s: any) => `${s.speaker || "Speaker"}: ${s.text || ""}`)
      .join("\n");
  }
  return JSON.stringify(doc.transcript);
}

async function fetchGranolaDocs(token: string) {
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

  const data = await res.json();
  return data.docs || data.documents || [];
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
    const docs = await step.run("fetch-granola-docs", async () => {
      const token = loadGranolaToken();
      return fetchGranolaDocs(token);
    });

    if (docs.length === 0) {
      return { status: "ok", fetched: 0, upserted: 0 };
    }

    const result = await step.run("upsert-notes", async () => {
      // Get existing IDs
      const { data: existing } = await supabase
        .from("voice_notes")
        .select("granola_id");

      const existingIds = new Set((existing || []).map((r) => r.granola_id));

      const rows = docs.map((doc: any) => ({
        granola_id: doc.id,
        title: doc.title || "(untitled)",
        created_at: doc.created_at || new Date().toISOString(),
        notes_text: extractText(doc).replace(/\u0000/g, "") || null,
        transcript: extractTranscript(doc)?.replace(/\u0000/g, "") || null,
      }));

      const newCount = rows.filter(
        (r: any) => !existingIds.has(r.granola_id)
      ).length;

      // Upsert in batches
      let upserted = 0;
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase
          .from("voice_notes")
          .upsert(batch, { onConflict: "granola_id" });

        if (error) {
          console.error(`Supabase upsert error: ${error.message}`);
        } else {
          upserted += batch.length;
        }
      }

      return { upserted, newCount };
    });

    return {
      status: "ok",
      fetched: docs.length,
      ...result,
    };
  }
);
