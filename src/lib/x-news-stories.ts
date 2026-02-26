import { supabase } from "@/lib/supabase";

export interface StoryTweet {
  tweetId: string;
  username: string | null;
  tweetTime: string | null;
  link: string | null;
  tweetText: string | null;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  impressions: number | null;
  assignedAt: string | null;
  similarityScore: number | null;
}

export interface StoryCluster {
  clusterId: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  normalizedHeadline: string | null;
  normalizedFacts: string[];
  tweetCount: number;
  uniqueUserCount: number;
  isStoryCandidate: boolean;
  feedback: StoryFeedbackSummary;
  rankScore: number;
  tweets: StoryTweet[];
}

export interface GetLatestStoriesOptions {
  limit?: number;
  lookbackHours?: number;
  onlyStoryCandidates?: boolean;
  maxTweetsPerStory?: number;
}

export interface StoryFeedbackSummary {
  useful: number;
  noise: number;
  badCluster: number;
  total: number;
}

const STORY_MIN_TWEETS = 3;
const STORY_MIN_USERS  = 2;
const TWEET_CHUNK      = 300;
const CLUSTER_CHUNK    = 50;

type TweetRow = {
  id: number;
  tweet_id: string;
  username: string | null;
  tweet_time: string | null;
  link: string | null;
  tweet_text: string | null;
  normalized_headline: string | null;
  normalized_facts: unknown;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  impressions: number | null;
};

type PersistentClusterRow = {
  id: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  normalized_headline: string | null;
  normalized_facts: unknown;
  tweet_count: number;
  unique_user_count: number;
  is_story_candidate: boolean;
};

function parsePositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, max);
}

function toTimestamp(value: string | null): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toHoursAgo(value: string | null): number {
  const ts = toTimestamp(value);
  if (!Number.isFinite(ts)) return 48;
  const msAgo = Math.max(0, Date.now() - ts);
  return msAgo / (1000 * 60 * 60);
}

function toNullableNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function toStoryTweet(row: TweetRow): StoryTweet {
  return {
    tweetId: row.tweet_id,
    username: row.username,
    tweetTime: row.tweet_time,
    link: row.link,
    tweetText: row.tweet_text,
    likes: toNullableNumber(row.likes),
    retweets: toNullableNumber(row.retweets),
    replies: toNullableNumber(row.replies),
    quotes: toNullableNumber(row.quotes),
    bookmarks: toNullableNumber(row.bookmarks),
    impressions: toNullableNumber(row.impressions),
    assignedAt: null,
    similarityScore: null,
  };
}

function computeTweetEngagement(tweet: StoryTweet): number {
  return (
    (tweet.likes ?? 0) +
    (tweet.retweets ?? 0) * 2 +
    (tweet.quotes ?? 0) * 1.5 +
    (tweet.replies ?? 0) +
    (tweet.bookmarks ?? 0) * 0.2
  );
}

function scoreStory(params: {
  story: Omit<StoryCluster, "rankScore">;
  totalEngagement: number;
}): number {
  const { story, totalEngagement } = params;

  const hoursAgo = toHoursAgo(story.lastSeenAt);
  const freshness = Math.exp(-hoursAgo / 18);
  const volume = Math.log1p(story.tweetCount * Math.max(1, story.uniqueUserCount));
  const engagement = Math.log1p(Math.max(0, totalEngagement));
  const feedbackPenalty = Math.max(
    0,
    story.feedback.noise + story.feedback.badCluster - story.feedback.useful
  );

  const score =
    freshness * 120 +
    volume * 18 +
    engagement * 3 -
    feedbackPenalty * 8;

  return Number(score.toFixed(2));
}

// Pick the tweet to use as the cluster's headline/facts.
// Prefers tweets with a normalized_headline, ranked by engagement.
function pickHeadlineTweet(tweets: TweetRow[]): TweetRow | null {
  const withHeadline = tweets.filter((t) => t.normalized_headline?.trim());
  if (withHeadline.length === 0) return tweets[0] ?? null;

  return withHeadline.reduce((best, t) => {
    const bestScore = (best.likes ?? 0) + (best.retweets ?? 0) * 2 + (best.quotes ?? 0);
    const tScore    = (t.likes    ?? 0) + (t.retweets    ?? 0) * 2 + (t.quotes    ?? 0);
    return tScore > bestScore ? t : best;
  });
}

export async function getLatestXNewsStories(
  options: GetLatestStoriesOptions = {}
): Promise<StoryCluster[]> {
  const limit            = parsePositiveInt(options.limit, 50, 250);
  const lookbackHours    = parsePositiveInt(options.lookbackHours, 24, 48);
  const maxTweetsPerStory = parsePositiveInt(options.maxTweetsPerStory, 5, 20);
  const onlyStoryCandidates = options.onlyStoryCandidates ?? true;

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // Query 1: Load active clusters from persistent table
  const { data: clusterData, error: clusterError } = await supabase
    .from("x_news_clusters")
    .select(
      "id,first_seen_at,last_seen_at,normalized_headline,normalized_facts,tweet_count,unique_user_count,is_story_candidate"
    )
    .eq("is_active", true)
    .is("merged_into_cluster_id", null)
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(500);

  if (clusterError) {
    throw new Error(`Cluster query failed: ${clusterError.message}`);
  }

  const clusters = (clusterData ?? []) as PersistentClusterRow[];
  if (clusters.length === 0) return [];

  // Query 2: Load tweet memberships for all clusters, chunked by 50 cluster IDs
  const clusterIds = clusters.map((c) => c.id);
  const membershipMap = new Map<number, number[]>(); // cluster_id → db tweet ids

  for (let i = 0; i < clusterIds.length; i += CLUSTER_CHUNK) {
    const chunk = clusterIds.slice(i, i + CLUSTER_CHUNK);
    const { data: memberData, error: memberError } = await supabase
      .from("x_news_cluster_tweets")
      .select("tweet_id,cluster_id")
      .in("cluster_id", chunk);

    if (memberError) throw new Error(`Tweet membership load failed: ${memberError.message}`);

    for (const row of (memberData ?? []) as Array<{ tweet_id: number; cluster_id: number }>) {
      if (!membershipMap.has(row.cluster_id)) membershipMap.set(row.cluster_id, []);
      membershipMap.get(row.cluster_id)!.push(row.tweet_id);
    }
  }

  // Query 3: Load tweet content by DB id, chunked by 300
  const allDbIds = [...new Set([...membershipMap.values()].flat())];
  const allTweets: TweetRow[] = [];

  for (let i = 0; i < allDbIds.length; i += TWEET_CHUNK) {
    const chunk = allDbIds.slice(i, i + TWEET_CHUNK);
    const { data, error } = await supabase
      .from("tweets")
      .select(
        "id,tweet_id,username,tweet_time,link,tweet_text,normalized_headline,normalized_facts,likes,retweets,replies,quotes,bookmarks,impressions"
      )
      .in("id", chunk);

    if (error) throw new Error(`Tweet load failed: ${error.message}`);
    allTweets.push(...((data ?? []) as TweetRow[]));
  }

  const tweetByDbId = new Map(allTweets.map((t) => [t.id, t]));

  const stories = clusters.map((c) => {
    const memberDbIds = membershipMap.get(c.id) ?? [];
    const tweets = memberDbIds
      .map((id) => tweetByDbId.get(id))
      .filter((t): t is TweetRow => t !== undefined);

    const uniqueUsers = new Set(
      tweets.map((t) => (t.username ?? `id:${t.tweet_id}`).toLowerCase())
    ).size;

    const isStoryCandidate =
      tweets.length >= STORY_MIN_TWEETS && uniqueUsers >= STORY_MIN_USERS;

    const headlineTweet = pickHeadlineTweet(tweets);

    const storyTweets = tweets
      .map(toStoryTweet)
      .sort((a, b) => computeTweetEngagement(b) - computeTweetEngagement(a))
      .slice(0, maxTweetsPerStory);

    const totalEngagement = storyTweets.reduce(
      (sum, t) => sum + computeTweetEngagement(t),
      0
    );

    const feedback: StoryFeedbackSummary = { useful: 0, noise: 0, badCluster: 0, total: 0 };

    const baseStory = {
      clusterId:          c.id,
      firstSeenAt:        c.first_seen_at,
      lastSeenAt:         c.last_seen_at,
      normalizedHeadline: headlineTweet?.normalized_headline ?? c.normalized_headline ?? null,
      normalizedFacts:    toStringList(headlineTweet?.normalized_facts),
      tweetCount:         tweets.length,
      uniqueUserCount:    uniqueUsers,
      isStoryCandidate,
      feedback,
      tweets:             storyTweets,
    };

    return {
      ...baseStory,
      rankScore: scoreStory({ story: baseStory, totalEngagement }),
    };
  });

  const filtered = onlyStoryCandidates
    ? stories.filter((s) => s.isStoryCandidate)
    : stories;

  filtered.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;

    if (onlyStoryCandidates) {
      if (b.tweetCount !== a.tweetCount) return b.tweetCount - a.tweetCount;
      if (b.uniqueUserCount !== a.uniqueUserCount) return b.uniqueUserCount - a.uniqueUserCount;
      return toTimestamp(b.lastSeenAt) - toTimestamp(a.lastSeenAt);
    }

    if (a.isStoryCandidate !== b.isStoryCandidate) return a.isStoryCandidate ? -1 : 1;
    if (b.tweetCount !== a.tweetCount) return b.tweetCount - a.tweetCount;
    return toTimestamp(b.lastSeenAt) - toTimestamp(a.lastSeenAt);
  });

  return filtered.slice(0, limit);
}

export interface HomepageStories {
  ranked: StoryCluster[];
  newest: StoryCluster[];
}

export async function getHomepageStories(options?: {
  lookbackHours?: number;
  rankedLimit?: number;
  newestLimit?: number;
  maxTweetsPerStory?: number;
}): Promise<HomepageStories> {
  const rankedLimit = options?.rankedLimit ?? 20;
  const newestLimit = options?.newestLimit ?? 15;
  const maxNeeded = Math.max(rankedLimit, newestLimit) + 10;

  const stories = await getLatestXNewsStories({
    limit: maxNeeded,
    lookbackHours: options?.lookbackHours ?? 24,
    onlyStoryCandidates: true,
    maxTweetsPerStory: options?.maxTweetsPerStory ?? 10,
  });

  const ranked = stories.slice(0, rankedLimit);

  const newest = [...stories]
    .sort((a, b) => {
      const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, newestLimit);

  return { ranked, newest };
}
