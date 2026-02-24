import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import { TweetUrlsModel, TweetsModel } from "../models";
import { processTweetUrlById } from "../services/url-content";

type EnrichUrlEvent = {
  data: {
    tweetUrlId?: number;
    url?: string;
  };
};

/**
 * URL content enrichment for tweet_urls.
 * Triggered as soon as new tweet URL rows are inserted.
 */
export const xNewsEnrichUrls = inngest.createFunction(
  {
    id: "x-news-enrich-urls",
    retries: 1,
    timeouts: {
      finish: "2m",
    },
  },
  { event: "x-news/url.enrich" },
  async ({ event, step }) => {
    try {
      const payload = event as EnrichUrlEvent;
      const tweetUrlId =
        typeof payload.data?.tweetUrlId === "number" ? payload.data.tweetUrlId : null;

      if (!tweetUrlId) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "missing_tweet_url_id",
        };

        await step.run("record-success-missing-id", async () => {
          await recordFunctionRun({
            functionId: "x-news-enrich-urls",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const row = await step.run("load-url-row", async () => {
        return TweetUrlsModel.findById(tweetUrlId);
      });

      if (!row) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "tweet_url_not_found",
          tweet_url_id: tweetUrlId,
        };

        await step.run("record-success-not-found", async () => {
          await recordFunctionRun({
            functionId: "x-news-enrich-urls",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      if (row.url_content) {
        let normalizationEnqueued = 0;
        if (row.tweet_id) {
          const shouldNormalize = await step.run("check-normalization-pending", async () => {
            return TweetsModel.isNormalizationPending(row.tweet_id as string);
          });
          if (shouldNormalize) {
            await step.sendEvent("enqueue-normalization", {
              name: "x-news/tweet.normalize",
              data: { tweetId: row.tweet_id, reason: "url_already_processed" },
            });
            normalizationEnqueued = 1;
          }
        }

        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "already_processed",
          tweet_url_id: row.id,
          normalization_events_sent: normalizationEnqueued,
        };

        await step.run("record-success-already-processed", async () => {
          await recordFunctionRun({
            functionId: "x-news-enrich-urls",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const url = typeof payload.data?.url === "string" ? payload.data.url : row.url;
      if (!url) {
        let normalizationEnqueued = 0;
        if (row.tweet_id) {
          const shouldNormalize = await step.run("check-normalization-pending-no-url", async () => {
            return TweetsModel.isNormalizationPending(row.tweet_id as string);
          });
          if (shouldNormalize) {
            await step.sendEvent("enqueue-normalization-no-url", {
              name: "x-news/tweet.normalize",
              data: { tweetId: row.tweet_id, reason: "url_missing" },
            });
            normalizationEnqueued = 1;
          }
        }

        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "url_missing",
          tweet_url_id: row.id,
          normalization_events_sent: normalizationEnqueued,
        };

        await step.run("record-success-url-missing", async () => {
          await recordFunctionRun({
            functionId: "x-news-enrich-urls",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const result = await step.run("process-url", async () => {
        return processTweetUrlById(row.id, url);
      });

      let normalizationEnqueued = 0;
      if (row.tweet_id) {
        const shouldNormalize = await step.run("check-normalization-pending-after-enrich", async () => {
          return TweetsModel.isNormalizationPending(row.tweet_id as string);
        });
        if (shouldNormalize) {
          await step.sendEvent("enqueue-normalization-after-enrich", {
            name: "x-news/tweet.normalize",
            data: { tweetId: row.tweet_id, reason: "url_enriched" },
          });
          normalizationEnqueued = 1;
        }
      }

      const summary = {
        status: "ok",
        processed: 1,
        succeeded: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        tweet_url_id: row.id,
        normalization_events_sent: normalizationEnqueued,
        ...(result.error ? { error: result.error } : {}),
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-enrich-urls",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-enrich-urls",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
