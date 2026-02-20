import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";

// Granola MCP endpoint (Streamable HTTP transport)
const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
const GRANOLA_DEFAULT_TOKEN_URL = "https://mcp-auth.granola.ai/oauth2/token";
// Auth values are read from app_settings first, then env vars as fallback.

type GranolaSettingKey =
  | "granola_mcp_access_token"
  | "granola_mcp_refresh_token"
  | "granola_mcp_client_id"
  | "granola_mcp_token_url";

const GRANOLA_SETTING_KEYS: GranolaSettingKey[] = [
  "granola_mcp_access_token",
  "granola_mcp_refresh_token",
  "granola_mcp_client_id",
  "granola_mcp_token_url",
];

interface GranolaAuthConfig {
  accessToken: string | null;
  refreshToken: string | null;
  clientId: string | null;
  tokenUrl: string;
}

interface AppSettingRow {
  setting_key: string;
  setting_value: string | null;
}

let cachedAccessToken: string | null = null;
let cachedGranolaAuth: GranolaAuthConfig | null = null;

function normalizeSettingValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function loadGranolaSettings(): Promise<Partial<Record<GranolaSettingKey, string>>> {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("setting_key,setting_value")
      .in("setting_key", GRANOLA_SETTING_KEYS);

    if (error) {
      throw new Error(error.message);
    }

    const settings: Partial<Record<GranolaSettingKey, string>> = {};
    for (const row of (data ?? []) as AppSettingRow[]) {
      if (!GRANOLA_SETTING_KEYS.includes(row.setting_key as GranolaSettingKey)) {
        continue;
      }

      const value = normalizeSettingValue(row.setting_value);
      if (!value) continue;

      settings[row.setting_key as GranolaSettingKey] = value;
    }

    return settings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Unable to load Granola settings from app_settings, falling back to env vars: ${message}`);
    return {};
  }
}

async function getGranolaAuthConfig(forceReload = false): Promise<GranolaAuthConfig> {
  if (cachedGranolaAuth && !forceReload) {
    return cachedGranolaAuth;
  }

  const dbSettings = await loadGranolaSettings();

  const accessToken =
    normalizeSettingValue(dbSettings.granola_mcp_access_token) ||
    normalizeSettingValue(process.env.GRANOLA_MCP_ACCESS_TOKEN);
  const refreshToken =
    normalizeSettingValue(dbSettings.granola_mcp_refresh_token) ||
    normalizeSettingValue(process.env.GRANOLA_MCP_REFRESH_TOKEN);
  const clientId =
    normalizeSettingValue(dbSettings.granola_mcp_client_id) ||
    normalizeSettingValue(process.env.GRANOLA_MCP_CLIENT_ID);
  const tokenUrl =
    normalizeSettingValue(dbSettings.granola_mcp_token_url) ||
    normalizeSettingValue(process.env.GRANOLA_MCP_TOKEN_URL) ||
    GRANOLA_DEFAULT_TOKEN_URL;

  cachedGranolaAuth = {
    accessToken,
    refreshToken,
    clientId,
    tokenUrl,
  };

  return cachedGranolaAuth;
}

async function persistGranolaAuthConfig(config: GranolaAuthConfig): Promise<void> {
  const rows = [
    {
      setting_key: "granola_mcp_access_token",
      setting_value: config.accessToken,
      is_secret: true,
      description: "Granola MCP access token",
    },
    {
      setting_key: "granola_mcp_refresh_token",
      setting_value: config.refreshToken,
      is_secret: true,
      description: "Granola MCP refresh token",
    },
    {
      setting_key: "granola_mcp_client_id",
      setting_value: config.clientId,
      is_secret: false,
      description: "Granola MCP OAuth client id",
    },
    {
      setting_key: "granola_mcp_token_url",
      setting_value: config.tokenUrl,
      is_secret: false,
      description: "Granola MCP OAuth token endpoint",
    },
  ].filter((row) => normalizeSettingValue(row.setting_value) !== null);

  if (rows.length === 0) return;

  try {
    const { error } = await supabase
      .from("app_settings")
      .upsert(rows, { onConflict: "setting_key" });
    if (error) {
      throw new Error(error.message);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to persist Granola auth settings to app_settings: ${message}`);
  }
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  const auth = await getGranolaAuthConfig();
  if (!auth.accessToken) {
    if (auth.refreshToken) {
      console.log("No Granola access token found; refreshing from stored refresh token...");
      return refreshAccessToken();
    }

    throw new Error(
      "Granola MCP access token not set. Configure app_settings.granola_mcp_access_token or GRANOLA_MCP_ACCESS_TOKEN."
    );
  }

  cachedAccessToken = auth.accessToken;
  return auth.accessToken;
}

async function refreshAccessToken(): Promise<string> {
  const auth = await getGranolaAuthConfig(true);
  const refreshToken = auth.refreshToken;
  const clientId = auth.clientId;

  if (!refreshToken) {
    throw new Error(
      "Granola MCP refresh token not set — configure app_settings.granola_mcp_refresh_token or GRANOLA_MCP_REFRESH_TOKEN."
    );
  }

  const tokenUrl = auth.tokenUrl || GRANOLA_DEFAULT_TOKEN_URL;

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

  const nextConfig: GranolaAuthConfig = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    clientId,
    tokenUrl,
  };

  cachedAccessToken = data.access_token;
  cachedGranolaAuth = nextConfig;
  await persistGranolaAuthConfig(nextConfig);

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn(
      "⚠️ New refresh token issued — persisted to app_settings:",
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitMessage(message: string): boolean {
  return /rate limit|too many requests|please slow down/i.test(message);
}

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

  if (response.result?.isError) {
    const text = response.result.content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    throw new Error(`MCP tool ${toolName} returned error: ${text || "Unknown tool error"}`);
  }

  const textContent = response.result?.content?.find(
    (c) => c.type === "text" && c.text
  );
  return textContent?.text || "";
}

async function mcpCallToolWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<string> {
  const maxAttempts = options?.maxAttempts ?? 4;
  const baseDelayMs = options?.baseDelayMs ?? 750;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const text = await mcpCallTool(toolName, args, token);
      if (isRateLimitMessage(text)) {
        throw new Error(text);
      }
      return text;
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(typeof err === "string" ? err : "Unknown MCP error");
      lastError = error;

      if (!isRateLimitMessage(error.message) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `Rate limited on ${toolName}; retrying (${attempt}/${maxAttempts}) in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error(`Failed to call ${toolName}`);
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
  private_notes?: string;
  summary?: string;
  summary_text?: string;
  summary_markdown?: string;
}

interface ExistingVoiceNote {
  granola_id: string;
  notes_text: string | null;
  transcript: string | null;
}

interface VoiceNoteRow {
  granola_id: string;
  title: string;
  created_at: string;
  notes_text: string | null;
  transcript: string | null;
}

// ---------- Transform helpers ----------

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const clean = value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return clean.length > 0 ? clean : null;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseDateToIso(dateLike?: string): string | null {
  if (!dateLike) return null;
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTagContent(raw: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = regex.exec(raw);
  if (!match) return null;
  return normalizeText(decodeXmlEntities(match[1]));
}

function extractMeetingAttrs(attrText: string): {
  id: string | null;
  title: string | null;
  date: string | null;
} {
  const id = /\bid="([^"]+)"/i.exec(attrText)?.[1] ?? null;
  const title = /\btitle="([^"]*)"/i.exec(attrText)?.[1] ?? null;
  const date = /\bdate="([^"]+)"/i.exec(attrText)?.[1] ?? null;
  return { id, title, date };
}

function parseMeetingList(raw: string): MeetingListItem[] {
  const parsed = parseJson<unknown>(raw);
  if (parsed) {
    const source =
      Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? Array.isArray((parsed as { meetings?: unknown[] }).meetings)
            ? ((parsed as { meetings: unknown[] }).meetings ?? [])
            : Array.isArray((parsed as { notes?: unknown[] }).notes)
              ? ((parsed as { notes: unknown[] }).notes ?? [])
              : [parsed]
          : [];

    const list: MeetingListItem[] = [];
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : null;
      if (!id) continue;

      const title = typeof obj.title === "string" ? obj.title : undefined;
      const createdAt =
        typeof obj.created_at === "string"
          ? obj.created_at
          : typeof obj.date === "string"
            ? parseDateToIso(obj.date) || obj.date
            : undefined;
      const date = typeof obj.date === "string" ? obj.date : undefined;
      list.push({ id, title, created_at: createdAt, date });
    }

    if (list.length > 0) {
      return list;
    }
  }

  const list: MeetingListItem[] = [];
  const seen = new Set<string>();
  const meetingRegex = /<meeting\b([^>]*)>/gi;

  let match: RegExpExecArray | null;
  while ((match = meetingRegex.exec(raw)) !== null) {
    const attrs = extractMeetingAttrs(match[1] ?? "");
    if (!attrs.id || seen.has(attrs.id)) continue;
    seen.add(attrs.id);

    list.push({
      id: attrs.id,
      title: attrs.title ?? undefined,
      date: attrs.date ?? undefined,
      created_at: parseDateToIso(attrs.date ?? undefined) ?? undefined,
    });
  }

  return list;
}

function parseMeetingDetails(raw: string): MeetingDetail[] {
  const parsed = parseJson<unknown>(raw);
  if (parsed) {
    const source =
      Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? Array.isArray((parsed as { meetings?: unknown[] }).meetings)
            ? ((parsed as { meetings: unknown[] }).meetings ?? [])
            : Array.isArray((parsed as { notes?: unknown[] }).notes)
              ? ((parsed as { notes: unknown[] }).notes ?? [])
              : [parsed]
          : [];

    const details: MeetingDetail[] = [];
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : null;
      if (!id) continue;

      details.push({
        id,
        title: typeof obj.title === "string" ? obj.title : undefined,
        created_at:
          typeof obj.created_at === "string"
            ? obj.created_at
            : typeof obj.date === "string"
              ? parseDateToIso(obj.date) || obj.date
              : undefined,
        private_notes:
          typeof obj.private_notes === "string"
            ? obj.private_notes
            : undefined,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
        summary_text:
          typeof obj.summary_text === "string" ? obj.summary_text : undefined,
        summary_markdown:
          typeof obj.summary_markdown === "string"
            ? obj.summary_markdown
            : undefined,
      });
    }

    if (details.length > 0) {
      return details;
    }
  }

  const details: MeetingDetail[] = [];
  const meetingRegex = /<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/gi;

  let match: RegExpExecArray | null;
  while ((match = meetingRegex.exec(raw)) !== null) {
    const attrs = extractMeetingAttrs(match[1] ?? "");
    if (!attrs.id) continue;

    const body = match[2] ?? "";
    details.push({
      id: attrs.id,
      title: attrs.title ?? undefined,
      created_at: parseDateToIso(attrs.date ?? undefined) ?? undefined,
      private_notes: extractTagContent(body, "private_notes") ?? undefined,
      summary: extractTagContent(body, "summary") ?? undefined,
    });
  }

  return details;
}

function parseTranscriptText(raw: string): string | null {
  const parsed = parseJson<unknown>(raw);
  if (parsed && typeof parsed === "object") {
    const transcript = (parsed as { transcript?: unknown }).transcript;
    if (typeof transcript === "string") {
      const clean = normalizeText(transcript);
      if (!clean || /^no transcript$/i.test(clean) || isRateLimitMessage(clean)) {
        return null;
      }
      return clean;
    }
  }

  const xmlTranscript = extractTagContent(raw, "transcript");
  if (xmlTranscript) {
    if (/^no transcript$/i.test(xmlTranscript) || isRateLimitMessage(xmlTranscript)) {
      return null;
    }
    return xmlTranscript;
  }

  // Do not persist arbitrary plain-text fallbacks from the MCP tool.
  // These are often error/status strings (e.g. rate limiting), not transcript.
  return null;
}

function buildNotesText(meeting: MeetingDetail): string | null {
  const summary = normalizeText(
    meeting.summary_markdown || meeting.summary_text || meeting.summary
  );
  const privateNotes = normalizeText(meeting.private_notes);

  const parts: string[] = [];
  if (summary && !/^no summary$/i.test(summary)) {
    parts.push(summary);
  }
  if (
    privateNotes &&
    !/^no private notes$/i.test(privateNotes) &&
    privateNotes !== summary
  ) {
    parts.push(privateNotes);
  }

  return normalizeText(parts.join("\n\n"));
}

function looksLikeFallbackAssistantText(text: string | null): boolean {
  if (!text) return false;
  return (
    /i don't (see|have access to).+meeting/i.test(text) ||
    /meetings (available|i have access)/i.test(text)
  );
}

function toVoiceNoteRow(
  meeting: MeetingDetail,
  listItem: MeetingListItem | undefined,
  transcriptText: string | null,
  existing?: ExistingVoiceNote
): VoiceNoteRow {
  const notes = buildNotesText(meeting);

  return {
    granola_id: meeting.id,
    title: meeting.title || listItem?.title || "(untitled)",
    created_at:
      meeting.created_at ||
      listItem?.created_at ||
      listItem?.date ||
      new Date().toISOString(),
    notes_text: notes ?? existing?.notes_text ?? null,
    transcript: transcriptText ?? existing?.transcript ?? null,
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
        const startDate = process.env.GRANOLA_MCP_START_DATE || "2020-01-01";
        const endDate = new Date().toISOString().slice(0, 10);

        const raw = await mcpCallToolWithRetry(
          "list_meetings",
          {
            time_range: "custom",
            custom_start: startDate,
            custom_end: endDate,
          },
          token
        );

        const meetings = parseMeetingList(raw);
        if (meetings.length > 0) {
          console.log(
            `Discovered ${meetings.length} meetings from list_meetings (${startDate} to ${endDate})`
          );
          return meetings;
        }

        console.log("list_meetings returned unparseable format:", raw.slice(0, 300));
        return [] as MeetingListItem[];
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
      const existingRows = await step.run("check-existing", async () => {
        const { data, error } = await supabase
          .from("voice_notes")
          .select("granola_id,notes_text,transcript");

        if (error) {
          throw new Error(`Supabase lookup failed: ${error.message}`);
        }

        return (data ?? [])
          .map((row) => ({
            granola_id:
              typeof row.granola_id === "string" ? row.granola_id : null,
            notes_text:
              typeof row.notes_text === "string" ? row.notes_text : null,
            transcript:
              typeof row.transcript === "string" ? row.transcript : null,
          }))
          .filter((row): row is ExistingVoiceNote => row.granola_id !== null);
      });

      const existingById = new Map(
        existingRows.map((row) => [row.granola_id, row])
      );
      const existingIds = new Set(existingRows.map((row) => row.granola_id));

      // Fetch only missing or incomplete rows; this avoids rewriting all rows every run.
      const meetingsToFetch = meetingList.filter((meeting) => {
        const existing = existingById.get(meeting.id);
        if (!existing) return true;
        if (!existing.notes_text || looksLikeFallbackAssistantText(existing.notes_text)) {
          return true;
        }
        if (!existing.transcript) return true;
        return false;
      });

      // Fetch details for each meeting (with transcript)
      const rows = await step.run("fetch-details", async () => {
        if (meetingsToFetch.length === 0) {
          return [] as VoiceNoteRow[];
        }

        const results: VoiceNoteRow[] = [];
        const detailBatchSize = 10;
        const transcriptDelayMs = Number.parseInt(
          process.env.GRANOLA_MCP_TRANSCRIPT_DELAY_MS || "300",
          10
        );

        for (let i = 0; i < meetingsToFetch.length; i += detailBatchSize) {
          const batchMeetings = meetingsToFetch.slice(i, i + detailBatchSize);
          const batchIds = batchMeetings.map((meeting) => meeting.id);

          const detailById = new Map<string, MeetingDetail>();
          try {
            const detailRaw = await mcpCallToolWithRetry(
              "get_meetings",
              { meeting_ids: batchIds },
              token
            );
            const parsedDetails = parseMeetingDetails(detailRaw);
            for (const detail of parsedDetails) {
              detailById.set(detail.id, detail);
            }
          } catch (err) {
            console.error(
              `Failed to fetch get_meetings batch (${batchIds.join(",")}):`,
              err
            );
          }

          for (const meeting of batchMeetings) {
            const detail = detailById.get(meeting.id) ?? {
              id: meeting.id,
              title: meeting.title,
              created_at: meeting.created_at || meeting.date,
            };

            let transcriptText: string | null = null;
            try {
              if (transcriptDelayMs > 0) {
                await sleep(transcriptDelayMs);
              }
              const transcriptRaw = await mcpCallToolWithRetry(
                "get_meeting_transcript",
                { meeting_id: meeting.id },
                token,
                { maxAttempts: 5, baseDelayMs: 1000 }
              );
              transcriptText = parseTranscriptText(transcriptRaw);
            } catch (err) {
              console.error(`Failed to fetch transcript for meeting ${meeting.id}:`, err);
            }

            const existing = existingById.get(meeting.id);
            results.push(toVoiceNoteRow(detail, meeting, transcriptText, existing));
          }
        }

        return results;
      });

      // Upsert to Supabase
      const result = await step.run("upsert-notes", async () => {
        const newCount = rows.filter((row) => !existingIds.has(row.granola_id)).length;
        const discovered = meetingList.length;
        const attempted = meetingsToFetch.length;

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

        return { discovered, attempted, fetched: rows.length, upserted, newCount };
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
