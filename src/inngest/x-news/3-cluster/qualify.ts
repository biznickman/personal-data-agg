import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { SPAM_SYSTEM_PROMPT } from "../prompts/qualify";

const SPAM_PATTERNS = [
  /trading signal/i,
  /paid.*group/i,
  /signal service/i,
  /join.*channel/i,
  /follow me for/i,
  /airdrop/i,
  /social media.*post$/i,
  /social media.*signal/i,
];

// ── LLM provider helpers (mirrored from review.ts) ──────────────────────────

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
      max_tokens: 200,
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
      max_tokens: 200,
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

// ── Spam detection ──────────────────────────────────────────────────────────

export function matchesSpamPattern(headline: string): boolean {
  return SPAM_PATTERNS.some((pattern) => pattern.test(headline));
}

export async function checkSpamLlm(headline: string): Promise<{ verdict: "news" | "spam"; reason: string }> {
  const config = getNormalizerConfig();
  const userPrompt = `Headline: ${headline}`;

  const rawContent =
    config.provider === "openrouter"
      ? await callOpenRouter({ model: config.model, systemPrompt: SPAM_SYSTEM_PROMPT, userPrompt })
      : await callPortkey({ model: config.model, systemPrompt: SPAM_SYSTEM_PROMPT, userPrompt });

  try {
    const parsed = extractJsonObject(rawContent) as { verdict?: string; reason?: string };
    const verdict = parsed.verdict === "spam" ? "spam" : "news";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return { verdict, reason };
  } catch {
    console.warn("Failed to parse spam check response:", rawContent);
    return { verdict: "news", reason: "parse_error_defaulting_to_news" };
  }
}

// ── Inngest function ──────────────────────────────────────────────────────────

type QualifyEvent = {
  data: {
    clusterId?: number;
  };
};

export const xNewsClusterQualify = inngest.createFunction(
  {
    id: "x-news-cluster-qualify",
    retries: 1,
    concurrency: 5,
    timeouts: {
      finish: "3m",
    },
  },
  { event: "x-news/cluster.qualify.requested" },
  async ({ event, step }) => {
    try {
      const payload = event as QualifyEvent;
      const clusterId =
        typeof payload.data?.clusterId === "number" ? payload.data.clusterId : null;

      if (!clusterId) {
        return { status: "skipped", reason: "invalid_cluster_id" };
      }

      // ── Step 1: Load cluster ──────────────────────────────────────────────
      const loadResult = await step.run("load-cluster", async () => {
        const { data: cluster, error } = await supabase
          .from("x_news_clusters")
          .select("id,normalized_headline,tweet_count,promoted_at,is_active,is_story_candidate")
          .eq("id", clusterId)
          .maybeSingle();

        if (error) throw new Error(`Load cluster failed: ${error.message}`);
        if (!cluster) return { skip: "cluster_not_found" as const };
        if (!cluster.is_active) return { skip: "not_active" as const };
        if (!cluster.is_story_candidate) return { skip: "not_story_candidate" as const };
        if (cluster.promoted_at) return { skip: "already_promoted" as const };

        return {
          headline: cluster.normalized_headline as string | null,
          tweetCount: cluster.tweet_count as number,
        };
      });

      if ("skip" in loadResult) {
        return { status: "skipped", reason: loadResult.skip, clusterId };
      }

      const { headline } = loadResult;

      if (!headline?.trim()) {
        return { status: "skipped", reason: "no_headline", clusterId };
      }

      // ── Step 2: Check spam ────────────────────────────────────────────────
      const spamResult = await step.run("check-spam", async () => {
        // Tier 1: Deterministic pattern check
        if (matchesSpamPattern(headline)) {
          return { verdict: "spam" as const, reason: "matched_spam_pattern", skippedLlm: true };
        }

        // Tier 2: LLM check
        const llmResult = await checkSpamLlm(headline);
        return { ...llmResult, skippedLlm: false };
      });

      // ── Step 3: Apply verdict ─────────────────────────────────────────────
      await step.run("apply-verdict", async () => {
        const now = new Date().toISOString();

        if (spamResult.verdict === "spam") {
          await supabase
            .from("x_news_clusters")
            .update({ is_active: false })
            .eq("id", clusterId);
        } else {
          await supabase
            .from("x_news_clusters")
            .update({ promoted_at: now })
            .eq("id", clusterId);
        }
      });

      const summary = {
        status: "ok",
        cluster_id: clusterId,
        headline,
        verdict: spamResult.verdict,
        reason: spamResult.reason,
        skipped_llm: spamResult.skippedLlm,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-qualify",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-qualify",
          state: "error",
          errorMessage: message,
        });
      });
      throw error;
    }
  }
);
