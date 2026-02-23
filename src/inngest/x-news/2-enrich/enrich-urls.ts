import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { processTweetUrlById } from "./url-content";

type EnrichUrlEvent = {
  data: {
    tweetUrlId?: number;
    url?: string;
  };
};

type TweetUrlRow = {
  id: number;
  tweet_id: string | null;
  url: string | null;
  url_content: string | null;
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
        const { data, error } = await supabase
          .from("tweet_urls")
          .select("id,tweet_id,url,url_content")
          .eq("id", tweetUrlId)
          .maybeSingle();

        if (error) {
          throw new Error(`Supabase lookup failed: ${error.message}`);
        }

        return (data ?? null) as TweetUrlRow | null;
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
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "already_processed",
          tweet_url_id: row.id,
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
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "url_missing",
          tweet_url_id: row.id,
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

      if (row.tweet_id) {
        await step.sendEvent("enqueue-normalization", {
          name: "x-news/tweet.normalize",
          data: { tweetId: row.tweet_id, reason: "url_enriched" },
        });
      }

      const summary = {
        status: "ok",
        processed: 1,
        succeeded: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        tweet_url_id: row.id,
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
