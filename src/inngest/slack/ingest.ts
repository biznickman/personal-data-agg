import { supabase } from "@/lib/supabase";
import { inngest } from "../client";
import { recordFunctionRun } from "../run-status";

const SLACK_API_BASE_URL = "https://slack.com/api";
const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_LOOKBACK_MINUTES = 240;
const DEFAULT_MAX_PAGES_PER_CHANNEL = 10;
const SUPABASE_BATCH_SIZE = 100;
const SLACK_MAX_RETRIES = 5;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1000;

interface SlackResponseEnvelope {
  ok: boolean;
  error?: string;
}

interface SlackChannelInfo {
  id?: string;
  name?: string;
}

interface SlackConversationInfoResponse extends SlackResponseEnvelope {
  channel?: SlackChannelInfo;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

interface SlackHistoryResponse extends SlackResponseEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackIngestConfig {
  token: string;
  channelIds: string[];
  pageLimit: number;
  lookbackMinutes: number;
  maxPagesPerChannel: number;
}

interface SlackMessageRow {
  slack_message_id: string;
  channel_id: string;
  channel_name: string | null;
  message_ts: string;
  message_ts_numeric: number;
  message_time: string;
  thread_ts: string | null;
  user_id: string | null;
  bot_id: string | null;
  message_type: string | null;
  subtype: string | null;
  is_thread_parent: boolean;
  reply_count: number;
  latest_reply_ts: string | null;
  message_text: string | null;
  raw: Record<string, unknown>;
}

interface ChannelIngestSummary {
  channel_id: string;
  channel_name: string | null;
  since_ts: number;
  pages_fetched: number;
  messages_fetched: number;
  messages_transformed: number;
  rows_upserted: number;
}

interface LatestMessageRow {
  message_ts_numeric: unknown;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getSlackConfig(): SlackIngestConfig {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing SLACK_BOT_TOKEN");
  }

  const rawChannelIds =
    process.env.SLACK_CHANNEL_IDS || process.env.SLACK_CHANNELS || "";
  const channelIds = Array.from(
    new Set(
      rawChannelIds
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );

  if (channelIds.length === 0) {
    throw new Error(
      "Missing Slack channels. Set SLACK_CHANNEL_IDS to a comma-separated list of channel IDs."
    );
  }

  const pageLimit = Math.min(
    200,
    parsePositiveInteger(process.env.SLACK_HISTORY_PAGE_LIMIT, DEFAULT_PAGE_LIMIT)
  );
  const lookbackMinutes = parsePositiveInteger(
    process.env.SLACK_LOOKBACK_MINUTES,
    DEFAULT_LOOKBACK_MINUTES
  );
  const maxPagesPerChannel = parsePositiveInteger(
    process.env.SLACK_MAX_PAGES_PER_CHANNEL,
    DEFAULT_MAX_PAGES_PER_CHANNEL
  );

  return {
    token,
    channelIds,
    pageLimit,
    lookbackMinutes,
    maxPagesPerChannel,
  };
}

function parseSlackTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Number.parseFloat(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toSlackTimestampString(timestamp: number): string {
  return timestamp.toFixed(6);
}

function cleanMessageText(text: string | undefined): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/\u0000/g, "").trim();
  if (!clean) return null;
  return clean.slice(0, 15000);
}

function toSlackMessageRow(
  channelId: string,
  channelName: string | null,
  message: SlackMessage
): SlackMessageRow | null {
  // Hidden entries are Slack-internal artifacts and not useful for triage.
  if (message.hidden === true) {
    return null;
  }

  const messageTs =
    typeof message.ts === "string" && message.ts.trim().length > 0
      ? message.ts
      : null;
  if (!messageTs) return null;

  const messageTsNumeric = parseSlackTimestamp(messageTs);
  if (messageTsNumeric === null) return null;

  const messageDate = new Date(messageTsNumeric * 1000);
  if (Number.isNaN(messageDate.getTime())) return null;

  const threadTs =
    typeof message.thread_ts === "string" && message.thread_ts.trim().length > 0
      ? message.thread_ts
      : null;
  const replyCount =
    typeof message.reply_count === "number" &&
    Number.isFinite(message.reply_count) &&
    message.reply_count > 0
      ? Math.trunc(message.reply_count)
      : 0;
  const latestReplyTs =
    typeof message.latest_reply === "string" && message.latest_reply.trim().length > 0
      ? message.latest_reply
      : null;

  return {
    slack_message_id: `${channelId}:${messageTs}`,
    channel_id: channelId,
    channel_name: channelName,
    message_ts: messageTs,
    message_ts_numeric: messageTsNumeric,
    message_time: messageDate.toISOString(),
    thread_ts: threadTs,
    user_id: typeof message.user === "string" ? message.user : null,
    bot_id: typeof message.bot_id === "string" ? message.bot_id : null,
    message_type: typeof message.type === "string" ? message.type : null,
    subtype: typeof message.subtype === "string" ? message.subtype : null,
    is_thread_parent:
      replyCount > 0 && (!threadTs || threadTs === messageTs),
    reply_count: replyCount,
    latest_reply_ts: latestReplyTs,
    message_text: cleanMessageText(message.text),
    raw: message,
  };
}

function getRateLimitDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackGet<T extends SlackResponseEnvelope>(
  token: string,
  method: string,
  params: URLSearchParams,
  attempt = 1
): Promise<T> {
  const url = `${SLACK_API_BASE_URL}/${method}?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 429) {
    if (attempt >= SLACK_MAX_RETRIES) {
      throw new Error(`Slack ${method} hit rate limit after ${attempt} attempts`);
    }

    const delayMs = getRateLimitDelayMs(response) + 250;
    await sleep(delayMs);
    return slackGet(token, method, params, attempt + 1);
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Slack ${method} failed (${response.status}): ${bodyText}`);
  }

  const payload = (await response.json()) as T;
  if (!payload.ok) {
    if (payload.error === "ratelimited" && attempt < SLACK_MAX_RETRIES) {
      await sleep(DEFAULT_RATE_LIMIT_WAIT_MS * attempt);
      return slackGet(token, method, params, attempt + 1);
    }

    throw new Error(`Slack ${method} returned error: ${payload.error || "unknown_error"}`);
  }

  return payload;
}

async function getChannelName(token: string, channelId: string): Promise<string | null> {
  const params = new URLSearchParams({
    channel: channelId,
    include_num_members: "false",
  });

  const response = await slackGet<SlackConversationInfoResponse>(
    token,
    "conversations.info",
    params
  );

  if (typeof response.channel?.name !== "string" || !response.channel.name.trim()) {
    return null;
  }

  return response.channel.name.trim();
}

async function getLatestMessageTimestamp(channelId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("slack_messages")
    .select("message_ts_numeric")
    .eq("channel_id", channelId)
    .order("message_ts_numeric", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase latest timestamp lookup failed for ${channelId}: ${error.message}`);
  }

  const row = (data ?? null) as LatestMessageRow | null;
  if (!row || typeof row.message_ts_numeric !== "number") {
    return null;
  }

  return Number.isFinite(row.message_ts_numeric) ? row.message_ts_numeric : null;
}

async function upsertSlackMessages(rows: SlackMessageRow[]): Promise<number> {
  let upserted = 0;

  for (let i = 0; i < rows.length; i += SUPABASE_BATCH_SIZE) {
    const batch = rows.slice(i, i + SUPABASE_BATCH_SIZE);
    const { error } = await supabase
      .from("slack_messages")
      .upsert(batch, { onConflict: "slack_message_id" });

    if (error) {
      throw new Error(`Supabase upsert failed for slack_messages: ${error.message}`);
    }

    upserted += batch.length;
  }

  return upserted;
}

export const slackIngest = inngest.createFunction(
  {
    id: "slack-ingest",
    retries: 2,
  },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    try {
      const config = getSlackConfig();

      const summary = await step.run("fetch-and-upsert-slack", async () => {
        const channelSummaries: ChannelIngestSummary[] = [];
        const nowSeconds = Date.now() / 1000;

        for (const channelId of config.channelIds) {
          const channelName = await getChannelName(config.token, channelId);
          const latestKnownTs = await getLatestMessageTimestamp(channelId);
          const sinceTs =
            latestKnownTs ?? nowSeconds - config.lookbackMinutes * 60;
          const oldest = toSlackTimestampString(sinceTs);

          const rows: SlackMessageRow[] = [];
          let messagesFetched = 0;
          let pagesFetched = 0;
          let cursor: string | null = null;

          while (pagesFetched < config.maxPagesPerChannel) {
            const params = new URLSearchParams({
              channel: channelId,
              limit: String(config.pageLimit),
              oldest,
              inclusive: "false",
            });

            if (cursor) {
              params.set("cursor", cursor);
            }

            const response = await slackGet<SlackHistoryResponse>(
              config.token,
              "conversations.history",
              params
            );

            const messages = Array.isArray(response.messages)
              ? response.messages
              : [];
            messagesFetched += messages.length;
            pagesFetched += 1;

            for (const message of messages) {
              const row = toSlackMessageRow(channelId, channelName, message);
              if (!row) continue;
              rows.push(row);
            }

            const nextCursor =
              typeof response.response_metadata?.next_cursor === "string"
                ? response.response_metadata.next_cursor.trim()
                : "";

            if (!response.has_more || nextCursor.length === 0) {
              break;
            }

            cursor = nextCursor;
          }

          const rowsUpserted = rows.length > 0 ? await upsertSlackMessages(rows) : 0;

          channelSummaries.push({
            channel_id: channelId,
            channel_name: channelName,
            since_ts: sinceTs,
            pages_fetched: pagesFetched,
            messages_fetched: messagesFetched,
            messages_transformed: rows.length,
            rows_upserted: rowsUpserted,
          });
        }

        const totals = channelSummaries.reduce(
          (acc, current) => {
            acc.pages_fetched += current.pages_fetched;
            acc.messages_fetched += current.messages_fetched;
            acc.messages_transformed += current.messages_transformed;
            acc.rows_upserted += current.rows_upserted;
            return acc;
          },
          {
            pages_fetched: 0,
            messages_fetched: 0,
            messages_transformed: 0,
            rows_upserted: 0,
          }
        );

        return {
          status: "ok",
          channels: config.channelIds.length,
          ...totals,
          max_pages_per_channel: config.maxPagesPerChannel,
          channel_summaries: channelSummaries,
        };
      });

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "slack-ingest",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "slack-ingest",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
