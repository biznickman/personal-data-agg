/**
 * Update analytics for matured @chooserich tweets every 4 hours.
 * Adapted from ~/Dev/internalx/src/inngest/tweetArchiver/updateTweetAnalytics.ts
 *
 * Finds tweets ≥72h old with no analytics yet, fetches current public_metrics,
 * and updates the x_posts table.
 */

import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";
import { TwitterService } from "./twitter-service";

const ANALYTICS_DELAY_HOURS = 72;
const MAX_TWEETS_PER_RUN = 500;

export const xPostsUpdateAnalytics = inngest.createFunction(
  {
    id: "x-posts-update-analytics",
    concurrency: { limit: 1, key: "twitter-api-v2" },
    retries: 3,
  },
  { cron: "0 */4 * * *" },
  async ({ step }) => {
    const startedAt = Date.now();

    try {
      // Step 1: Find tweets needing analytics
      const tweetsToUpdate = await step.run("find-tweets", async () => {
        const cutoff = new Date(
          Date.now() - ANALYTICS_DELAY_HOURS * 60 * 60 * 1000
        );

        const { data, error } = await supabase
          .from("x_posts")
          .select("id, tweet_id")
          .eq("username", "chooserich")
          .lt("tweet_time", cutoff.toISOString())
          .is("analytics_updated_at", null)
          .not("tweet_id", "is", null)
          .order("tweet_time", { ascending: true })
          .limit(MAX_TWEETS_PER_RUN);

        if (error) throw error;

        console.log(
          `[x-posts-analytics] Found ${data?.length ?? 0} tweets needing updates`
        );
        return data ?? [];
      });

      if (tweetsToUpdate.length === 0) {
        await recordFunctionRun({
          functionId: "x-posts-update-analytics",
          state: "ok",
          details: { tweetsUpdated: 0 },
        });
        return { status: "complete", tweetsUpdated: 0 };
      }

      // Step 2: Fetch analytics from Twitter API
      const analyticsData = await step.run("fetch-analytics", async () => {
        const bearerToken = process.env.TWITTER_BEARER_TOKEN;
        if (!bearerToken) throw new Error("Missing TWITTER_BEARER_TOKEN");

        const twitter = new TwitterService(bearerToken);
        const tweetIds = tweetsToUpdate.map((t) => t.tweet_id as string);

        return twitter.fetchTweetAnalyticsByIds(tweetIds);
      });

      // Step 3: Update rows in Supabase
      const updatedCount = await step.run("update-rows", async () => {
        const now = new Date().toISOString();
        const analyticsMap = new Map(
          analyticsData.map((a) => [a.tweet_id, a])
        );

        let success = 0;

        // Batch update tweets that have analytics
        const withAnalytics = tweetsToUpdate
          .filter((t) => analyticsMap.has(t.tweet_id as string))
          .map((t) => {
            const a = analyticsMap.get(t.tweet_id as string)!;
            return {
              id: t.id,
              tweet_id: t.tweet_id,
              analytics_updated_at: now,
              impressions: a.impressions,
              likes: a.likes,
              retweets: a.retweets,
              quotes: a.quotes,
              bookmarks: a.bookmarks,
              replies: a.replies,
            };
          });

        if (withAnalytics.length > 0) {
          const { error } = await supabase
            .from("x_posts")
            .upsert(withAnalytics, { onConflict: "tweet_id" });

          if (error) {
            console.error("[x-posts-analytics] Upsert error:", error);
          } else {
            success += withAnalytics.length;
          }
        }

        // Mark tweets without analytics (deleted?) as processed
        const withoutIds = tweetsToUpdate
          .filter((t) => !analyticsMap.has(t.tweet_id as string))
          .map((t) => t.id);

        if (withoutIds.length > 0) {
          const { error } = await supabase
            .from("x_posts")
            .update({ analytics_updated_at: now })
            .in("id", withoutIds);

          if (error) {
            console.error("[x-posts-analytics] Mark-processed error:", error);
          } else {
            success += withoutIds.length;
          }
        }

        console.log(
          `[x-posts-analytics] Updated ${success} tweets (${withAnalytics.length} with data, ${withoutIds.length} marked)`
        );
        return success;
      });

      await recordFunctionRun({
        functionId: "x-posts-update-analytics",
        state: "ok",
        details: {
          queried: tweetsToUpdate.length,
          analyticsReceived: analyticsData.length,
          updated: updatedCount,
        },
      });

      return {
        status: "complete",
        tweetsQueried: tweetsToUpdate.length,
        analyticsReceived: analyticsData.length,
        tweetsUpdated: updatedCount,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      await recordFunctionRun({
        functionId: "x-posts-update-analytics",
        state: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);
