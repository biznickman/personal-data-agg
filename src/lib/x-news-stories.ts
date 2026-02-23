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

type ClusterRow = {
  id: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  normalized_headline: string | null;
  normalized_facts: unknown;
  tweet_count: number | null;
  unique_user_count: number | null;
  is_story_candidate: boolean | null;
};

type JoinedTweet = {
  tweet_id?: unknown;
  username?: unknown;
  tweet_time?: unknown;
  link?: unknown;
  tweet_text?: unknown;
  likes?: unknown;
  retweets?: unknown;
  replies?: unknown;
  quotes?: unknown;
  bookmarks?: unknown;
  impressions?: unknown;
};

type ClusterTweetRow = {
  cluster_id: number;
  assigned_at: string | null;
  similarity_score: number | null;
  tweets: unknown;
};

type FeedbackLabel = "useful" | "noise" | "bad_cluster";

type ClusterFeedbackRow = {
  cluster_id: number;
  label: FeedbackLabel;
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

function createEmptyFeedbackSummary(): StoryFeedbackSummary {
  return {
    useful: 0,
    noise: 0,
    badCluster: 0,
    total: 0,
  };
}

function toHoursAgo(value: string | null): number {
  const ts = toTimestamp(value);
  if (!Number.isFinite(ts)) return 48;
  const msAgo = Math.max(0, Date.now() - ts);
  return msAgo / (1000 * 60 * 60);
}

function computeTweetEngagement(tweet: StoryTweet): number {
  const likes = tweet.likes ?? 0;
  const retweets = tweet.retweets ?? 0;
  const quotes = tweet.quotes ?? 0;
  const replies = tweet.replies ?? 0;
  const bookmarks = tweet.bookmarks ?? 0;

  return likes + retweets * 2 + quotes * 1.5 + replies + bookmarks * 0.2;
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

function toStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }

  return out;
}

function toNullableNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickJoinedTweet(value: unknown): JoinedTweet | null {
  if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object") {
    return value[0] as JoinedTweet;
  }
  if (value && typeof value === "object") {
    return value as JoinedTweet;
  }
  return null;
}

function toStoryTweet(row: ClusterTweetRow): StoryTweet | null {
  const joined = pickJoinedTweet(row.tweets);
  if (!joined || typeof joined.tweet_id !== "string") return null;

  return {
    tweetId: joined.tweet_id,
    username: typeof joined.username === "string" ? joined.username : null,
    tweetTime: typeof joined.tweet_time === "string" ? joined.tweet_time : null,
    link: typeof joined.link === "string" ? joined.link : null,
    tweetText: typeof joined.tweet_text === "string" ? joined.tweet_text : null,
    likes: toNullableNumber(joined.likes),
    retweets: toNullableNumber(joined.retweets),
    replies: toNullableNumber(joined.replies),
    quotes: toNullableNumber(joined.quotes),
    bookmarks: toNullableNumber(joined.bookmarks),
    impressions: toNullableNumber(joined.impressions),
    assignedAt: row.assigned_at,
    similarityScore: toNullableNumber(row.similarity_score),
  };
}

export async function getLatestXNewsStories(
  options: GetLatestStoriesOptions = {}
): Promise<StoryCluster[]> {
  const limit = parsePositiveInt(options.limit, 50, 250);
  const lookbackHours = parsePositiveInt(options.lookbackHours, 24, 24 * 7);
  const maxTweetsPerStory = parsePositiveInt(options.maxTweetsPerStory, 5, 20);
  const onlyStoryCandidates = options.onlyStoryCandidates ?? true;

  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  let clusterQuery = supabase
    .from("x_news_clusters")
    .select(
      "id,first_seen_at,last_seen_at,normalized_headline,normalized_facts,tweet_count,unique_user_count,is_story_candidate"
    )
    .is("merged_into_cluster_id", null)
    .gte("last_seen_at", cutoff)
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (onlyStoryCandidates) {
    clusterQuery = clusterQuery.eq("is_story_candidate", true);
  }

  const { data: clusterData, error: clusterError } = await clusterQuery;

  if (clusterError) {
    throw new Error(`Story cluster query failed: ${clusterError.message}`);
  }

  const clusters = (clusterData ?? []) as ClusterRow[];
  if (clusters.length === 0) {
    return [];
  }

  const clusterIds = clusters.map((cluster) => cluster.id);
  const { data: tweetData, error: tweetError } = await supabase
    .from("x_news_cluster_tweets")
    .select(
      "cluster_id,assigned_at,similarity_score,tweets(tweet_id,username,tweet_time,link,tweet_text,likes,retweets,replies,quotes,bookmarks,impressions)"
    )
    .in("cluster_id", clusterIds)
    .order("assigned_at", { ascending: false });

  if (tweetError) {
    throw new Error(`Story tweet query failed: ${tweetError.message}`);
  }

  const groupedTweets = new Map<number, StoryTweet[]>();
  const engagementByCluster = new Map<number, number>();
  for (const row of (tweetData ?? []) as ClusterTweetRow[]) {
    const parsed = toStoryTweet(row);
    if (!parsed) continue;

    const existingEngagement = engagementByCluster.get(row.cluster_id) ?? 0;
    engagementByCluster.set(
      row.cluster_id,
      existingEngagement + computeTweetEngagement(parsed)
    );

    const existing = groupedTweets.get(row.cluster_id) ?? [];
    if (existing.length >= maxTweetsPerStory) {
      groupedTweets.set(row.cluster_id, existing);
      continue;
    }

    existing.push(parsed);
    groupedTweets.set(row.cluster_id, existing);
  }

  const feedbackByCluster = new Map<number, StoryFeedbackSummary>();
  const { data: feedbackData, error: feedbackError } = await supabase
    .from("x_news_cluster_feedback")
    .select("cluster_id,label")
    .in("cluster_id", clusterIds)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (!feedbackError) {
    for (const row of (feedbackData ?? []) as ClusterFeedbackRow[]) {
      const current = feedbackByCluster.get(row.cluster_id) ?? createEmptyFeedbackSummary();
      if (row.label === "useful") current.useful += 1;
      if (row.label === "noise") current.noise += 1;
      if (row.label === "bad_cluster") current.badCluster += 1;
      current.total += 1;
      feedbackByCluster.set(row.cluster_id, current);
    }
  } else {
    console.warn(`Story feedback query failed: ${feedbackError.message}`);
  }

  const stories = clusters.map((cluster) => {
    const baseStory = {
    clusterId: cluster.id,
    firstSeenAt: cluster.first_seen_at,
    lastSeenAt: cluster.last_seen_at,
    normalizedHeadline: cluster.normalized_headline,
    normalizedFacts: toStringList(cluster.normalized_facts),
    tweetCount: typeof cluster.tweet_count === "number" ? cluster.tweet_count : 0,
    uniqueUserCount:
      typeof cluster.unique_user_count === "number" ? cluster.unique_user_count : 0,
    isStoryCandidate: cluster.is_story_candidate === true,
    feedback: feedbackByCluster.get(cluster.id) ?? createEmptyFeedbackSummary(),
    tweets: groupedTweets.get(cluster.id) ?? [],
    };

    return {
      ...baseStory,
      rankScore: scoreStory({
        story: baseStory,
        totalEngagement: engagementByCluster.get(cluster.id) ?? 0,
      }),
    };
  });

  stories.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;

    if (onlyStoryCandidates) {
      if (b.tweetCount !== a.tweetCount) return b.tweetCount - a.tweetCount;
      if (b.uniqueUserCount !== a.uniqueUserCount) return b.uniqueUserCount - a.uniqueUserCount;
      return toTimestamp(b.lastSeenAt) - toTimestamp(a.lastSeenAt);
    }

    if (a.isStoryCandidate !== b.isStoryCandidate) {
      return a.isStoryCandidate ? -1 : 1;
    }
    if (b.tweetCount !== a.tweetCount) return b.tweetCount - a.tweetCount;
    return toTimestamp(b.lastSeenAt) - toTimestamp(a.lastSeenAt);
  });

  return stories;
}
