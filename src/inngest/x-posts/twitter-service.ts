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

export interface PrivateMetricsData {
  tweet_id: string;
  impressions: number;
  likes: number;
  quotes: number;
  retweets: number;
  bookmarks: number;
  replies: number;
  url_clicks: number;
  profile_clicks: number;
  view_count: number;
  playback_0: number | null;
  playback_25: number | null;
  playback_50: number | null;
  playback_75: number | null;
  playback_100: number | null;
}

const MAX_RESULTS_PER_PAGE = 100;
const MAX_PAGES = 10;

export class TwitterService {
  private client: TwitterApi;
  private oauthClient: TwitterApi | null = null;

  constructor(bearerToken: string, oauth?: {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessSecret: string;
  }) {
    if (!bearerToken) throw new Error("[twitter] Bearer token required");
    this.client = new TwitterApi(bearerToken);

    if (oauth) {
      this.oauthClient = new TwitterApi({
        appKey: oauth.consumerKey,
        appSecret: oauth.consumerSecret,
        accessToken: oauth.accessToken,
        accessSecret: oauth.accessSecret,
      });
      console.log("[twitter] OAuth 1.0a client initialized for private metrics");
    }
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

    // Use OAuth client for private metrics if available
    const searchClient = this.oauthClient ?? this.client;
    const hasOAuth = !!this.oauthClient;

    const tweetFields = hasOAuth
      ? "created_at,public_metrics,non_public_metrics,organic_metrics,referenced_tweets,author_id,entities,note_tweet,edit_history_tweet_ids,attachments"
      : "created_at,public_metrics,referenced_tweets,author_id,entities,note_tweet,edit_history_tweet_ids,attachments";

    const baseParams: Record<string, unknown> = {
      max_results: MAX_RESULTS_PER_PAGE,
      "tweet.fields": tweetFields,
      expansions: "attachments.media_keys,author_id",
      "media.fields":
        "media_key,type,url,height,width,public_metrics,non_public_metrics,preview_image_url,variants,duration_ms",
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
        const response = await searchClient.v2.search(fromQuery, params as any);

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

  /* ------------------------------------------------------------------ */
  /*  Fetch PRIVATE metrics via OAuth 1.0a (url_clicks, video retention) */
  /* ------------------------------------------------------------------ */

  async fetchPrivateMetricsByIds(
    tweetIds: string[]
  ): Promise<PrivateMetricsData[]> {
    if (!this.oauthClient) {
      throw new Error("[twitter] OAuth client required for private metrics");
    }
    if (!tweetIds.length) return [];

    const results: PrivateMetricsData[] = [];
    const BATCH = 100;

    for (let i = 0; i < tweetIds.length; i += BATCH) {
      const batch = tweetIds.slice(i, i + BATCH);
      try {
        const response = await this.oauthClient.v2.tweets(batch, {
          "tweet.fields": "public_metrics,non_public_metrics,organic_metrics",
          "media.fields": "public_metrics,non_public_metrics",
          expansions: "attachments.media_keys",
        });

        // Build media metrics map (video playback counts)
        const mediaMetrics = new Map<string, Record<string, number>>();
        if (response.includes?.media) {
          for (const m of response.includes.media) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mAny = m as any;
            const metrics = mAny.non_public_metrics ?? m.public_metrics;
            if (metrics) {
              mediaMetrics.set(m.media_key, metrics as unknown as Record<string, number>);
            }
          }
        }

        if (response.data) {
          for (const tweet of response.data) {
            const pub = tweet.public_metrics;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nonPub = (tweet as any).non_public_metrics ?? {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const organic = (tweet as any).organic_metrics ?? {};

            // Find video media playback metrics
            let playback: Record<string, number | null> = {
              playback_0: null, playback_25: null, playback_50: null,
              playback_75: null, playback_100: null,
            };

            const mediaKeys = tweet.attachments?.media_keys ?? [];
            for (const key of mediaKeys) {
              const mp = mediaMetrics.get(key);
              if (mp && (mp.playback_0_count !== undefined)) {
                playback = {
                  playback_0: mp.playback_0_count ?? null,
                  playback_25: mp.playback_25_count ?? null,
                  playback_50: mp.playback_50_count ?? null,
                  playback_75: mp.playback_75_count ?? null,
                  playback_100: mp.playback_100_count ?? null,
                };
                break;
              }
            }

            results.push({
              tweet_id: tweet.id,
              impressions: organic.impression_count ?? pub?.impression_count ?? 0,
              likes: pub?.like_count ?? 0,
              quotes: pub?.quote_count ?? 0,
              retweets: pub?.retweet_count ?? 0,
              bookmarks: pub?.bookmark_count ?? 0,
              replies: pub?.reply_count ?? 0,
              url_clicks: nonPub.url_link_clicks ?? organic.url_link_clicks ?? 0,
              profile_clicks: nonPub.user_profile_clicks ?? organic.user_profile_clicks ?? 0,
              view_count: (playback.playback_0 as number) ?? 0,
              playback_0: playback.playback_0,
              playback_25: playback.playback_25,
              playback_50: playback.playback_50,
              playback_75: playback.playback_75,
              playback_100: playback.playback_100,
            });
          }
        }
      } catch (err) {
        console.error(`[twitter] Private metrics batch error:`, err);
        if (err instanceof ApiResponseError && (err.code === 401 || err.code === 403)) {
          throw err; // auth issue, don't retry silently
        }
      }
    }

    console.log(
      `[twitter] Got private metrics for ${results.length}/${tweetIds.length} tweets`
    );
    return results;
  }
}
