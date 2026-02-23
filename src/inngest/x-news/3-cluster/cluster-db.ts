import { supabase } from "@/lib/supabase";

export interface ClusterStats {
  tweetCount: number;
  uniqueUserCount: number;
  isStoryCandidate: boolean;
  isPromoOrSpam: boolean;
}

interface StoryThresholds {
  minTweets: number;
  minUsers: number;
}

type ClusterTweetJoinedRow = {
  tweet_id: number;
  tweets: unknown;
};

type JoinedTweet = {
  username?: unknown;
  tweet_id?: unknown;
  tweet_text?: unknown;
};

type ClusterDetailsRow = {
  normalized_headline: string | null;
  normalized_facts: unknown;
};

const PROMO_SPAM_TERMS = [
  "airdrop",
  "claim",
  "claims",
  "wallet",
  "connect wallet",
  "giveaway",
  "distribution is live",
  "trading signal",
  "signal service",
  "telegram channel",
  "free signal",
  "free signals",
  "accuracy rate",
  "guaranteed returns",
  "dm for access",
];

const LOW_INFORMATION_HEADLINE_PATTERNS = [
  /^social media user\s/i,
  /^trader comments?\s/i,
  /^analysis:\s/i,
  /^unverified\s/i,
  /^user claims?\s/i,
];

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getStoryThresholds(): StoryThresholds {
  return {
    minTweets: parsePositiveInt(process.env.X_NEWS_CLUSTER_MIN_TWEETS, 3),
    minUsers: parsePositiveInt(process.env.X_NEWS_CLUSTER_MIN_USERS, 2),
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseNormalizedFacts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of input) {
    if (typeof value !== "string") continue;
    const cleaned = compactWhitespace(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }

  return out;
}

function getJoinedTweet(value: unknown): JoinedTweet | null {
  if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object") {
    return value[0] as JoinedTweet;
  }
  if (value && typeof value === "object") {
    return value as JoinedTweet;
  }
  return null;
}

function getUsername(joined: JoinedTweet | null): string | null {
  if (!joined || typeof joined.username !== "string") return null;
  const cleaned = joined.username.trim().toLowerCase();
  return cleaned || null;
}

function extractUserKey(row: ClusterTweetJoinedRow): string {
  const joined = getJoinedTweet(row.tweets);
  const username = getUsername(joined);
  if (username) return username;

  const tweetId = joined && typeof joined.tweet_id === "string" ? joined.tweet_id : null;
  if (tweetId) return `tweet:${tweetId}`;

  return `tweet_id:${row.tweet_id}`;
}

function countTermHits(text: string, terms: string[]): number {
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

function hasSuspiciousHandlePattern(usernames: string[]): boolean {
  if (usernames.length < 3) return false;
  const suspicious = usernames.filter((name) => /[0-9]{4,}/.test(name)).length;
  return suspicious / usernames.length >= 0.6;
}

function isLikelyPromoOrSpam(params: {
  headline: string | null;
  facts: string[];
  tweetTexts: string[];
  usernames: string[];
}): boolean {
  const combined = compactWhitespace(
    [params.headline ?? "", ...params.facts, ...params.tweetTexts].join(" ").toLowerCase()
  );
  if (!combined) return false;

  const termHits = countTermHits(combined, PROMO_SPAM_TERMS);
  const signalPattern = /(trading signal|signal service|telegram channel|accuracy rate|free signals?)/.test(
    combined
  );
  // Explicitly suppress recurring GWEI-style airdrop campaigns from story promotion.
  const gweiAirdropPattern = /\bgwei\b/.test(combined) && /\bairdrop\b/.test(combined);
  const suspiciousHandles = hasSuspiciousHandlePattern(params.usernames);

  if (gweiAirdropPattern) return true;
  if (signalPattern) return true;
  if (termHits >= 3) return true;
  if (termHits >= 2 && suspiciousHandles) return true;
  return false;
}

function isLikelyLowInformation(params: {
  headline: string | null;
  facts: string[];
}): boolean {
  const headline = compactWhitespace((params.headline ?? "").toLowerCase());
  const hasFacts = params.facts.length > 0;

  if (!hasFacts) return true;
  if (!headline) return true;
  return LOW_INFORMATION_HEADLINE_PATTERNS.some((pattern) => pattern.test(headline));
}

export async function recomputeClusterStats(clusterId: number): Promise<ClusterStats> {
  const { data: clusterData, error: clusterError } = await supabase
    .from("x_news_clusters")
    .select("normalized_headline,normalized_facts")
    .eq("id", clusterId)
    .maybeSingle();

  if (clusterError) {
    throw new Error(`Cluster details query failed: ${clusterError.message}`);
  }

  const clusterDetails = (clusterData ?? null) as ClusterDetailsRow | null;

  const { data, error } = await supabase
    .from("x_news_cluster_tweets")
    .select("tweet_id,tweets(username,tweet_id,tweet_text)")
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Cluster stats query failed: ${error.message}`);
  }

  const rows = (data ?? []) as ClusterTweetJoinedRow[];
  const userKeys = new Set(rows.map((row) => extractUserKey(row)));
  const usernames = rows
    .map((row) => getUsername(getJoinedTweet(row.tweets)))
    .filter((value): value is string => !!value);
  const tweetTexts = rows
    .map((row) => {
      const joined = getJoinedTweet(row.tweets);
      if (!joined || typeof joined.tweet_text !== "string") return null;
      const cleaned = compactWhitespace(joined.tweet_text);
      return cleaned || null;
    })
    .filter((value): value is string => !!value);

  const thresholds = getStoryThresholds();
  const facts = parseNormalizedFacts(clusterDetails?.normalized_facts);

  const tweetCount = rows.length;
  const uniqueUserCount = userKeys.size;
  const isPromoOrSpam = isLikelyPromoOrSpam({
    headline: clusterDetails?.normalized_headline ?? null,
    facts,
    tweetTexts,
    usernames,
  });
  const isLowInformation = isLikelyLowInformation({
    headline: clusterDetails?.normalized_headline ?? null,
    facts,
  });
  const isStoryCandidate =
    tweetCount >= thresholds.minTweets &&
    uniqueUserCount >= thresholds.minUsers &&
    !isPromoOrSpam &&
    !isLowInformation;

  const { error: updateError } = await supabase
    .from("x_news_clusters")
    .update({
      tweet_count: tweetCount,
      unique_user_count: uniqueUserCount,
      is_story_candidate: isStoryCandidate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", clusterId);

  if (updateError) {
    throw new Error(`Cluster stats update failed: ${updateError.message}`);
  }

  return {
    tweetCount,
    uniqueUserCount,
    isStoryCandidate,
    isPromoOrSpam,
  };
}
