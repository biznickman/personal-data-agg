/**
 * Formats an enriched tweet from the X API v2 into an x_posts row.
 * Adapted from ~/Dev/internalx/src/operations/fetchTweets.ts formatTweet()
 *
 * Simplifications vs InternalX:
 * - No separate image/video/URL tables — just format type + raw JSON
 * - Maps directly to x_posts schema
 */

import type { EnrichedTweet } from "./twitter-service";

export interface XPostRow {
  tweet_id: string;
  tweet_text: string | null;
  tweet_time: string | null;
  username: string | null;
  format: string;
  impressions: number;
  likes: number;
  retweets: number;
  quotes: number;
  bookmarks: number;
  replies: number;
  url_clicks: number | null;
  profile_clicks: number | null;
  view_count: number | null;
  playback_0: number | null;
  playback_25: number | null;
  playback_50: number | null;
  playback_75: number | null;
  playback_100: number | null;
  link: string;
  is_reply: boolean;
  is_quote: boolean;
  is_retweet: boolean;
  is_latest_version: boolean;
  canonical_tweet_id: string | null;
  raw: unknown;
}

/**
 * Convert an enriched API tweet into our flat x_posts row.
 * Returns null for retweets (we skip them).
 */
export function formatTweet(tweet: EnrichedTweet): XPostRow | null {
  // Skip retweets
  const isRetweet =
    tweet.referenced_tweets?.some((ref) => ref.type === "retweeted") ?? false;
  if (isRetweet) return null;

  const isReply =
    tweet.referenced_tweets?.some((ref) => ref.type === "replied_to") ?? false;
  const isQuote =
    tweet.referenced_tweets?.some((ref) => ref.type === "quoted") ?? false;

  // Detect format
  let format = "text";
  const hasSpacesUrl = tweet.entities?.urls?.some((u) =>
    u.expanded_url?.includes("/i/spaces/")
  );
  if (hasSpacesUrl) {
    format = "spaces";
  } else if (tweet.media && tweet.media.length > 0) {
    const allPhotos = tweet.media.every((m) => m.type === "photo");
    if (tweet.media.length > 1 && !allPhotos) {
      format = "mixed";
    } else if (allPhotos) {
      format = "photo";
    } else {
      format = tweet.media[0].type; // 'video', 'animated_gif', etc.
    }
  }

  // Handle edited tweets
  const editHistory = tweet.edit_history_tweet_ids ?? [tweet.id];
  const canonicalId = editHistory[0];

  // Extract private metrics if available (OAuth responses include these)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tweetAny = tweet as any;
  const nonPub = tweetAny.non_public_metrics ?? {};
  const organic = tweetAny.organic_metrics ?? {};

  // Video playback from media public_metrics
  let playback: Record<string, number | null> = {
    playback_0: null, playback_25: null, playback_50: null,
    playback_75: null, playback_100: null,
  };
  if (tweet.media) {
    for (const m of tweet.media) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mAny = m as any;
      // Playback counts live in media.non_public_metrics (OAuth) or media.public_metrics
      const mp = mAny.non_public_metrics ?? mAny.public_metrics;
      if (mp && mp.playback_0_count !== undefined) {
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
  }

  const hasPrivate = Object.keys(nonPub).length > 0 || Object.keys(organic).length > 0;

  return {
    tweet_id: tweet.id,
    tweet_text: tweet.note_tweet?.text ?? tweet.text ?? null,
    tweet_time: tweet.created_at ?? null,
    username: tweet.author?.username ?? "chooserich",
    format,
    impressions: organic.impression_count ?? tweet.public_metrics?.impression_count ?? 0,
    likes: tweet.public_metrics?.like_count ?? 0,
    retweets: tweet.public_metrics?.retweet_count ?? 0,
    quotes: tweet.public_metrics?.quote_count ?? 0,
    bookmarks: tweet.public_metrics?.bookmark_count ?? 0,
    replies: tweet.public_metrics?.reply_count ?? 0,
    url_clicks: hasPrivate ? (nonPub.url_link_clicks ?? organic.url_link_clicks ?? 0) : null,
    profile_clicks: hasPrivate ? (nonPub.user_profile_clicks ?? organic.user_profile_clicks ?? 0) : null,
    view_count: playback.playback_0,
    playback_0: playback.playback_0,
    playback_25: playback.playback_25,
    playback_50: playback.playback_50,
    playback_75: playback.playback_75,
    playback_100: playback.playback_100,
    link: `https://twitter.com/${tweet.author?.username ?? "chooserich"}/status/${tweet.id}`,
    is_reply: isReply,
    is_quote: isQuote,
    is_retweet: false,
    is_latest_version: true,
    canonical_tweet_id: canonicalId,
    raw: tweet,
  };
}
