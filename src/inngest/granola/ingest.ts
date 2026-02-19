import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";

// Granola MCP endpoint (Streamable HTTP transport)
const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";

// OAuth tokens — access token + refresh token stored in env vars
// GRANOLA_MCP_ACCESS_TOKEN: current bearer token
// GRANOLA_MCP_REFRESH_TOKEN: long-lived refresh token for renewal
// GRANOLA_MCP_TOKEN_URL: OAuth token endpoint for refresh (from MCP discovery)

let cachedAccessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  const token = process.env.GRANOLA_MCP_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "GRANOLA_MCP_ACCESS_TOKEN env var not set. Run the OAuth flow to obtain tokens."
    );
  }

  // Try the token — if it works, use it
  // If it fails with 401, attempt refresh
  cachedAccessToken = token;
  return token;
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = process.env.GRANOLA_MCP_REFRESH_TOKEN;
  const clientId = process.env.GRANOLA_MCP_CLIENT_ID;

  if (!refreshToken) {
    throw new Error(
      "GRANOLA_MCP_REFRESH_TOKEN not set — cannot refresh expired token. Re-run OAuth flow."
    );
  }

  // Discover the OAuth token endpoint from the MCP server
  const tokenUrl =
    process.env.GRANOLA_MCP_TOKEN_URL ||
    "https://mcp-auth.granola.ai/oauth2/token";

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(clientId ? { client_id: clientId } : {}),
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Token refresh failed: ${res.status} ${txt}. Re-run OAuth flow to get new tokens.`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  cachedAccessToken = data.access_token;

  // Log if we got a new refresh token (would need manual env var update)
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn(
      "⚠️ New refresh token issued — update GRANOLA_MCP_REFRESH_TOKEN env var:",
      data.refresh_token.slice(0, 8) + "..."
    );
  }

  return data.access_token;
}

// ---------- MCP protocol helpers ----------

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: McpToolResult;
  error?: { code: number; message: string };
}

let mcpSessionId: string | null = null;

async function mcpCall(
  method: string,
  params: Record<string, unknown>,
  token: string
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };

  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  let res = await fetch(GRANOLA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Auto-refresh on 401 and retry once
  if (res.status === 401) {
    console.log("Access token expired, attempting refresh...");
    const newToken = await refreshAccessToken();
    headers.Authorization = `Bearer ${newToken}`;
    res = await fetch(GRANOLA_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  // Capture session ID from response
  const sessionHeader = res.headers.get("Mcp-Session-Id");
  if (sessionHeader) {
    mcpSessionId = sessionHeader;
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`MCP request failed: ${res.status} ${txt}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // Handle SSE responses (Streamable HTTP can return text/event-stream)
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData: McpResponse | null = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          lastData = JSON.parse(line.slice(6)) as McpResponse;
        } catch {
          // skip non-JSON lines
        }
      }
    }

    if (!lastData) {
      throw new Error("No valid JSON-RPC response in SSE stream");
    }
    return lastData;
  }

  return (await res.json()) as McpResponse;
}

async function mcpInitialize(token: string): Promise<void> {
  mcpSessionId = null;

  await mcpCall(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ingestion-engine", version: "1.0.0" },
    },
    token
  );

  // Send initialized notification
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

  await fetch(GRANOLA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
}

async function mcpCallTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string
): Promise<string> {
  const response = await mcpCall(
    "tools/call",
    { name: toolName, arguments: args },
    token
  );

  if (response.error) {
    throw new Error(`MCP tool error: ${response.error.message}`);
  }

  const textContent = response.result?.content?.find(
    (c) => c.type === "text" && c.text
  );
  return textContent?.text || "";
}

// ---------- Data types ----------

interface MeetingListItem {
  id: string;
  title?: string;
  date?: string;
  created_at?: string;
  attendees?: Array<{ name?: string; email?: string }>;
}

interface MeetingDetail {
  id: string;
  title?: string;
  created_at?: string;
  summary_text?: string;
  summary_markdown?: string;
  transcript?: Array<{
    speaker?: { name?: string; source?: string };
    text?: string;
    start_time?: string;
    end_time?: string;
  }>;
}

interface VoiceNoteRow {
  granola_id: string;
  title: string;
  created_at: string;
  notes_text: string | null;
  transcript: string | null;
}

// ---------- Transform helpers ----------

function extractTranscriptText(
  transcript?: MeetingDetail["transcript"]
): string | null {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  return transcript
    .map((seg) => {
      const speaker = seg.speaker?.name || seg.speaker?.source || "Speaker";
      return `${speaker}: ${seg.text || ""}`;
    })
    .join("\n")
    .trim();
}

function toVoiceNoteRow(
  meeting: MeetingDetail,
  listItem?: MeetingListItem
): VoiceNoteRow {
  return {
    granola_id: meeting.id,
    title: meeting.title || listItem?.title || "(untitled)",
    created_at:
      meeting.created_at ||
      listItem?.created_at ||
      listItem?.date ||
      new Date().toISOString(),
    notes_text:
      (meeting.summary_markdown || meeting.summary_text || "")
        .replace(/\u0000/g, "")
        .trim() || null,
    transcript: extractTranscriptText(meeting.transcript),
  };
}

// ---------- Main ingestion function ----------

export const granolaIngest = inngest.createFunction(
  {
    id: "granola-ingest",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    try {
      const token = await getAccessToken();

      // Initialize MCP session
      await step.run("mcp-init", async () => {
        await mcpInitialize(token);
      });

      // List recent meetings
      const meetingList = await step.run("list-meetings", async () => {
        const raw = await mcpCallTool("list_meetings", {}, token);

        // MCP tool returns text — could be JSON, XML-like, or natural language
        // Try JSON first
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed as MeetingListItem[];
          if (parsed.meetings) return parsed.meetings as MeetingListItem[];
          if (parsed.notes) return parsed.notes as MeetingListItem[];
          return [parsed] as MeetingListItem[];
        } catch {
          // Not JSON — try parsing XML-like format from Granola MCP
          // Format: <meeting id="..." title="..." date="...">
          const meetings: MeetingListItem[] = [];
          const meetingRegex = /<meeting\s+id="([^"]+)"\s+title="([^"]+)"\s+date="([^"]+)"/g;
          let match;
          while ((match = meetingRegex.exec(raw)) !== null) {
            meetings.push({
              id: match[1],
              title: match[2],
              created_at: new Date(match[3]).toISOString(),
            });
          }

          if (meetings.length > 0) {
            console.log(`Parsed ${meetings.length} meetings from MCP XML response`);
            return meetings;
          }

          console.log("MCP list_meetings returned unparseable format:", raw.slice(0, 300));
          return [] as MeetingListItem[];
        }
      });

      if (meetingList.length === 0) {
        const summary = { status: "ok", fetched: 0, upserted: 0, newCount: 0 };
        await step.run("record-success-empty", async () => {
          await recordFunctionRun({
            functionId: "granola-ingest",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      // Check which meetings already exist in Supabase
      const existingIdList = await step.run("check-existing", async () => {
        const { data, error } = await supabase
          .from("voice_notes")
          .select("granola_id");

        if (error) {
          throw new Error(`Supabase lookup failed: ${error.message}`);
        }

        return (data ?? [])
          .map((row) => row.granola_id)
          .filter((id): id is string => typeof id === "string");
      });

      const existingIds = new Set(existingIdList);

      // Fetch details for each meeting (with transcript)
      const rows = await step.run("fetch-details", async () => {
        const results: VoiceNoteRow[] = [];

        for (const meeting of meetingList) {
          try {
            const detailRaw = await mcpCallTool(
              "query_granola_meetings",
              { query: `Get full details and transcript for meeting ${meeting.id}` },
              token
            );

            // Parse detail — could be JSON, XML-like, or plain text
            let detail: MeetingDetail;
            try {
              const parsed = JSON.parse(detailRaw);
              detail = parsed as MeetingDetail;
            } catch {
              // Use the raw text as the notes/summary content
              // Strip XML tags if present to get clean text
              const cleanText = detailRaw
                .replace(/<[^>]+>/g, "\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

              detail = {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at || meeting.date,
                summary_text: cleanText,
              };
            }

            results.push(toVoiceNoteRow(detail, meeting));
          } catch (err) {
            console.error(`Failed to fetch meeting ${meeting.id}:`, err);
            // Still add basic row from list data
            results.push({
              granola_id: meeting.id,
              title: meeting.title || "(untitled)",
              created_at: meeting.created_at || meeting.date || new Date().toISOString(),
              notes_text: null,
              transcript: null,
            });
          }
        }

        return results;
      });

      // Upsert to Supabase
      const result = await step.run("upsert-notes", async () => {
        const newCount = rows.filter(
          (row) => !existingIds.has(row.granola_id)
        ).length;

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

        return { fetched: rows.length, upserted, newCount };
      });

      const summary = { status: "ok", ...result };

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
