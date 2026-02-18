/**
 * Simplified Twitter API v2 service for @chooserich post ingestion.
 * Adapted from ~/Dev/internalx/src/services/twitter.ts
 *
 * Keeps: fetchOriginalPostsFromUsers, fetchTweetAnalyticsByIds, enrichment
 * Removes: full-archive, user-by-id, timeline, page-level fetch
 */

import { TwitterApi, TweetV2, UserV2, ApiResponseError } from "twitter-api-v2";

export interface Media {
  media_key: string;
  height?: number;
  url?: string;
  width?: number;
  type: string;
  preview_image_url?: string;
  duration_ms?: number;
  variants?: { url?: string; bit_rate?: number; content_type?: string }[];
}

export type EnrichedTweet = TweetV2 & {
  media?: Media[];
  author?: UserV2;
};

export interface TweetAnalyticsData {
  tweet_id: string;
  impressions: number;
  likes: number;
  quotes: number;
  retweets: number;
  bookmarks: number;
  replies: number;
}

const MAX_RESULTS_PER_PAGE = 100;
const MAX_PAGES = 10;

export class TwitterService {
  private client: TwitterApi;

  constructor(bearerToken: string) {
    if (!bearerToken) throw new Error("[twitter] Bearer token required");
    this.client = new TwitterApi(bearerToken);
  }

  /* ------------------------------------------------------------------ */
  /*  Enrichment helper                                                  */
  /* ------------------------------------------------------------------ */

  private enrichTweetsWithIncludes(
    tweets: TweetV2[],
    includes?: { media?: Media[]; users?: UserV2[] }
  ): EnrichedTweet[] {
    const mediaMap = new Map<string, Media>();
    (includes?.media ?? []).forEach((m) => mediaMap.set(m.media_key, m));

    const userMap = new Map<string, UserV2>();
    (includes?.users ?? []).forEach((u) => userMap.set(u.id, u));

    return tweets.map((tweet) => {
      const media: Media[] = [];
      tweet.attachments?.media_keys?.forEach((key) => {
        const m = mediaMap.get(key);
        if (m) media.push(m);
      });
      const author = tweet.author_id ? userMap.get(tweet.author_id) : undefined;
      return { ...tweet, media, author };
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Fetch recent tweets for usernames (recent search, <7 days)         */
  /* ------------------------------------------------------------------ */

  async fetchOriginalPostsFromUsers(
    usernames: string[],
    startTime?: Date,
    endTime?: Date
  ): Promise<EnrichedTweet[]> {
    if (!usernames.length) return [];

    const fromQuery = usernames.map((u) => `from:${u}`).join(" OR ");

    const baseParams: Record<string, unknown> = {
      max_results: MAX_RESULTS_PER_PAGE,
      "tweet.fields":
        "created_at,public_metrics,referenced_tweets,author_id,entities,note_tweet,edit_history_tweet_ids,attachments",
      expansions: "attachments.media_keys,author_id",
      "media.fields":
        "media_key,type,url,height,width,public_metrics,preview_image_url,variants,duration_ms",
      "user.fields": "id,name,username,profile_image_url",
      start_time: startTime
        ? startTime.toISOString()
        : new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    if (endTime) baseParams.end_time = endTime.toISOString();

    const allTweets: TweetV2[] = [];
    const allIncludes: { media: Media[]; users: UserV2[] } = {
      media: [],
      users: [],
    };

    let nextToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount++;
      const params = { ...baseParams } as Record<string, unknown>;
      if (nextToken) params.next_token = nextToken;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await this.client.v2.search(fromQuery, params as any);

        if (response.data?.data) {
          allTweets.push(...response.data.data);
          if (response.data.includes?.media)
            allIncludes.media.push(
              ...(response.data.includes.media as unknown as Media[])
            );
          if (response.data.includes?.users)
            allIncludes.users.push(...response.data.includes.users);
        }

        nextToken = response.meta?.next_token;

        if (response.rateLimit?.remaining === 0) {
          console.log("[twitter] Rate limit reached");
          break;
        }
        if (nextToken && pageCount < MAX_PAGES) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        if (err instanceof ApiResponseError && (err.code === 429 || err.code === 500 || err.code === 503)) {
          throw err; // let Inngest retry
        }
        console.error("[twitter] Search error:", err);
        break;
      }
    } while (nextToken && pageCount < MAX_PAGES);

    const enriched = this.enrichTweetsWithIncludes(allTweets, allIncludes);
    console.log(
      `[twitter] Fetched ${enriched.length} tweets across ${pageCount} page(s)`
    );
    return enriched;
  }

  /* ------------------------------------------------------------------ */
  /*  Fetch public analytics for tweet IDs (batches of 100)              */
  /* ------------------------------------------------------------------ */

  async fetchTweetAnalyticsByIds(
    tweetIds: string[]
  ): Promise<TweetAnalyticsData[]> {
    if (!tweetIds.length) return [];

    const results: TweetAnalyticsData[] = [];
    const BATCH = 100;

    for (let i = 0; i < tweetIds.length; i += BATCH) {
      const batch = tweetIds.slice(i, i + BATCH);
      try {
        const response = await this.client.v2.tweets(batch, {
          "tweet.fields": "public_metrics",
        });

        if (response.data) {
          for (const tweet of response.data) {
            results.push({
              tweet_id: tweet.id,
              impressions: tweet.public_metrics?.impression_count ?? 0,
              likes: tweet.public_metrics?.like_count ?? 0,
              quotes: tweet.public_metrics?.quote_count ?? 0,
              retweets: tweet.public_metrics?.retweet_count ?? 0,
              bookmarks: tweet.public_metrics?.bookmark_count ?? 0,
              replies: tweet.public_metrics?.reply_count ?? 0,
            });
          }
        }
      } catch (err) {
        console.error(`[twitter] Analytics batch error (start ${batch[0]}):`, err);
        if (err instanceof Error && err.message.includes("bearer token")) throw err;
      }
    }

    console.log(
      `[twitter] Got analytics for ${results.length}/${tweetIds.length} tweets`
    );
    return results;
  }
}
