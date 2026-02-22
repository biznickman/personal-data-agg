#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.local"), quiet: true });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DEFAULT_HOURS = 24;
const DEFAULT_TOP = 20;
const DEFAULT_MIN_CLUSTER_SIZE = 2;
const DEFAULT_MIN_UNIQUE_USERS = 2;
const PAGE_SIZE = 1000;
const MAX_BUCKET_PAIRING = 200;
const MAX_PAIR_TIME_DELTA_HOURS = 12;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "these",
  "those",
  "into",
  "their",
  "they",
  "you",
  "your",
  "our",
  "about",
  "after",
  "before",
  "over",
  "under",
  "new",
  "now",
  "just",
  "via",
  "rt",
  "breaking",
  "update",
  "latest",
]);

const PROMO_TERMS = [
  "airdrop",
  "eligibility",
  "claim",
  "wallet",
  "connect wallet",
  "reward",
  "giveaway",
  "distribution is live",
  "check your wallet",
  "instant eligibility",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    hours: DEFAULT_HOURS,
    top: DEFAULT_TOP,
    minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
    minUniqueUsers: DEFAULT_MIN_UNIQUE_USERS,
    allowPromo: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--hours" && next) {
      options.hours = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--top" && next) {
      options.top = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--min-cluster-size" && next) {
      options.minClusterSize = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--min-unique-users" && next) {
      options.minUniqueUsers = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--allow-promo") {
      options.allowPromo = true;
      continue;
    }
  }

  if (!Number.isFinite(options.hours) || options.hours <= 0) {
    options.hours = DEFAULT_HOURS;
  }
  if (!Number.isFinite(options.top) || options.top <= 0) {
    options.top = DEFAULT_TOP;
  }
  if (!Number.isFinite(options.minClusterSize) || options.minClusterSize <= 1) {
    options.minClusterSize = DEFAULT_MIN_CLUSTER_SIZE;
  }
  if (!Number.isFinite(options.minUniqueUsers) || options.minUniqueUsers <= 0) {
    options.minUniqueUsers = DEFAULT_MIN_UNIQUE_USERS;
  }

  return options;
}

function canonicalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = "";
    const dropParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "ref_src"];
    for (const k of dropParams) {
      parsed.searchParams.delete(k);
    }
    const search = parsed.searchParams.toString();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return null;
  }
}

function isSocialStatusUrl(url) {
  if (!url) return false;
  return (
    /https?:\/\/(x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(url) ||
    /https?:\/\/t\.co\//i.test(url)
  );
}

function extractUrls(tweet) {
  const urls = new Set();
  const text = String(tweet.tweet_text || "");
  const textUrls = text.match(/https?:\/\/\S+/gi) || [];
  for (const u of textUrls) {
    const cleaned = canonicalizeUrl(u);
    if (cleaned) urls.add(cleaned);
  }

  const entityUrls = tweet.raw?.entities?.urls;
  if (Array.isArray(entityUrls)) {
    for (const u of entityUrls) {
      const expanded = canonicalizeUrl(u?.expanded_url || u?.url);
      if (expanded) urls.add(expanded);
    }
  }

  const cardUrl = canonicalizeUrl(tweet.raw?.card?.url);
  if (cardUrl) urls.add(cardUrl);

  const filtered = new Set();
  for (const u of urls) {
    if (!isSocialStatusUrl(u)) filtered.add(u);
  }
  return filtered;
}

function extractSymbols(tweet) {
  const symbols = new Set();
  const entities = tweet.raw?.entities;
  const symbolsArr = entities?.symbols;
  if (Array.isArray(symbolsArr)) {
    for (const s of symbolsArr) {
      if (s?.text) {
        symbols.add(String(s.text).toUpperCase());
      }
    }
  }

  const cashtags = String(tweet.tweet_text || "").match(/\$[A-Za-z]{2,10}\b/g) || [];
  for (const t of cashtags) {
    symbols.add(t.slice(1).toUpperCase());
  }

  return symbols;
}

function extractHashtags(tweet) {
  const tags = new Set();
  const hashtagsArr = tweet.raw?.entities?.hashtags;
  if (Array.isArray(hashtagsArr)) {
    for (const h of hashtagsArr) {
      if (h?.text) tags.add(String(h.text).toLowerCase());
    }
  }
  return tags;
}

function extractReferenceId(tweet) {
  const quoteId = tweet.raw?.quoted_tweet?.id;
  const retweetId = tweet.raw?.retweeted_tweet?.id;
  const replyId = tweet.raw?.inReplyToId;
  return String(quoteId || retweetId || replyId || "");
}

function tokenize(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[a-z0-9_]+/g, " ")
    .replace(/[$#]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = normalized.split(" ").filter(Boolean);
  const tokens = [];
  for (const token of parts) {
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return Array.from(new Set(tokens));
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function toEngagement(row) {
  const likes = Number(row.likes || 0);
  const quotes = Number(row.quotes || 0);
  const retweets = Number(row.retweets || 0);
  const bookmarks = Number(row.bookmarks || 0);
  const replies = Number(row.replies || 0);
  return likes + quotes + retweets + bookmarks + replies;
}

function toEngagementRate(row) {
  const impressions = Number(row.impressions || 0);
  if (impressions <= 0) return 0;
  return toEngagement(row) / impressions;
}

function isPromotionalText(text) {
  const normalized = String(text || "").toLowerCase();
  for (const term of PROMO_TERMS) {
    if (normalized.includes(term)) return true;
  }
  return false;
}

async function fetchTweets(hours) {
  const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("tweets")
      .select(
        "id,tweet_id,tweet_time,username,tweet_text,link,impressions,likes,quotes,retweets,bookmarks,replies,is_retweet,is_reply,is_quote,is_latest_version,raw,topic"
      )
      .eq("is_latest_version", true)
      .eq("is_retweet", false)
      .eq("is_reply", false)
      .gte("tweet_time", sinceDate)
      .order("tweet_time", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch tweets: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB;
      return;
    }
    if (this.rank[rootA] > this.rank[rootB]) {
      this.parent[rootB] = rootA;
      return;
    }
    this.parent[rootB] = rootA;
    this.rank[rootA] += 1;
  }
}

function connectByBuckets(indices, getKey, uf) {
  const map = new Map();
  for (const idx of indices) {
    const keys = getKey(idx);
    if (!keys || keys.length === 0) continue;
    for (const key of keys) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(idx);
    }
  }

  for (const [, members] of map) {
    if (members.length < 2) continue;
    for (let i = 1; i < members.length; i += 1) {
      uf.union(members[0], members[i]);
    }
  }
}

function buildStoryCandidates(processed) {
  const uf = new UnionFind(processed.length);
  const indices = processed.map((_, i) => i);

  connectByBuckets(
    indices,
    (idx) => Array.from(processed[idx].urls),
    uf
  );
  connectByBuckets(
    indices,
    (idx) => (processed[idx].referenceId ? [processed[idx].referenceId] : []),
    uf
  );

  const symbolAndTagBuckets = new Map();
  for (const i of indices) {
    const keys = [
      ...Array.from(processed[i].symbols).map((s) => `sym:${s}`),
      ...Array.from(processed[i].hashtags).map((h) => `tag:${h}`),
    ];
    for (const key of keys) {
      if (!symbolAndTagBuckets.has(key)) symbolAndTagBuckets.set(key, []);
      symbolAndTagBuckets.get(key).push(i);
    }
  }

  const maxDeltaMs = MAX_PAIR_TIME_DELTA_HOURS * 60 * 60 * 1000;
  for (const [, bucket] of symbolAndTagBuckets) {
    if (bucket.length < 2 || bucket.length > MAX_BUCKET_PAIRING) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const a = processed[bucket[i]];
      for (let j = i + 1; j < bucket.length; j += 1) {
        const b = processed[bucket[j]];
        if (Math.abs(a.timeMs - b.timeMs) > maxDeltaMs) continue;

        const sharedSymbols = Array.from(a.symbols).some((s) => b.symbols.has(s));
        const sharedHashtags = Array.from(a.hashtags).some((h) => b.hashtags.has(h));
        if (!sharedSymbols && !sharedHashtags) continue;

        const jac = jaccard(a.tokenSet, b.tokenSet);
        if (jac >= 0.35) {
          uf.union(bucket[i], bucket[j]);
        }
      }
    }
  }

  const groups = new Map();
  for (const i of indices) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(processed[i]);
  }

  return Array.from(groups.values());
}

function summarizeCluster(cluster) {
  const users = new Set(cluster.map((t) => t.username || "unknown"));
  const symbols = new Set();
  const hashtags = new Set();
  const urls = new Set();

  let totalEngagement = 0;
  let maxImpressions = 0;
  let maxEngRate = 0;
  let promotionalTweetCount = 0;

  for (const t of cluster) {
    totalEngagement += t.engagement;
    if (t.impressions > maxImpressions) maxImpressions = t.impressions;
    if (t.engagementRate > maxEngRate) maxEngRate = t.engagementRate;
    for (const s of t.symbols) symbols.add(s);
    for (const h of t.hashtags) hashtags.add(h);
    for (const u of t.urls) urls.add(u);
    if (isPromotionalText(t.tweet_text)) promotionalTweetCount += 1;
  }

  const lead = [...cluster].sort((a, b) => {
    if (b.engagement !== a.engagement) return b.engagement - a.engagement;
    return b.timeMs - a.timeMs;
  })[0];

  const latest = cluster.reduce((acc, item) => (item.timeMs > acc ? item.timeMs : acc), 0);
  const uniqueUsers = users.size;
  const tweetCount = cluster.length;
  const promoRatio = tweetCount > 0 ? promotionalTweetCount / tweetCount : 0;

  const signalScore =
    uniqueUsers * 2 +
    Math.min(6, Math.log10(maxImpressions + 1)) +
    Math.min(6, Math.log10(totalEngagement + 1)) +
    Math.min(4, maxEngRate * 100) +
    (urls.size > 0 ? 1 : 0);

  return {
    signalScore,
    tweetCount,
    uniqueUsers,
    symbols: Array.from(symbols).slice(0, 8),
    hashtags: Array.from(hashtags).slice(0, 8),
    urls: Array.from(urls).slice(0, 5),
    promoRatio,
    latestAt: new Date(latest).toISOString(),
    leadTweet: {
      tweetId: lead.tweet_id,
      username: lead.username,
      text: lead.tweet_text,
      link: lead.link,
      engagement: lead.engagement,
      impressions: lead.impressions,
      engagementRate: lead.engagementRate,
      time: lead.tweet_time,
    },
    sampleTweets: [...cluster]
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 3)
      .map((t) => ({
        tweetId: t.tweet_id,
        username: t.username,
        text: t.tweet_text,
        link: t.link,
        engagement: t.engagement,
        impressions: t.impressions,
        time: t.tweet_time,
      })),
  };
}

function printSummary(options, fetchedCount, candidates) {
  console.log("");
  console.log(`Story scan window: last ${options.hours}h`);
  console.log(`Fetched tweets: ${fetchedCount}`);
  console.log(`Candidate stories (>=${options.minClusterSize} tweets): ${candidates.length}`);
  console.log("");

  if (candidates.length === 0) {
    console.log("No candidate stories found with current thresholds.");
    return;
  }

  const top = candidates.slice(0, options.top);
  top.forEach((story, idx) => {
    const lead = story.leadTweet;
    const shortText = String(lead.text || "").replace(/\s+/g, " ").slice(0, 180);
    console.log(
      `${idx + 1}. score=${story.signalScore.toFixed(2)} tweets=${story.tweetCount} users=${story.uniqueUsers} latest=${story.latestAt}`
    );
    console.log(`   lead: @${lead.username} | ${shortText}`);
    if (story.symbols.length > 0) {
      console.log(`   symbols: ${story.symbols.join(", ")}`);
    }
    if (story.urls.length > 0) {
      console.log(`   url: ${story.urls[0]}`);
    }
  });
}

async function main() {
  const options = parseArgs();
  const tweets = await fetchTweets(options.hours);

  const processed = tweets.map((tweet) => {
    const tokens = tokenize(tweet.tweet_text);
    const tokenSet = new Set(tokens);
    const urls = extractUrls(tweet);
    const symbols = extractSymbols(tweet);
    const hashtags = extractHashtags(tweet);
    const referenceId = extractReferenceId(tweet);
    const engagement = toEngagement(tweet);
    const engagementRate = toEngagementRate(tweet);

    return {
      id: tweet.id,
      tweet_id: tweet.tweet_id,
      tweet_time: tweet.tweet_time,
      timeMs: new Date(tweet.tweet_time || 0).getTime(),
      username: tweet.username || "unknown",
      tweet_text: tweet.tweet_text || "",
      link: tweet.link || null,
      tokens,
      tokenSet,
      urls,
      symbols,
      hashtags,
      referenceId,
      engagement,
      engagementRate,
      impressions: Number(tweet.impressions || 0),
      raw: tweet.raw,
    };
  });

  const rawClusters = buildStoryCandidates(processed);
  const summarized = rawClusters
    .filter((cluster) => cluster.length >= options.minClusterSize)
    .map((cluster) => summarizeCluster(cluster))
    .filter((cluster) => cluster.uniqueUsers >= options.minUniqueUsers)
    .filter((cluster) => (options.allowPromo ? true : cluster.promoRatio < 0.4))
    .sort((a, b) => {
      if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
      return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
    });

  printSummary(options, processed.length, summarized);

  const outputDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `story-candidates-${options.hours}h-${stamp}.json`);

  const output = {
    generatedAt: new Date().toISOString(),
    hours: options.hours,
    minClusterSize: options.minClusterSize,
    fetchedTweetCount: processed.length,
    candidateCount: summarized.length,
    candidates: summarized,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log("");
  console.log(`Wrote JSON output: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
