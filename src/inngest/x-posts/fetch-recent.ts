/**
 * Fetch recent @chooserich tweets every 15 minutes.
 * Adapted from ~/Dev/internalx/src/inngest/tweetArchiver/fetchRecentTweets.ts
 */

import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";
import { TwitterService } from "./twitter-service";
import { formatTweet, XPostRow } from "./format-tweet";

const LOOKBACK_MINUTES = 30;
const USERNAME = "chooserich";
const UPSERT_BATCH = 50;

export const xPostsFetchRecent = inngest.createFunction(
  {
    id: "x-posts-fetch-recent",
    concurrency: { limit: 1, key: "twitter-api-v2" },
    retries: 3,
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const startedAt = Date.now();

    try {
      // Step 1: Fetch tweets from API
      const rows = await step.run("fetch-and-format", async () => {
        const bearerToken = process.env.TWITTER_BEARER_TOKEN;
        if (!bearerToken) throw new Error("Missing TWITTER_BEARER_TOKEN");

        const twitter = new TwitterService(bearerToken);
        const startTime = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);

        console.log(
          `[x-posts] Fetching @${USERNAME} tweets since ${startTime.toISOString()}`
        );

        const tweets = await twitter.fetchOriginalPostsFromUsers(
          [USERNAME],
          startTime
        );

        const formatted: XPostRow[] = [];
        for (const t of tweets) {
          const row = formatTweet(t);
          if (row) formatted.push(row);
        }

        console.log(
          `[x-posts] ${tweets.length} fetched → ${formatted.length} after filtering retweets`
        );
        return formatted;
      });

      // Step 2: Upsert to Supabase
      const savedCount = await step.run("upsert-to-supabase", async () => {
        if (rows.length === 0) return 0;

        let total = 0;
        for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
          const batch = rows.slice(i, i + UPSERT_BATCH);
          const { error } = await supabase
            .from("x_posts")
            .upsert(batch, { onConflict: "tweet_id" });

          if (error) {
            console.error("[x-posts] Upsert error:", error);
            throw error;
          }
          total += batch.length;
        }

        console.log(`[x-posts] Upserted ${total} rows to x_posts`);
        return total;
      });

      await recordFunctionRun({
        functionId: "x-posts-fetch-recent",
        state: "ok",
        details: { tweetsFetched: rows.length, saved: savedCount },
      });

      return {
        status: "complete",
        tweetsFetched: rows.length,
        saved: savedCount,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      await recordFunctionRun({
        functionId: "x-posts-fetch-recent",
        state: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);
