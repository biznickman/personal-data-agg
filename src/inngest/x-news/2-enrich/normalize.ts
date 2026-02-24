import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import {
  normalizeStory,
  type NormalizedStory,
} from "../services/story-normalizer";
import type { NormalizationUrlContext } from "../utils/normalize-prompt";
import { TweetUrlsModel, TweetsModel, type TweetUrlContextRow } from "../models";

type NormalizeEvent = {
  data: {
    tweetId?: string;
    reason?: string;
  };
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

function toUrlContexts(rows: TweetUrlContextRow[]): NormalizationUrlContext[] {
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
        return TweetsModel.findByTweetId(tweetId);
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
        return TweetUrlsModel.listContextsByTweetId(tweet.tweet_id);
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
        await TweetsModel.updateNormalization({
          tweetId: tweet.tweet_id,
          normalizedHeadline: normalized.normalizedHeadline,
          normalizedFacts: normalized.normalizedFacts,
        });
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
