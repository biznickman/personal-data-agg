import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";

const STORY_MIN_TWEETS = 3;
const STORY_MIN_USERS = 2;
const MIN_REVIEW_SIZE = 3;
const REVIEW_COOLDOWN_MINUTES = 30;
const MAX_TWEETS_TO_LLM = 30;
const DB_CHUNK = 200;

// ── LLM provider helpers (mirrored from story-normalizer.ts) ──────────────────

type NormalizerProvider = "openrouter" | "portkey";

interface NormalizerConfig {
  provider: NormalizerProvider;
  model: string;
}

interface ChatChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
}

function getNormalizerConfig(): NormalizerConfig {
  const provider = (
    process.env.X_NEWS_NORMALIZER_PROVIDER ?? "openrouter"
  ).toLowerCase();

  if (provider !== "openrouter" && provider !== "portkey") {
    throw new Error(
      `Unsupported X_NEWS_NORMALIZER_PROVIDER: ${provider}. Use "openrouter" or "portkey".`
    );
  }

  const DEFAULT_MODEL =
    provider === "openrouter"
      ? "anthropic/claude-3.5-haiku"
      : "anthropic/claude-3-5-haiku-latest";
  const model = process.env.X_NEWS_NORMALIZER_MODEL ?? DEFAULT_MODEL;

  return { provider: provider as NormalizerProvider, model };
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  throw new Error("LLM response did not include message content");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Could not find JSON object in LLM response");
}

async function callOpenRouter(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "ingestion-engine",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  return extractMessageContent((await response.json()) as ChatCompletionResponse);
}

async function callPortkey(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const apiKey = process.env.PORTKEY_API_KEY;
  if (!apiKey) throw new Error("Missing PORTKEY_API_KEY");

  const baseUrl = (
    process.env.PORTKEY_BASE_URL ?? "https://api.portkey.ai/v1"
  ).replace(/\/$/, "");
  const config = process.env.PORTKEY_CONFIG;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-portkey-api-key": apiKey,
  };
  if (config) headers["x-portkey-config"] = config;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Portkey ${response.status}: ${text}`);
  }

  return extractMessageContent((await response.json()) as ChatCompletionResponse);
}

// ── LLM review call ───────────────────────────────────────────────────────────

type TweetContentRow = {
  id: number;
  tweet_id: string;
  normalized_headline: string | null;
  tweet_text: string | null;
};

async function callLlmReview(params: {
  normalizedHeadline: string | null;
  tweets: TweetContentRow[];
}): Promise<{ toRemove: string[] }> {
  const { tweets, normalizedHeadline } = params;
  const tweetsForLlm = tweets.slice(0, MAX_TWEETS_TO_LLM);

  const systemPrompt = `You are reviewing a news cluster — a group of tweets that have been automatically grouped together as covering the same news story. Your job is to identify tweets that clearly do NOT belong to the main story being covered by the majority of tweets.

Rules:
- Only flag tweets that are about a COMPLETELY different topic or event
- Be conservative — if a tweet is tangentially related, keep it
- Return a JSON object: { "remove": ["tweet_id_1", "tweet_id_2"] }
- Return { "remove": [] } if all tweets belong`;

  const tweetLines = tweetsForLlm
    .map((t, i) => {
      const text = (t.normalized_headline || t.tweet_text || "").slice(0, 150);
      return `${i + 1}. ${t.tweet_id}: ${text}`;
    })
    .join("\n");

  const userPrompt = `Main story headline: ${normalizedHeadline ?? "(no headline)"}

Tweets in this cluster (${tweets.length} total):
${tweetLines}`;

  const config = getNormalizerConfig();
  const rawContent =
    config.provider === "openrouter"
      ? await callOpenRouter({ model: config.model, systemPrompt, userPrompt })
      : await callPortkey({ model: config.model, systemPrompt, userPrompt });

  try {
    const parsed = extractJsonObject(rawContent) as { remove?: unknown };
    const remove = Array.isArray(parsed.remove)
      ? parsed.remove.filter((id): id is string => typeof id === "string")
      : [];
    return { toRemove: remove };
  } catch {
    console.warn("Failed to parse LLM review response:", rawContent);
    return { toRemove: [] };
  }
}

// ── Inngest function ──────────────────────────────────────────────────────────

type ReviewEvent = {
  data: {
    clusterId?: number;
  };
};

export const xNewsClusterReview = inngest.createFunction(
  {
    id: "x-news-cluster-review",
    retries: 1,
    concurrency: 3,
    timeouts: {
      finish: "3m",
    },
  },
  { event: "x-news/cluster.review.requested" },
  async ({ event, step }) => {
    try {
      const payload = event as ReviewEvent;
      const clusterId =
        typeof payload.data?.clusterId === "number" ? payload.data.clusterId : null;

      if (!clusterId) {
        return { status: "skipped", reason: "invalid_cluster_id" };
      }

      // ── Step 1: Load cluster + tweets ──────────────────────────────────────
      const loadResult = await step.run("load-cluster", async () => {
        const { data: clusterRow, error: clusterError } = await supabase
          .from("x_news_clusters")
          .select("id,normalized_headline,tweet_count,reviewed_at,is_active")
          .eq("id", clusterId)
          .maybeSingle();

        if (clusterError) throw new Error(`Load cluster failed: ${clusterError.message}`);
        if (!clusterRow) return { skip: "cluster_not_found" as const };

        // Check cooldown
        if (clusterRow.reviewed_at) {
          const minsAgo =
            (Date.now() - new Date(clusterRow.reviewed_at).getTime()) / (1000 * 60);
          if (minsAgo < REVIEW_COOLDOWN_MINUTES) {
            return { skip: "cooldown" as const };
          }
        }

        // Load tweet memberships
        const { data: memberRows, error: memberError } = await supabase
          .from("x_news_cluster_tweets")
          .select("tweet_id")
          .eq("cluster_id", clusterId);

        if (memberError) throw new Error(`Load cluster tweets failed: ${memberError.message}`);

        const dbIds = (memberRows ?? []).map((r: { tweet_id: number }) => r.tweet_id);
        if (dbIds.length < MIN_REVIEW_SIZE) return { skip: "too_small" as const };

        // Load tweet content
        const tweets: TweetContentRow[] = [];
        for (let i = 0; i < dbIds.length; i += DB_CHUNK) {
          const chunk = dbIds.slice(i, i + DB_CHUNK);
          const { data, error } = await supabase
            .from("tweets")
            .select("id,tweet_id,normalized_headline,tweet_text")
            .in("id", chunk);
          if (error) throw new Error(`Load tweet content failed: ${error.message}`);
          tweets.push(...((data ?? []) as TweetContentRow[]));
        }

        return {
          normalizedHeadline: clusterRow.normalized_headline as string | null,
          tweets,
        };
      });

      if ("skip" in loadResult) {
        return { status: "skipped", reason: loadResult.skip, clusterId };
      }

      const { normalizedHeadline, tweets } = loadResult;
      if (tweets.length < MIN_REVIEW_SIZE) {
        return { status: "skipped", reason: "too_small", clusterId };
      }

      // ── Step 2: Call LLM for outlier detection ─────────────────────────────
      const llmResult = await step.run("call-llm-review", async () => {
        return callLlmReview({ normalizedHeadline, tweets });
      });

      // ── Step 3: Apply removals + recompute stats ───────────────────────────
      const removalCount = await step.run("apply-removals", async () => {
        const now = new Date().toISOString();
        let removed = 0;

        if (llmResult.toRemove.length > 0) {
          // Map string tweet IDs → DB IDs
          const { data: dbIdRows, error: dbIdError } = await supabase
            .from("tweets")
            .select("id,tweet_id")
            .in("tweet_id", llmResult.toRemove);
          if (dbIdError) throw new Error(`Tweet ID lookup failed: ${dbIdError.message}`);

          const dbIds = (dbIdRows ?? []).map((r: { id: number }) => r.id);
          if (dbIds.length > 0) {
            const { error: deleteError } = await supabase
              .from("x_news_cluster_tweets")
              .delete()
              .in("tweet_id", dbIds)
              .eq("cluster_id", clusterId);
            if (deleteError) throw new Error(`Tweet removal failed: ${deleteError.message}`);
            removed = dbIds.length;
          }
        }

        // Recompute stats
        const { data: memberRows } = await supabase
          .from("x_news_cluster_tweets")
          .select("tweet_id")
          .eq("cluster_id", clusterId);

        const memberDbIds = (memberRows ?? []).map((r: { tweet_id: number }) => r.tweet_id);

        const { data: tweetRows } = await supabase
          .from("tweets")
          .select("tweet_id,username")
          .in("id", memberDbIds);

        const updatedTweets = (tweetRows ?? []) as Array<{
          tweet_id: string;
          username: string | null;
        }>;
        const uniqueUsers = new Set(
          updatedTweets.map((t) => (t.username ?? `id:${t.tweet_id}`).toLowerCase())
        ).size;
        const isStoryCandidate =
          updatedTweets.length >= STORY_MIN_TWEETS && uniqueUsers >= STORY_MIN_USERS;

        await supabase
          .from("x_news_clusters")
          .update({
            tweet_count: updatedTweets.length,
            unique_user_count: uniqueUsers,
            is_story_candidate: isStoryCandidate,
            reviewed_at: now,
          })
          .eq("id", clusterId);

        return removed;
      });

      const summary = {
        status: "ok",
        cluster_id: clusterId,
        tweets_reviewed: tweets.length,
        removed_count: removalCount,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-review",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-review",
          state: "error",
          errorMessage: message,
        });
      });
      throw error;
    }
  }
);
