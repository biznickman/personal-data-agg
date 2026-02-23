#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.local"), quiet: true });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env.local");
  process.exit(1);
}

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    hours: 24,
    limit: 250,
    provider: process.env.X_NEWS_EMBED_PROVIDER || "openai",
    model:
      process.env.X_NEWS_EMBED_MODEL ||
      (process.env.X_NEWS_EMBED_PROVIDER === "openrouter"
        ? "openai/text-embedding-3-small"
        : "text-embedding-3-small"),
    dupThreshold: 0.88,
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
    if (arg === "--provider" && next) {
      options.provider = String(next);
      i += 1;
      continue;
    }
    if (arg === "--model" && next) {
      options.model = String(next);
      i += 1;
      continue;
    }
    if (arg === "--dup-threshold" && next) {
      options.dupThreshold = Number(next);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.hours) || options.hours <= 0) options.hours = 24;
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 250;
  if (!Number.isFinite(options.dupThreshold) || options.dupThreshold <= 0 || options.dupThreshold >= 1) {
    options.dupThreshold = 0.88;
  }

  options.hours = Math.min(Math.floor(options.hours), 24 * 7);
  options.limit = Math.min(Math.floor(options.limit), 1000);

  return options;
}

function compactWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFacts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== "string") continue;
    const cleaned = compactWhitespace(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.slice(0, 20);
}

function tokenize(text, maxTokens = 240) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9$][a-z0-9$._-]*/g) || [];
  const out = [];
  const seen = new Set();

  for (const raw of matches) {
    const token = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (!token) continue;

    const isTicker = token.startsWith("$") && token.length > 1;
    const isNumeric = /^[0-9]+(?:\.[0-9]+)?$/.test(token);

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
  const out = [];
  const seen = new Set();
  for (const token of [...a, ...b]) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

function dot(a, b) {
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out += a[i] * b[i];
  return out;
}

function magnitude(v) {
  return Math.sqrt(dot(v, v));
}

function cosineSimilarity(a, b) {
  const mag = magnitude(a) * magnitude(b);
  if (mag === 0) return 0;
  return dot(a, b) / mag;
}

function meanVector(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i += 1) out[i] += vec[i];
  }
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length;
  return out;
}

function chooseMergeDirection(a, b) {
  if (a.tweets.length !== b.tweets.length) {
    return a.tweets.length > b.tweets.length
      ? { source: b, target: a }
      : { source: a, target: b };
  }

  const aFirst = new Date(a.firstSeenAt || "").getTime();
  const bFirst = new Date(b.firstSeenAt || "").getTime();

  if (!Number.isNaN(aFirst) && !Number.isNaN(bFirst) && aFirst !== bFirst) {
    return aFirst <= bFirst
      ? { source: b, target: a }
      : { source: a, target: b };
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
  const tweetTexts = cluster.tweets.map((tweet) => compactWhitespace(tweet.tweet_text || "")).filter(Boolean);

  const combined = compactWhitespace(
    [cluster.headline || "", ...cluster.facts, ...tweetTexts].join(" ").toLowerCase()
  );

  if (!combined) return false;

  const suspiciousHandleRatio =
    usernames.length >= 3
      ? usernames.filter((username) => /[0-9]{4,}/.test(username)).length / usernames.length
      : 0;

  const termHits = countTermHits(combined, PROMO_SPAM_TERMS);
  const signalPattern = /(trading signal|signal service|telegram channel|accuracy rate|free signals?)/.test(
    combined
  );
  const gweiAirdropPattern = /\bgwei\b/.test(combined) && /\bairdrop\b/.test(combined);

  if (gweiAirdropPattern) return true;
  if (signalPattern) return true;
  if (termHits >= 3) return true;
  if (termHits >= 2 && suspiciousHandleRatio >= 0.6) return true;

  return false;
}

async function fetchTweets(hours, limit) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("tweets")
    .select(
      "tweet_id,username,tweet_time,tweet_text,normalized_headline,normalized_facts,is_latest_version,is_retweet,is_reply"
    )
    .gte("tweet_time", since)
    .not("normalized_headline", "is", null)
    .eq("is_latest_version", true)
    .eq("is_retweet", false)
    .eq("is_reply", false)
    .order("tweet_time", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Tweet fetch failed: ${error.message}`);
  }

  return data || [];
}

function embeddingClient(provider, model) {
  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY for provider=openrouter");

    return {
      url: "https://openrouter.ai/api/v1/embeddings",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      model,
      unitCostPer1MToken: 0.02,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY for provider=openai");

  return {
    url: "https://api.openai.com/v1/embeddings",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    model,
    unitCostPer1MToken: 0.02,
  };
}

async function embedTexts(texts, provider, model) {
  const client = embeddingClient(provider, model);
  const BATCH_SIZE = 100;
  const vectors = new Array(texts.length);
  let totalTokens = 0;

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE).map((text) => text.slice(0, 4000));

    const response = await fetch(client.url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({
        model: client.model,
        input: batch,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${errBody}`);
    }

    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data : [];
    if (data.length !== batch.length) {
      throw new Error(`Embedding response size mismatch: expected ${batch.length}, got ${data.length}`);
    }

    for (let i = 0; i < data.length; i += 1) {
      vectors[start + i] = data[i].embedding;
    }

    if (payload.usage && Number.isFinite(payload.usage.total_tokens)) {
      totalTokens += payload.usage.total_tokens;
    }
  }

  return {
    vectors,
    totalTokens,
    estimatedCostUSD: (totalTokens / 1_000_000) * client.unitCostPer1MToken,
    provider,
    model: client.model,
  };
}

function makeClusterSummary(clusters, tweetVectors, dupThreshold) {
  const active = clusters.filter((cluster) => !cluster.mergedInto);

  const enriched = active.map((cluster) => {
    const uniqueUsers = new Set(
      cluster.tweets.map((tweet) => String(tweet.username || `tweet:${tweet.tweet_id}`).toLowerCase())
    ).size;

    const isStoryCandidateRaw = cluster.tweets.length >= 3 && uniqueUsers >= 2;
    const promoFiltered = isLikelyPromoOrSpam(cluster);

    const memberVectors = cluster.tweets
      .map((tweet) => tweetVectors[tweet._embedIndex])
      .filter((vec) => Array.isArray(vec));

    return {
      ...cluster,
      tweetCount: cluster.tweets.length,
      uniqueUsers,
      isStoryCandidateRaw,
      isStoryCandidateFiltered: isStoryCandidateRaw && !promoFiltered,
      promoFiltered,
      semanticCentroid: meanVector(memberVectors),
    };
  });

  const residualPairs = [];
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      const a = enriched[i];
      const b = enriched[j];
      if (!a.semanticCentroid.length || !b.semanticCentroid.length) continue;
      const similarity = cosineSimilarity(a.semanticCentroid, b.semanticCentroid);
      if (similarity >= dupThreshold) {
        residualPairs.push({
          aId: a.id,
          bId: b.id,
          similarity,
          aSize: a.tweetCount,
          bSize: b.tweetCount,
          aHeadline: a.headline,
          bHeadline: b.headline,
        });
      }
    }
  }

  residualPairs.sort((x, y) => y.similarity - x.similarity);

  return {
    clusters: enriched.length,
    singletons: enriched.filter((cluster) => cluster.tweetCount === 1).length,
    multi: enriched.filter((cluster) => cluster.tweetCount > 1).length,
    storyRaw: enriched.filter((cluster) => cluster.isStoryCandidateRaw).length,
    storyFiltered: enriched.filter((cluster) => cluster.isStoryCandidateFiltered).length,
    promoFilteredClusters: enriched.filter((cluster) => cluster.promoFiltered).length,
    largest: enriched.reduce((max, cluster) => Math.max(max, cluster.tweetCount), 0),
    residualDupPairs: residualPairs.length,
    topResidualPairs: residualPairs.slice(0, 6),
  };
}

function lexicalClusters(tweets, config) {
  const clusters = [];
  let nextId = 1;

  for (const tweet of tweets) {
    const headline = compactWhitespace(tweet.normalized_headline || "");
    const facts = parseFacts(tweet.normalized_facts);
    const text = config.textMode === "headline_only" ? headline : [headline, ...facts].join("\n");
    const tokens = tokenize(text);
    if (!tokens.length) continue;

    let best = null;
    for (const cluster of clusters) {
      if (cluster.mergedInto) continue;
      const similarity = jaccardSimilarity(tokens, cluster.tokens);
      if (!best || similarity > best.similarity) {
        best = { cluster, similarity };
      }
    }

    if (best && best.similarity >= config.assignThreshold) {
      best.cluster.tokens = mergeTokenSets(best.cluster.tokens, tokens);
      best.cluster.tweets.push(tweet);
      if (new Date(tweet.tweet_time || "").getTime() > new Date(best.cluster.lastSeenAt || "").getTime()) {
        best.cluster.lastSeenAt = tweet.tweet_time;
      }
      continue;
    }

    clusters.push({
      id: nextId,
      headline,
      facts,
      tokens,
      firstSeenAt: tweet.tweet_time,
      lastSeenAt: tweet.tweet_time,
      tweets: [tweet],
      mergedInto: null,
    });
    nextId += 1;
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
    if (new Date(bestMerge.source.lastSeenAt || "").getTime() > new Date(bestMerge.target.lastSeenAt || "").getTime()) {
      bestMerge.target.lastSeenAt = bestMerge.source.lastSeenAt;
    }
    bestMerge.source.mergedInto = bestMerge.target.id;
  }

  return clusters;
}

function embeddingClusters(tweets, vectors, config) {
  const clusters = [];
  let nextId = 1;

  for (const tweet of tweets) {
    const vector = vectors[tweet._embedIndex];
    if (!Array.isArray(vector)) continue;

    let best = null;
    for (const cluster of clusters) {
      if (cluster.mergedInto) continue;
      const similarity = cosineSimilarity(vector, cluster.centroid);
      if (!best || similarity > best.similarity) {
        best = { cluster, similarity };
      }
    }

    if (best && best.similarity >= config.assignThreshold) {
      best.cluster.tweets.push(tweet);
      const members = best.cluster.tweets.map((item) => vectors[item._embedIndex]);
      best.cluster.centroid = meanVector(members);
      if (new Date(tweet.tweet_time || "").getTime() > new Date(best.cluster.lastSeenAt || "").getTime()) {
        best.cluster.lastSeenAt = tweet.tweet_time;
      }
      continue;
    }

    clusters.push({
      id: nextId,
      headline: compactWhitespace(tweet.normalized_headline || ""),
      facts: parseFacts(tweet.normalized_facts),
      centroid: vector,
      firstSeenAt: tweet.tweet_time,
      lastSeenAt: tweet.tweet_time,
      tweets: [tweet],
      mergedInto: null,
    });
    nextId += 1;
  }

  for (const source of clusters) {
    if (source.mergedInto) continue;
    let bestMerge = null;

    for (const other of clusters) {
      if (other.id === source.id || other.mergedInto) continue;
      const similarity = cosineSimilarity(source.centroid, other.centroid);
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

    bestMerge.target.tweets.push(...bestMerge.source.tweets);
    const members = bestMerge.target.tweets.map((item) => vectors[item._embedIndex]);
    bestMerge.target.centroid = meanVector(members);
    if (new Date(bestMerge.source.lastSeenAt || "").getTime() > new Date(bestMerge.target.lastSeenAt || "").getTime()) {
      bestMerge.target.lastSeenAt = bestMerge.source.lastSeenAt;
    }
    bestMerge.source.mergedInto = bestMerge.target.id;
  }

  return clusters;
}

async function main() {
  const options = parseArgs();

  const tweets = await fetchTweets(options.hours, options.limit);
  const cleaned = tweets
    .map((tweet, index) => ({
      ...tweet,
      normalized_headline: compactWhitespace(tweet.normalized_headline || ""),
      _embedIndex: index,
    }))
    .filter((tweet) => tweet.normalized_headline);

  if (!cleaned.length) {
    console.log("No normalized tweets found in selected window.");
    return;
  }

  const embeddingInput = cleaned.map((tweet) => tweet.normalized_headline);
  const embed = await embedTexts(embeddingInput, options.provider, options.model);

  const lexicalConfig = {
    assignThreshold: 0.3,
    mergeThreshold: 0.45,
    textMode: "headline_only",
  };

  const embeddingConfigs = [
    { name: "embedding_0.82_0.88", assignThreshold: 0.82, mergeThreshold: 0.88 },
    { name: "embedding_0.85_0.90", assignThreshold: 0.85, mergeThreshold: 0.9 },
  ];

  const lexical = lexicalClusters(cleaned, lexicalConfig);
  const lexicalSummary = makeClusterSummary(lexical, embed.vectors, options.dupThreshold);

  const embeddingSummaries = embeddingConfigs.map((cfg) => {
    const clusters = embeddingClusters(cleaned, embed.vectors, cfg);
    return {
      name: cfg.name,
      assignThreshold: cfg.assignThreshold,
      mergeThreshold: cfg.mergeThreshold,
      summary: makeClusterSummary(clusters, embed.vectors, options.dupThreshold),
    };
  });

  console.log(`input_tweets=${cleaned.length} window_hours=${options.hours} limit=${options.limit}`);
  console.log(
    `embedding_provider=${embed.provider} model=${embed.model} tokens=${embed.totalTokens} est_cost_usd=${embed.estimatedCostUSD.toFixed(
      6
    )}`
  );

  const tableRows = [
    {
      method: "lexical_headline_only",
      assign: lexicalConfig.assignThreshold,
      merge: lexicalConfig.mergeThreshold,
      clusters: lexicalSummary.clusters,
      singletons: lexicalSummary.singletons,
      multi: lexicalSummary.multi,
      story_filtered: lexicalSummary.storyFiltered,
      promo_filtered: lexicalSummary.promoFilteredClusters,
      residual_dup_pairs: lexicalSummary.residualDupPairs,
      largest: lexicalSummary.largest,
    },
    ...embeddingSummaries.map((item) => ({
      method: item.name,
      assign: item.assignThreshold,
      merge: item.mergeThreshold,
      clusters: item.summary.clusters,
      singletons: item.summary.singletons,
      multi: item.summary.multi,
      story_filtered: item.summary.storyFiltered,
      promo_filtered: item.summary.promoFilteredClusters,
      residual_dup_pairs: item.summary.residualDupPairs,
      largest: item.summary.largest,
    })),
  ];

  console.table(tableRows);

  function printResidual(title, summary) {
    console.log(`\n${title} residual semantic duplicate pairs (top 6, threshold=${options.dupThreshold})`);
    if (!summary.topResidualPairs.length) {
      console.log("(none)");
      return;
    }
    for (const pair of summary.topResidualPairs) {
      console.log(
        `${pair.aId}<->${pair.bId} sim=${pair.similarity.toFixed(3)} sizes=${pair.aSize}/${pair.bSize}`
      );
      console.log(`  A: ${pair.aHeadline}`);
      console.log(`  B: ${pair.bHeadline}`);
    }
  }

  printResidual("lexical_headline_only", lexicalSummary);
  for (const item of embeddingSummaries) {
    printResidual(item.name, item.summary);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
