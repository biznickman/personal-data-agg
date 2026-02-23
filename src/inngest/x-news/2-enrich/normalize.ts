import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import {
  normalizeStory,
  type NormalizedStory,
} from "./normalize-llm";
import type { NormalizationUrlContext } from "./normalize-prompt";

type NormalizeEvent = {
  data: {
    tweetId?: string;
    reason?: string;
  };
};

type TweetRow = {
  tweet_id: string;
  tweet_text: string | null;
  username: string | null;
};

type TweetUrlRow = {
  url: string | null;
  url_content: string | null;
};

const MAX_URL_CONTEXTS = 3;

function isUsableUrlContent(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("Error fetching content:")) return false;
  if (trimmed === "Could not extract readable content") return false;
  return true;
}

function toUrlContexts(rows: TweetUrlRow[]): NormalizationUrlContext[] {
  return rows
    .filter((row) => typeof row.url === "string" && isUsableUrlContent(row.url_content))
    .slice(0, MAX_URL_CONTEXTS)
    .map((row) => ({
      url: row.url as string,
      content: row.url_content as string,
    }));
}

/**
 * Normalizes tweet + enriched URL context into canonical headline/facts for clustering.
 */
export const xNewsNormalize = inngest.createFunction(
  {
    id: "x-news-normalize",
    retries: 1,
    timeouts: {
      finish: "2m",
    },
  },
  { event: "x-news/tweet.normalize" },
  async ({ event, step }) => {
    try {
      const payload = event as NormalizeEvent;
      const tweetId =
        typeof payload.data?.tweetId === "string" ? payload.data.tweetId : null;
      const reason = typeof payload.data?.reason === "string" ? payload.data.reason : "unknown";

      if (!tweetId) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "missing_tweet_id",
        };

        await step.run("record-success-missing-id", async () => {
          await recordFunctionRun({
            functionId: "x-news-normalize",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      const tweet = await step.run("load-tweet", async () => {
        const { data, error } = await supabase
          .from("tweets")
          .select("tweet_id,tweet_text,username")
          .eq("tweet_id", tweetId)
          .maybeSingle();

        if (error) {
          throw new Error(`Supabase tweet lookup failed: ${error.message}`);
        }
        return (data ?? null) as TweetRow | null;
      });

      if (!tweet) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "tweet_not_found",
          tweet_id: tweetId,
        };

        await step.run("record-success-tweet-not-found", async () => {
          await recordFunctionRun({
            functionId: "x-news-normalize",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      if (!tweet.tweet_text || !tweet.tweet_text.trim()) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "missing_tweet_text",
          tweet_id: tweet.tweet_id,
        };

        await step.run("record-success-no-text", async () => {
          await recordFunctionRun({
            functionId: "x-news-normalize",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      const urlRows = await step.run("load-url-contexts", async () => {
        const { data, error } = await supabase
          .from("tweet_urls")
          .select("url,url_content")
          .eq("tweet_id", tweet.tweet_id)
          .not("url_content", "is", null)
          .order("created_at", { ascending: true });

        if (error) {
          throw new Error(`Supabase URL lookup failed: ${error.message}`);
        }
        return (data ?? []) as TweetUrlRow[];
      });

      const urlContexts = toUrlContexts(urlRows);
      const normalized = await step.run("normalize-story", async () => {
        return normalizeStory({
          tweetId: tweet.tweet_id,
          username: tweet.username,
          tweetText: tweet.tweet_text as string,
          urlContexts,
        });
      });

      await step.run("write-normalization", async () => {
        const payloadToSave: {
          normalized_headline: string;
          normalized_facts: string[];
        } = {
          normalized_headline: normalized.normalizedHeadline,
          normalized_facts: normalized.normalizedFacts,
        };

        const { error } = await supabase
          .from("tweets")
          .update(payloadToSave)
          .eq("tweet_id", tweet.tweet_id);

        if (error) {
          throw new Error(`Supabase normalization update failed: ${error.message}`);
        }
      });

      await step.sendEvent("emit-normalized-event", {
        name: "x-news/tweet.normalized",
        data: {
          tweetId: tweet.tweet_id,
        },
      });

      const summary = summarizeNormalization({
        tweetId: tweet.tweet_id,
        reason,
        urlContextCount: urlContexts.length,
        normalized,
      });

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-normalize",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-normalize",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);

function summarizeNormalization(params: {
  tweetId: string;
  reason: string;
  urlContextCount: number;
  normalized: NormalizedStory;
}): Record<string, unknown> {
  return {
    status: "ok",
    processed: 1,
    tweet_id: params.tweetId,
    trigger_reason: params.reason,
    url_contexts_used: params.urlContextCount,
    normalized_facts_count: params.normalized.normalizedFacts.length,
    model_provider: params.normalized.provider,
    model_name: params.normalized.model,
  };
}
