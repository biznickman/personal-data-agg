const API_BASE = "https://api.twitterapi.io/twitter";

interface TweetAuthor {
  userName?: string;
}

export interface Tweet {
  id: string;
  text?: string;
  url?: string;
  createdAt?: string;
  viewCount?: number;
  likeCount?: number;
  quoteCount?: number;
  retweetCount?: number;
  bookmarkCount?: number;
  replyCount?: number;
  retweeted_tweet?: unknown;
  isReply?: boolean;
  quoted_tweet?: unknown;
  author?: TweetAuthor;
}

export interface SearchResult {
  tweets: Tweet[];
  cursor: string | null;
}

interface SearchApiResponse {
  tweets?: Tweet[];
  next_cursor?: string | null;
}

export interface TweetRow {
  tweet_id: string;
  canonical_tweet_id: string;
  is_latest_version: boolean;
  tweet_time: string | null;
  username: string | null;
  link: string | null;
  tweet_text: string | null;
  raw: Tweet;
  impressions: number | null;
  likes: number | null;
  quotes: number | null;
  retweets: number | null;
  bookmarks: number | null;
  replies: number | null;
  is_retweet: boolean;
  is_reply: boolean;
  is_quote: boolean;
  is_breakout: boolean;
  topic?: string;
}

export async function searchTweets(
  apiKey: string,
  query: string,
  cursor?: string | null
): Promise<SearchResult> {
  const params = new URLSearchParams({ query, queryType: "Latest" });
  if (cursor) params.set("cursor", cursor);

  const resp = await fetch(`${API_BASE}/tweet/advanced_search?${params}`, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Twitter API ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as SearchApiResponse;
  return { tweets: data.tweets || [], cursor: data.next_cursor || null };
}

export async function searchTweetsPaginated(
  apiKey: string,
  query: string,
  pages = 1
): Promise<Tweet[]> {
  const allTweets: Tweet[] = [];
  let cursor: string | null = null;

  for (let p = 0; p < pages; p++) {
    const result = await searchTweets(apiKey, query, cursor);
    allTweets.push(...result.tweets);
    if (!result.cursor) break;
    cursor = result.cursor;
    if (p < pages - 1) await new Promise((r) => setTimeout(r, 5500));
  }

  return allTweets;
}

export function tweetToRow(tweet: Tweet, topic?: string): TweetRow {
  const author = tweet.author ?? {};
  const tweetTime = tweet.createdAt
    ? new Date(tweet.createdAt).toISOString()
    : null;

  return {
    tweet_id: tweet.id,
    canonical_tweet_id: tweet.id,
    is_latest_version: true,
    tweet_time: tweetTime,
    username: author.userName ?? null,
    link: tweet.url ?? null,
    tweet_text: tweet.text ?? null,
    raw: tweet,
    impressions: tweet.viewCount ?? null,
    likes: tweet.likeCount ?? null,
    quotes: tweet.quoteCount ?? null,
    retweets: tweet.retweetCount ?? null,
    bookmarks: tweet.bookmarkCount ?? null,
    replies: tweet.replyCount ?? null,
    is_retweet: !!tweet.retweeted_tweet,
    is_reply: !!tweet.isReply,
    is_quote: !!tweet.quoted_tweet,
    is_breakout: false,
    ...(topic ? { topic } : {}),
  };
}
