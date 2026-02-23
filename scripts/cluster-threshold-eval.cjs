#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.local"), quiet: true });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STOPWORDS = new Set([
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
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

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

const DEFAULT_CONFIGS = [
  { label: "baseline", assignThreshold: 0.33, mergeThreshold: 0.72 },
  { label: "merge_only_tuned", assignThreshold: 0.33, mergeThreshold: 0.5 },
  { label: "recommended", assignThreshold: 0.3, mergeThreshold: 0.45 },
  { label: "aggressive", assignThreshold: 0.28, mergeThreshold: 0.42 },
];

const MIN_TWEETS = 3;
const MIN_USERS = 2;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    hours: 24,
    limit: 2000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--hours" && next) {
      options.hours = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      options.limit = Number(next);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.hours) || options.hours <= 0) options.hours = 24;
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 2000;

  options.hours = Math.min(Math.floor(options.hours), 24 * 7);
  options.limit = Math.min(Math.floor(options.limit), 10000);
  return options;
}

function compactWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFacts(input) {
  const values = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const out = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = compactWhitespace(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }

  return out.slice(0, 20);
}

function canonicalText(headline, facts) {
  return [headline || "", ...facts].map(compactWhitespace).filter(Boolean).join("\n");
}

function isNumericToken(token) {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(token);
}

function tokenize(text, maxTokens = 240) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9$][a-z0-9$._-]*/g) || [];
  const out = [];
  const seen = new Set();

  for (const raw of matches) {
    const token = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (!token) continue;

    const isTicker = token.startsWith("$") && token.length > 1;
    const isNumeric = isNumericToken(token);
    if (!isTicker && !isNumeric && token.length < 3) continue;
    if (!isTicker && STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;

    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }

  return out;
}

function jaccardSimilarity(a, b) {
  if (!a.length || !b.length) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function mergeTokenSets(a, b, maxTokens = 260) {
  const merged = [];
  const seen = new Set();

  for (const token of [...a, ...b]) {
    if (seen.has(token)) continue;
    seen.add(token);
    merged.push(token);
    if (merged.length >= maxTokens) break;
  }

  return merged;
}

function toTimestamp(value) {
  const ts = new Date(value || "").getTime();
  return Number.isNaN(ts) ? Number.NaN : ts;
}

function chooseMergeDirection(a, b) {
  if (a.tweets.length !== b.tweets.length) {
    return a.tweets.length > b.tweets.length
      ? { source: b, target: a }
      : { source: a, target: b };
  }

  const aFirst = toTimestamp(a.firstSeenAt);
  const bFirst = toTimestamp(b.firstSeenAt);

  if (!Number.isNaN(aFirst) && !Number.isNaN(bFirst) && aFirst !== bFirst) {
    return aFirst <= bFirst ? { source: b, target: a } : { source: a, target: b };
  }

  return a.id < b.id ? { source: b, target: a } : { source: a, target: b };
}

function countTermHits(text, terms) {
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

function isLikelyPromoOrSpam(cluster) {
  const usernames = cluster.tweets
    .map((tweet) => String(tweet.username || "").trim().toLowerCase())
    .filter(Boolean);
  const tweetTexts = cluster.tweets
    .map((tweet) => compactWhitespace(tweet.tweet_text || ""))
    .filter(Boolean);

  const combined = compactWhitespace(
    [cluster.headline || "", ...cluster.facts, ...tweetTexts].join(" ").toLowerCase()
  );

  const suspiciousHandleRatio =
    usernames.length >= 3
      ? usernames.filter((username) => /[0-9]{4,}/.test(username)).length / usernames.length
      : 0;

  const termHits = countTermHits(combined, PROMO_SPAM_TERMS);
  const signalPattern = /(trading signal|signal service|telegram channel|accuracy rate|free signals?)/.test(
    combined
  );

  if (signalPattern) return true;
  if (termHits >= 3) return true;
  if (termHits >= 2 && suspiciousHandleRatio >= 0.6) return true;

  return false;
}

function simulateClusters(tweets, config) {
  const clusters = [];
  let nextClusterId = 1;

  for (const tweet of tweets) {
    const facts = parseFacts(tweet.normalized_facts);
    const canonical = canonicalText(tweet.normalized_headline, facts);
    const tokens = tokenize(canonical);

    if (tokens.length === 0) continue;

    let best = null;
    for (const cluster of clusters) {
      if (cluster.mergedInto) continue;
      const similarity = jaccardSimilarity(tokens, cluster.tokens);
      if (!best || similarity > best.similarity) {
        best = { cluster, similarity };
      }
    }

    if (best && best.similarity >= config.assignThreshold) {
      const target = best.cluster;
      target.tokens = mergeTokenSets(target.tokens, tokens);
      target.tweets.push(tweet);
      if (toTimestamp(tweet.tweet_time) > toTimestamp(target.lastSeenAt)) {
        target.lastSeenAt = tweet.tweet_time;
      }
      continue;
    }

    clusters.push({
      id: nextClusterId,
      headline: tweet.normalized_headline,
      facts,
      tokens,
      firstSeenAt: tweet.tweet_time,
      lastSeenAt: tweet.tweet_time,
      tweets: [tweet],
      mergedInto: null,
    });
    nextClusterId += 1;
  }

  for (const source of clusters) {
    if (source.mergedInto) continue;

    let bestMerge = null;
    for (const other of clusters) {
      if (other.id === source.id || other.mergedInto) continue;
      const similarity = jaccardSimilarity(source.tokens, other.tokens);
      if (similarity < config.mergeThreshold) continue;

      const direction = chooseMergeDirection(source, other);
      if (direction.source.id !== source.id) continue;

      if (!bestMerge || similarity > bestMerge.similarity) {
        bestMerge = {
          source: direction.source,
          target: direction.target,
          similarity,
        };
      }
    }

    if (!bestMerge) continue;

    bestMerge.target.tokens = mergeTokenSets(bestMerge.target.tokens, bestMerge.source.tokens);
    bestMerge.target.tweets.push(...bestMerge.source.tweets);
    if (toTimestamp(bestMerge.source.lastSeenAt) > toTimestamp(bestMerge.target.lastSeenAt)) {
      bestMerge.target.lastSeenAt = bestMerge.source.lastSeenAt;
    }
    bestMerge.source.mergedInto = bestMerge.target.id;
  }

  const active = clusters.filter((cluster) => !cluster.mergedInto);
  const withStats = active.map((cluster) => {
    const uniqueUsers = new Set(
      cluster.tweets.map((tweet) => String(tweet.username || `tweet:${tweet.tweet_id}`).toLowerCase())
    ).size;

    const isStoryCandidateRaw =
      cluster.tweets.length >= MIN_TWEETS && uniqueUsers >= MIN_USERS;
    const promoFiltered = isLikelyPromoOrSpam(cluster);

    return {
      ...cluster,
      tweetCount: cluster.tweets.length,
      uniqueUsers,
      isStoryCandidateRaw,
      isStoryCandidateFiltered: isStoryCandidateRaw && !promoFiltered,
      promoFiltered,
    };
  });

  let redundantPairs = 0;
  for (let i = 0; i < withStats.length; i += 1) {
    for (let j = i + 1; j < withStats.length; j += 1) {
      const similarity = jaccardSimilarity(withStats[i].tokens, withStats[j].tokens);
      if (similarity >= 0.45) redundantPairs += 1;
    }
  }

  return {
    clusters: withStats.length,
    singletonClusters: withStats.filter((cluster) => cluster.tweetCount === 1).length,
    multiTweetClusters: withStats.filter((cluster) => cluster.tweetCount > 1).length,
    storyCandidatesRaw: withStats.filter((cluster) => cluster.isStoryCandidateRaw).length,
    storyCandidatesFiltered: withStats.filter((cluster) => cluster.isStoryCandidateFiltered).length,
    promoFilteredClusters: withStats.filter((cluster) => cluster.promoFiltered).length,
    largestClusterSize: withStats.reduce((max, cluster) => Math.max(max, cluster.tweetCount), 0),
    redundantPairs,
  };
}

async function fetchNormalizedTweets(hours, limit) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("tweets")
    .select(
      "tweet_id,username,tweet_time,tweet_text,normalized_headline,normalized_facts,is_retweet,is_reply,is_latest_version"
    )
    .gte("tweet_time", since)
    .not("normalized_headline", "is", null)
    .eq("is_latest_version", true)
    .eq("is_retweet", false)
    .eq("is_reply", false)
    .order("tweet_time", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch normalized tweets: ${error.message}`);
  }

  return data || [];
}

async function main() {
  const options = parseArgs();
  const tweets = await fetchNormalizedTweets(options.hours, options.limit);

  console.log(`window_hours=${options.hours} limit=${options.limit} input_tweets=${tweets.length}`);

  const results = DEFAULT_CONFIGS.map((config) => ({
    ...config,
    ...simulateClusters(tweets, config),
  }));

  console.table(
    results.map((result) => ({
      config: result.label,
      assign: result.assignThreshold,
      merge: result.mergeThreshold,
      clusters: result.clusters,
      singletons: result.singletonClusters,
      multi: result.multiTweetClusters,
      story_raw: result.storyCandidatesRaw,
      story_filtered: result.storyCandidatesFiltered,
      promo_filtered: result.promoFilteredClusters,
      redundant_pairs: result.redundantPairs,
      largest: result.largestClusterSize,
    }))
  );

  const recommended = results.find((result) => result.label === "recommended");
  if (recommended) {
    console.log("\nrecommended_defaults", {
      X_NEWS_CLUSTER_ASSIGN_THRESHOLD: recommended.assignThreshold,
      X_NEWS_CLUSTER_MERGE_THRESHOLD: recommended.mergeThreshold,
      rationale: "better consolidation than baseline without aggressive over-merging",
    });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
