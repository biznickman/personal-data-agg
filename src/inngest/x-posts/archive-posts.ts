/**
 * Archive @chooserich tweets on demand via user timeline API.
 * Adapted from ~/Dev/internalx/src/inngest/tweetArchiver/archiveUserTweets.ts
 *
 * NOT a cron — triggered manually from Inngest dashboard or via event.
 * Fetches up to 3,200 tweets from the user timeline and upserts to x_posts.
 * Useful for backfilling gaps when the 15-min fetch-recent misses time.
 */

import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";
import { formatTweet, XPostRow } from "./format-tweet";
import { TwitterApi, TweetV2, UserV2 } from "twitter-api-v2";
import type { EnrichedTweet, Media } from "./twitter-service";

function buildOAuthClient(): TwitterApi | null {
  const ck = process.env.TWITTER_CONSUMER_KEY;
  const cs = process.env.TWITTER_SECRET_KEY;
  const at = process.env.TWITTER_ACCESS_TOKEN;
  const as = process.env.TWITTER_ACCESS_SECRET;
  if (ck && cs && at && as) {
    return new TwitterApi({ appKey: ck, appSecret: cs, accessToken: at, accessSecret: as });
  }
  return null;
}

/** Tweet fields that include private metrics (requires OAuth) */
const TWEET_FIELDS_PRIVATE =
  "created_at,public_metrics,non_public_metrics,organic_metrics,referenced_tweets,author_id,entities,note_tweet,edit_history_tweet_ids,attachments";
const TWEET_FIELDS_PUBLIC =
  "created_at,public_metrics,referenced_tweets,author_id,entities,note_tweet,edit_history_tweet_ids,attachments";
const MEDIA_FIELDS = "media_key,type,url,height,width,public_metrics,non_public_metrics,preview_image_url,variants,duration_ms";

const USERNAME = "chooserich";
const MAX_RESULTS_PER_PAGE = 100;
const MAX_PAGES = 32; // 32 * 100 = 3,200 (Twitter timeline limit)
const UPSERT_BATCH = 50;

interface ArchiveEvent {
  data: {
    /** Optional: only fetch tweets after this ISO timestamp */
    sinceTime?: string;
    /** Optional: only fetch tweets before this ISO timestamp */
    untilTime?: string;
    /** Optional: max pages to fetch (default 32 = 3,200 tweets) */
    maxPages?: number;
  };
}

export const xPostsArchive = inngest.createFunction(
  {
    id: "x-posts-archive",
    concurrency: { limit: 1, key: "twitter-api-v2" },
    retries: 2,
  },
  { event: "x-posts/archive" },
  async ({ event, step }) => {
    const archiveEvent = event as ArchiveEvent;
    const startedAt = Date.now();
    const sinceTime = archiveEvent.data?.sinceTime;
    const untilTime = archiveEvent.data?.untilTime;
    const maxPages = archiveEvent.data?.maxPages ?? MAX_PAGES;

    try {
      // Step 1: Get user ID for @chooserich
      const userId = await step.run("get-user-id", async () => {
        const oauthClient = buildOAuthClient();
        const bearerToken = process.env.TWITTER_BEARER_TOKEN;
        const client = oauthClient ?? (bearerToken ? new TwitterApi(bearerToken) : null);
        if (!client) throw new Error("Missing Twitter credentials");

        const user = await client.v2.userByUsername(USERNAME);
        if (!user.data) throw new Error(`User @${USERNAME} not found`);

        console.log(`[archive] @${USERNAME} → user ID ${user.data.id}`);
        return user.data.id;
      });

      // Step 2: Fetch timeline with pagination (OAuth for private metrics)
      const rows = await step.run("fetch-timeline", async () => {
        const oauthClient = buildOAuthClient();
        const bearerToken = process.env.TWITTER_BEARER_TOKEN;
        const client = oauthClient ?? (bearerToken ? new TwitterApi(bearerToken) : null);
        if (!client) throw new Error("Missing Twitter credentials");
        const hasOAuth = !!oauthClient;

        console.log(`[archive] Using ${hasOAuth ? "OAuth (private metrics)" : "bearer (public only)"}`);

        const allTweets: TweetV2[] = [];
        const allMedia: Media[] = [];
        const allUsers: UserV2[] = [];

        let nextToken: string | undefined;
        let pageCount = 0;

        do {
          pageCount++;
          const params: Record<string, unknown> = {
            max_results: MAX_RESULTS_PER_PAGE,
            "tweet.fields": hasOAuth ? TWEET_FIELDS_PRIVATE : TWEET_FIELDS_PUBLIC,
            expansions: "attachments.media_keys,author_id",
            "media.fields": MEDIA_FIELDS,
            "user.fields": "id,name,username,profile_image_url",
            exclude: "retweets",
          };

          if (sinceTime) params.start_time = sinceTime;
          if (untilTime) params.end_time = untilTime;
          if (nextToken) params.pagination_token = nextToken;

          const response = await client.v2.userTimeline(userId, params);

          if (response.data?.data) {
            allTweets.push(...response.data.data);
            if (response.data.includes?.media)
              allMedia.push(...(response.data.includes.media as unknown as Media[]));
            if (response.data.includes?.users)
              allUsers.push(...response.data.includes.users);
          }

          nextToken = response.data?.meta?.next_token;

          console.log(
            `[archive] Page ${pageCount}: ${response.data?.data?.length ?? 0} tweets (total: ${allTweets.length})`
          );

          // Rate limit pause
          if (nextToken && pageCount < maxPages) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } while (nextToken && pageCount < maxPages);

        // Enrich and format
        const mediaMap = new Map<string, Media>();
        allMedia.forEach((m) => mediaMap.set(m.media_key, m));
        const userMap = new Map<string, UserV2>();
        allUsers.forEach((u) => userMap.set(u.id, u));

        const enriched: EnrichedTweet[] = allTweets.map((tweet) => {
          const media: Media[] = [];
          tweet.attachments?.media_keys?.forEach((key) => {
            const m = mediaMap.get(key);
            if (m) media.push(m);
          });
          const author = tweet.author_id ? userMap.get(tweet.author_id) : undefined;
          return { ...tweet, media, author };
        });

        const formatted: XPostRow[] = [];
        for (const t of enriched) {
          const row = formatTweet(t);
          if (row) formatted.push(row);
        }

        console.log(
          `[archive] ${allTweets.length} fetched → ${formatted.length} after filtering (${pageCount} pages)`
        );
        return formatted;
      });

      // Step 3: Upsert to Supabase
      const savedCount = await step.run("upsert-to-supabase", async () => {
        if (rows.length === 0) return 0;

        let total = 0;
        for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
          const batch = rows.slice(i, i + UPSERT_BATCH);
          const { error } = await supabase
            .from("x_posts")
            .upsert(batch, { onConflict: "tweet_id" });

          if (error) {
            console.error("[archive] Upsert error:", error);
            throw error;
          }
          total += batch.length;
        }

        console.log(`[archive] Upserted ${total} rows to x_posts`);
        return total;
      });

      await recordFunctionRun({
        functionId: "x-posts-archive",
        state: "ok",
        details: {
          tweetsFetched: rows.length,
          saved: savedCount,
          sinceTime,
          untilTime,
        },
      });

      return {
        status: "complete",
        tweetsFetched: rows.length,
        saved: savedCount,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      await recordFunctionRun({
        functionId: "x-posts-archive",
        state: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);
