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
    limit: 300,
    provider: process.env.X_NEWS_EMBED_PROVIDER || "openai",
    model:
      process.env.X_NEWS_EMBED_MODEL ||
      (process.env.X_NEWS_EMBED_PROVIDER === "openrouter"
        ? "openai/text-embedding-3-small"
        : "text-embedding-3-small"),
    dupThreshold: 0.82,
    textMode: process.env.X_NEWS_EMBED_TEXT_MODE || "headline_only",
    assignThreshold: null,
    mergeThreshold: null,
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
    if (arg === "--assign-threshold" && next) {
      options.assignThreshold = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--merge-threshold" && next) {
      options.mergeThreshold = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--text-mode" && next) {
      options.textMode = String(next);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.hours) || options.hours <= 0) options.hours = 24;
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 300;
  if (!Number.isFinite(options.dupThreshold) || options.dupThreshold <= 0 || options.dupThreshold >= 1) {
    options.dupThreshold = 0.82;
  }
  if (
    !Number.isFinite(options.assignThreshold) ||
    options.assignThreshold <= 0 ||
    options.assignThreshold >= 1
  ) {
    options.assignThreshold = null;
  }
  if (
    !Number.isFinite(options.mergeThreshold) ||
    options.mergeThreshold <= 0 ||
    options.mergeThreshold >= 1
  ) {
    options.mergeThreshold = null;
  }
  if (options.textMode !== "headline_and_facts") options.textMode = "headline_only";

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

function buildText(headline, facts, mode) {
  const cleanedHeadline = compactWhitespace(headline || "");
  if (mode === "headline_only") return cleanedHeadline;
  return [cleanedHeadline, ...facts].map(compactWhitespace).filter(Boolean).join("\n");
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
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  return union <= 0 ? 0 : intersection / union;
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
      "tweet_id,username,tweet_time,tweet_text,link,normalized_headline,normalized_facts,is_latest_version,is_retweet,is_reply"
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
      headline: tweet.normalized_headline,
      facts: parseFacts(tweet.normalized_facts),
      firstSeenAt: tweet.tweet_time,
      lastSeenAt: tweet.tweet_time,
      tweets: [tweet],
      centroid: vector,
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

function summarizeClusters(clusters, vectors, dupThreshold) {
  const active = clusters.filter((cluster) => !cluster.mergedInto);

  const enriched = active.map((cluster) => {
    const uniqueUsers = new Set(
      cluster.tweets.map((tweet) => String(tweet.username || `tweet:${tweet.tweet_id}`).toLowerCase())
    ).size;

    const isStoryCandidateRaw = cluster.tweets.length >= 3 && uniqueUsers >= 2;
    const promoFiltered = isLikelyPromoOrSpam(cluster);

    const memberVectors = cluster.tweets
      .map((tweet) => vectors[tweet._embedIndex])
      .filter((vec) => Array.isArray(vec));

    return {
      ...cluster,
      tweetCount: cluster.tweets.length,
      uniqueUsers,
      isStoryCandidateRaw,
      isStoryCandidateFiltered: isStoryCandidateRaw && !promoFiltered,
      promoFiltered,
      centroid: meanVector(memberVectors),
    };
  });

  const residualPairs = [];
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      const a = enriched[i];
      const b = enriched[j];
      if (!a.centroid.length || !b.centroid.length) continue;

      const similarity = cosineSimilarity(a.centroid, b.centroid);
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

  const stories = enriched
    .filter((cluster) => cluster.isStoryCandidateFiltered)
    .sort(
      (a, b) =>
        b.tweetCount - a.tweetCount ||
        b.uniqueUsers - a.uniqueUsers ||
        new Date(b.lastSeenAt || "").getTime() - new Date(a.lastSeenAt || "").getTime()
    )
    .map((cluster) => ({
      cluster_id: cluster.id,
      headline: cluster.headline,
      tweet_count: cluster.tweetCount,
      unique_users: cluster.uniqueUsers,
      first_seen_at: cluster.firstSeenAt,
      last_seen_at: cluster.lastSeenAt,
      tweets: cluster.tweets
        .slice()
        .sort(
          (a, b) => new Date(b.tweet_time || "").getTime() - new Date(a.tweet_time || "").getTime()
        )
        .slice(0, 8)
        .map((tweet) => ({
          tweet_id: tweet.tweet_id,
          username: tweet.username,
          tweet_time: tweet.tweet_time,
          link: tweet.link,
          tweet_text: tweet.tweet_text,
        })),
    }));

  return {
    clusters: enriched.length,
    singletons: enriched.filter((cluster) => cluster.tweetCount === 1).length,
    multi: enriched.filter((cluster) => cluster.tweetCount > 1).length,
    storyRaw: enriched.filter((cluster) => cluster.isStoryCandidateRaw).length,
    storyFiltered: stories.length,
    promoFilteredClusters: enriched.filter((cluster) => cluster.promoFiltered).length,
    largest: enriched.reduce((max, cluster) => Math.max(max, cluster.tweetCount), 0),
    residualDupPairs: residualPairs.length,
    topResidualPairs: residualPairs.slice(0, 8),
    stories,
  };
}

function scoreSummary(summary) {
  let score = 0;
  score += summary.storyFiltered * 120;
  score += summary.multi * 3;
  score -= summary.residualDupPairs * 80;
  score -= summary.singletons * 1.5;
  score -= Math.max(0, summary.largest - 35) * 8;
  return score;
}

function lexicalBaseline(tweets, textMode, config) {
  const clusters = [];
  let nextId = 1;

  for (const tweet of tweets) {
    const facts = parseFacts(tweet.normalized_facts);
    const tokens = tokenize(buildText(tweet.normalized_headline, facts, textMode));
    if (!tokens.length) continue;

    let best = null;
    for (const cluster of clusters) {
      if (cluster.mergedInto) continue;
      const similarity = jaccardSimilarity(tokens, cluster.tokens);
      if (!best || similarity > best.similarity) best = { cluster, similarity };
    }

    if (best && best.similarity >= config.assignThreshold) {
      best.cluster.tokens = Array.from(new Set([...best.cluster.tokens, ...tokens])).slice(0, 260);
      best.cluster.tweets.push(tweet);
      continue;
    }

    clusters.push({
      id: nextId,
      tokens,
      headline: tweet.normalized_headline,
      facts,
      tweets: [tweet],
      mergedInto: null,
    });
    nextId += 1;
  }

  return clusters.filter((cluster) => !cluster.mergedInto).length;
}

async function main() {
  const options = parseArgs();
  const tweetsRaw = await fetchTweets(options.hours, options.limit);

  const tweets = tweetsRaw
    .map((tweet, idx) => ({
      ...tweet,
      normalized_headline: compactWhitespace(tweet.normalized_headline || ""),
      _embedIndex: idx,
    }))
    .filter((tweet) => tweet.normalized_headline);

  if (!tweets.length) {
    console.log("No normalized tweets found for selected window.");
    return;
  }

  const embeddingTexts = tweets.map((tweet) =>
    buildText(tweet.normalized_headline, parseFacts(tweet.normalized_facts), options.textMode)
  );

  const embed = await embedTexts(embeddingTexts, options.provider, options.model);

  const configs = [];

  if (options.assignThreshold !== null && options.mergeThreshold !== null) {
    configs.push({
      assignThreshold: options.assignThreshold,
      mergeThreshold: options.mergeThreshold,
      name: `forced_${options.assignThreshold.toFixed(2)}_${options.mergeThreshold.toFixed(2)}`,
    });
  } else {
    const assignCandidates = [0.72, 0.75, 0.78, 0.81, 0.84];
    const mergeCandidates = [0.8, 0.82, 0.84, 0.86, 0.88];

    for (const assignThreshold of assignCandidates) {
      for (const mergeThreshold of mergeCandidates) {
        configs.push({
          assignThreshold,
          mergeThreshold,
          name: `emb_${assignThreshold.toFixed(2)}_${mergeThreshold.toFixed(2)}`,
        });
      }
    }
  }

  const results = [];
  for (const config of configs) {
    const clusters = embeddingClusters(tweets, embed.vectors, config);
    const summary = summarizeClusters(clusters, embed.vectors, options.dupThreshold);
    const score = scoreSummary(summary);

    results.push({
      ...config,
      score,
      summary,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  const lexicalClusterCount = lexicalBaseline(
    tweets,
    options.textMode,
    { assignThreshold: 0.3, mergeThreshold: 0.45 }
  );

  const output = {
    generated_at: new Date().toISOString(),
    options,
    input_tweets: tweets.length,
    lexical_baseline_clusters: lexicalClusterCount,
    embedding: {
      provider: embed.provider,
      model: embed.model,
      total_tokens: embed.totalTokens,
      estimated_cost_usd: Number(embed.estimatedCostUSD.toFixed(6)),
    },
    best_config: {
      name: best.name,
      assign_threshold: best.assignThreshold,
      merge_threshold: best.mergeThreshold,
      score: best.score,
      metrics: {
        clusters: best.summary.clusters,
        singletons: best.summary.singletons,
        multi: best.summary.multi,
        story_raw: best.summary.storyRaw,
        story_filtered: best.summary.storyFiltered,
        promo_filtered_clusters: best.summary.promoFilteredClusters,
        residual_dup_pairs: best.summary.residualDupPairs,
        largest: best.summary.largest,
      },
    },
    top_configs: results.slice(0, 8).map((row) => ({
      name: row.name,
      assign_threshold: row.assignThreshold,
      merge_threshold: row.mergeThreshold,
      score: row.score,
      clusters: row.summary.clusters,
      singletons: row.summary.singletons,
      story_filtered: row.summary.storyFiltered,
      residual_dup_pairs: row.summary.residualDupPairs,
    })),
    stories: best.summary.stories,
    residual_duplicate_pairs: best.summary.topResidualPairs,
  };

  const outputDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = output.generated_at.replace(/[:.]/g, "-");
  const timestampedPath = path.join(outputDir, `embedding-story-preview-${timestamp}.json`);
  const latestPath = path.join(outputDir, "embedding-story-preview-latest.json");

  fs.writeFileSync(timestampedPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(output, null, 2));

  console.log(`input_tweets=${tweets.length} window_hours=${options.hours} limit=${options.limit}`);
  console.log(
    `embedding_provider=${embed.provider} model=${embed.model} tokens=${embed.totalTokens} est_cost_usd=${embed.estimatedCostUSD.toFixed(6)}`
  );
  console.table(
    output.top_configs.map((row) => ({
      config: row.name,
      assign: row.assign_threshold,
      merge: row.merge_threshold,
      score: row.score,
      clusters: row.clusters,
      singletons: row.singletons,
      story_filtered: row.story_filtered,
      residual_dup_pairs: row.residual_dup_pairs,
    }))
  );
  console.log(`best_config=${output.best_config.name}`);
  console.log(`stories_generated=${output.stories.length}`);
  console.log(`saved=${timestampedPath}`);
  console.log(`saved=${latestPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
