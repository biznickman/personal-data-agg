import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import { TweetsModel } from "../models";
import { embedTextForClustering, getEmbeddingModel } from "./embeddings";
import { parseVector, stringifyVector } from "./vector";

type NormalizeEvent = {
  data: {
    tweetId?: string;
  };
};

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EMBED_CONCURRENCY = Math.floor(
  parsePositiveNumber(process.env.X_NEWS_EMBED_CONCURRENCY, 5)
);

/**
 * Ensures every normalized tweet has a normalized_headline_embedding stored in
 * the tweets table. The actual clustering happens at query time via the
 * cluster_tweets_by_embedding Postgres function — no persistent cluster state
 * is written here.
 */
export const xNewsClusterAssign = inngest.createFunction(
  {
    id: "x-news-cluster-assign",
    retries: 1,
    concurrency: EMBED_CONCURRENCY,
    timeouts: {
      finish: "2m",
    },
  },
  { event: "x-news/tweet.normalized" },
  async ({ event, step }) => {
    try {
      const payload = event as NormalizeEvent;
      const tweetId =
        typeof payload.data?.tweetId === "string" ? payload.data.tweetId : null;

      if (!tweetId) {
        const summary = { status: "ok", processed: 0, skipped: 1, reason: "missing_tweet_id" };
        await step.run("record-skip", async () => {
          await recordFunctionRun({ functionId: "x-news-cluster-assign", state: "ok", details: summary });
        });
        return summary;
      }

      const tweet = await step.run("load-tweet", async () => {
        return TweetsModel.findNormalizedByTweetId(tweetId);
      });

      if (!tweet) {
        const summary = { status: "ok", processed: 0, skipped: 1, reason: "tweet_not_found", tweet_id: tweetId };
        await step.run("record-skip", async () => {
          await recordFunctionRun({ functionId: "x-news-cluster-assign", state: "ok", details: summary });
        });
        return summary;
      }

      // If the tweet already has an embedding, nothing to do
      if (parseVector(tweet.normalized_headline_embedding)) {
        return { status: "ok", processed: 0, skipped: 1, reason: "already_embedded", tweet_id: tweet.tweet_id };
      }

      const rawText = typeof tweet.tweet_text === "string" ? tweet.tweet_text.trim() : "";
      const headlineText = tweet.normalized_headline?.trim() || rawText.slice(0, 240) || null;

      if (!headlineText) {
        const summary = { status: "ok", processed: 0, skipped: 1, reason: "no_text_to_embed", tweet_id: tweet.tweet_id };
        await step.run("record-skip", async () => {
          await recordFunctionRun({ functionId: "x-news-cluster-assign", state: "ok", details: summary });
        });
        return summary;
      }

      const embedding = await step.run("embed-headline", async () => {
        return embedTextForClustering(headlineText);
      });

      await step.run("persist-embedding", async () => {
        const vector = stringifyVector(embedding);
        if (!vector) throw new Error("Embedding generation returned an empty vector");
        await TweetsModel.updateNormalizedHeadlineEmbedding({ tweetDbId: tweet.id, embedding: vector });
      });

      const summary = {
        status: "ok",
        processed: 1,
        tweet_id: tweet.tweet_id,
        embedding_model: getEmbeddingModel(),
        used_raw_fallback: !tweet.normalized_headline?.trim(),
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({ functionId: "x-news-cluster-assign", state: "ok", details: summary });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({ functionId: "x-news-cluster-assign", state: "error", errorMessage: message });
      });
      throw error;
    }
  }
);
