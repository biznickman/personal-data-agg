#!/usr/bin/env node
/**
 * cluster-stability-eval.cjs
 *
 * Compares three clustering strategies on the same tweet sample to evaluate
 * the impact of centroid drift and embedding input richness.
 *
 *   A  lexical          Jaccard similarity on token sets (current production default)
 *   B  drift-centroid   Cosine on headline-only embeddings; centroid = mean of all
 *                       members, recomputed on every assignment (best-case production)
 *   C  stable-identity  Cosine on headline+facts embeddings; cluster embedding is
 *                       the founding tweet's vector, NEVER mutated on assignment or merge
 *
 * "Drift magnitude" for method B = average angular distance between a cluster's
 * identity (founding tweet vector) and its final centroid. This quantifies how
 * far the cluster has wandered from its original meaning.
 *
 * Usage:
 *   node scripts/cluster-stability-eval.cjs [options]
 *
 * Options:
 *   --hours N        Lookback window in hours (default: 24)
 *   --limit N        Max tweets to load (default: 300)
 *   --provider google|openai|openrouter   Embedding provider (default: google)
 *   --model MODEL    Embedding model name (default: gemini-embedding-001)
 *   --assign-b N     Assign threshold for method B (default: 0.78)
 *   --merge-b N      Merge threshold for method B (default: 0.86)
 *   --assign-c N     Assign threshold for method C (default: 0.76)
 *   --merge-c N      Merge threshold for method C (default: 0.84)
 *   --dup-threshold N  Similarity above which two distinct clusters are considered
 *                      residual duplicates (default: 0.86)
 */

"use strict";

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "their", "this", "to", "was", "were", "will", "with",
]);

const PROMO_SPAM_TERMS = [
  "airdrop", "claim", "claims", "wallet", "connect wallet", "giveaway",
  "distribution is live", "trading signal", "signal service", "telegram channel",
  "free signal", "free signals", "accuracy rate", "guaranteed returns", "dm for access",
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    hours: 24,
    limit: 300,
    provider: process.env.X_NEWS_EMBED_PROVIDER || "google",
    model: process.env.X_NEWS_EMBED_MODEL || "gemini-embedding-001",
    assignB: 0.78,
    mergeB: 0.86,
    assignC: 0.76,
    mergeC: 0.84,
    dupThreshold: 0.86,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (!val) continue;
    if (key === "--hours")          { opts.hours = Number(val); i++; }
    else if (key === "--limit")     { opts.limit = Number(val); i++; }
    else if (key === "--provider")  { opts.provider = val; i++; }
    else if (key === "--model")     { opts.model = val; i++; }
    else if (key === "--assign-b")  { opts.assignB = Number(val); i++; }
    else if (key === "--merge-b")   { opts.mergeB = Number(val); i++; }
    else if (key === "--assign-c")  { opts.assignC = Number(val); i++; }
    else if (key === "--merge-c")   { opts.mergeC = Number(val); i++; }
    else if (key === "--dup-threshold") { opts.dupThreshold = Number(val); i++; }
  }

  if (!Number.isFinite(opts.hours) || opts.hours <= 0) opts.hours = 24;
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = 300;
  opts.hours = Math.min(Math.floor(opts.hours), 24 * 7);
  opts.limit = Math.min(Math.floor(opts.limit), 2000);

  if (opts.provider === "openrouter" && !opts.model.includes("/")) {
    opts.model = `openai/${opts.model}`;
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function compact(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function parseFacts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = compact(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 12);
}

function headlineOnly(tweet) {
  return compact(tweet.normalized_headline || "");
}

function headlineAndFacts(tweet) {
  const h = headlineOnly(tweet);
  const facts = parseFacts(tweet.normalized_facts);
  return [h, ...facts].filter(Boolean).join(". ");
}

// ---------------------------------------------------------------------------
// Tokenization (Jaccard)
// ---------------------------------------------------------------------------

function tokenize(text, max = 240) {
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
    if (out.length >= max) break;
  }
  return out;
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  let intersection = 0;
  for (const t of b) { if (setA.has(t)) intersection++; }
  return intersection / (setA.size + b.length - intersection);
}

function mergeTokens(a, b, max = 260) {
  const seen = new Set(a);
  const out = [...a];
  for (const t of b) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function mag(v) { return Math.sqrt(dot(v, v)); }

function cosine(a, b) {
  const m = mag(a) * mag(b);
  return m === 0 ? 0 : dot(a, b) / m;
}

function mean(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

// ---------------------------------------------------------------------------
// Merge direction heuristic (same as production)
// ---------------------------------------------------------------------------

function mergeDirection(a, b) {
  if (a.tweets.length !== b.tweets.length) {
    return a.tweets.length > b.tweets.length
      ? { source: b, target: a }
      : { source: a, target: b };
  }
  const aMs = new Date(a.firstSeenAt || "").getTime();
  const bMs = new Date(b.firstSeenAt || "").getTime();
  if (!isNaN(aMs) && !isNaN(bMs) && aMs !== bMs) {
    return aMs <= bMs ? { source: b, target: a } : { source: a, target: b };
  }
  return a.id < b.id ? { source: b, target: a } : { source: a, target: b };
}

// ---------------------------------------------------------------------------
// Promo/spam detection
// ---------------------------------------------------------------------------

function isPromoOrSpam(cluster) {
  const usernames = cluster.tweets.map((t) => compact(t.username || "").toLowerCase()).filter(Boolean);
  const tweetTexts = cluster.tweets.map((t) => compact(t.tweet_text || "")).filter(Boolean);
  const combined = compact([cluster.headline, ...cluster.facts, ...tweetTexts].join(" ").toLowerCase());
  if (!combined) return false;

  const suspiciousRatio = usernames.length >= 3
    ? usernames.filter((u) => /[0-9]{4,}/.test(u)).length / usernames.length
    : 0;

  const termHits = PROMO_SPAM_TERMS.filter((t) => combined.includes(t)).length;
  const signalPattern = /(trading signal|signal service|telegram channel|accuracy rate|free signals?)/.test(combined);
  const gweiAirdrop = /\bgwei\b/.test(combined) && /\bairdrop\b/.test(combined);

  return gweiAirdrop || signalPattern || termHits >= 3 || (termHits >= 2 && suspiciousRatio >= 0.6);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchTweets(opts) {
  const since = new Date(Date.now() - opts.hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("tweets")
    .select("tweet_id,username,tweet_time,tweet_text,link,normalized_headline,normalized_facts,is_latest_version,is_retweet,is_reply")
    .gte("tweet_time", since)
    .not("normalized_headline", "is", null)
    .eq("is_latest_version", true)
    .eq("is_retweet", false)
    .eq("is_reply", false)
    .order("tweet_time", { ascending: true })
    .limit(opts.limit);

  if (error) throw new Error(`Tweet fetch failed: ${error.message}`);
  return (data || []).map((t) => ({ ...t, normalized_headline: compact(t.normalized_headline || "") }));
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

// Google Gemini: sequential calls (SDK doesn't expose a batch endpoint).
// We parallelise in chunks of 20 to stay under rate limits.
async function embedTextsGoogle(texts, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const { GoogleGenAI } = require("@google/genai");
  const client = new GoogleGenAI({ apiKey });

  const CONCURRENCY = 20;
  const vectors = new Array(texts.length);

  for (let start = 0; start < texts.length; start += CONCURRENCY) {
    const chunk = texts.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((text) =>
        client.models.embedContent({
          model,
          contents: text.slice(0, 4000),
          config: { taskType: "CLUSTERING", outputDimensionality: 1536 },
        })
      )
    );
    for (let i = 0; i < results.length; i++) {
      vectors[start + i] = results[i].embeddings?.[0]?.values ?? null;
    }
  }

  // Google doesn't return token counts in this API; estimate ~10 tokens/text
  const estimatedTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  return { vectors, totalTokens: estimatedTokens, costUSD: 0 };
}

// OpenAI / OpenRouter: batched HTTP calls.
async function embedTextsOpenAI(texts, provider, model) {
  const key = provider === "openrouter"
    ? process.env.OPENROUTER_API_KEY
    : process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`Missing ${provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"}`);

  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/embeddings"
    : "https://api.openai.com/v1/embeddings";

  const BATCH = 100;
  const vectors = new Array(texts.length);
  let totalTokens = 0;

  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH).map((t) => t.slice(0, 4000));
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!resp.ok) throw new Error(`Embedding failed (${resp.status}): ${await resp.text()}`);
    const payload = await resp.json();
    for (let i = 0; i < payload.data.length; i++) vectors[start + i] = payload.data[i].embedding;
    if (payload.usage?.total_tokens) totalTokens += payload.usage.total_tokens;
  }

  return { vectors, totalTokens, costUSD: (totalTokens / 1e6) * 0.02 };
}

async function embedTexts(texts, provider, model) {
  if (provider === "google") return embedTextsGoogle(texts, model);
  return embedTextsOpenAI(texts, provider, model);
}

// ---------------------------------------------------------------------------
// Method A: Lexical (Jaccard)
// ---------------------------------------------------------------------------

function methodA_lexical(tweets) {
  const clusters = [];
  let nextId = 1;
  const ASSIGN = 0.3;
  const MERGE = 0.45;

  for (const tweet of tweets) {
    const tokens = tokenize(headlineOnly(tweet));
    if (!tokens.length) continue;

    let best = null;
    for (const c of clusters) {
      if (c.mergedInto) continue;
      const sim = jaccard(tokens, c.tokens);
      if (!best || sim > best.sim) best = { c, sim };
    }

    if (best && best.sim >= ASSIGN) {
      best.c.tokens = mergeTokens(best.c.tokens, tokens);
      best.c.tweets.push(tweet);
      if (tweet.tweet_time > best.c.lastSeenAt) best.c.lastSeenAt = tweet.tweet_time;
    } else {
      clusters.push({ id: nextId++, headline: headlineOnly(tweet), facts: parseFacts(tweet.normalized_facts), tokens, tweets: [tweet], firstSeenAt: tweet.tweet_time, lastSeenAt: tweet.tweet_time, mergedInto: null });
    }
  }

  // merge pass
  for (const src of clusters) {
    if (src.mergedInto) continue;
    let best = null;
    for (const other of clusters) {
      if (other.id === src.id || other.mergedInto) continue;
      const sim = jaccard(src.tokens, other.tokens);
      if (sim < MERGE) continue;
      const dir = mergeDirection(src, other);
      if (dir.source.id !== src.id) continue;
      if (!best || sim > best.sim) best = { dir, sim };
    }
    if (!best) continue;
    const { source, target } = best.dir;
    target.tokens = mergeTokens(target.tokens, source.tokens);
    target.tweets.push(...source.tweets);
    if (source.lastSeenAt > target.lastSeenAt) target.lastSeenAt = source.lastSeenAt;
    source.mergedInto = target.id;
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Method B: Drifting centroid (headline-only embedding, centroid = mean of members)
// ---------------------------------------------------------------------------

function methodB_driftingCentroid(tweets, hlVectors, config) {
  const clusters = [];
  let nextId = 1;

  for (let ti = 0; ti < tweets.length; ti++) {
    const tweet = tweets[ti];
    const vec = hlVectors[ti];
    if (!Array.isArray(vec)) continue;

    let best = null;
    for (const c of clusters) {
      if (c.mergedInto) continue;
      const sim = cosine(vec, c.centroid);
      if (!best || sim > best.sim) best = { c, sim };
    }

    if (best && best.sim >= config.assign) {
      best.c.tweets.push({ tweet, vecIndex: ti });
      // recompute true mean centroid
      best.c.centroid = mean(best.c.tweets.map((m) => hlVectors[m.vecIndex]).filter(Array.isArray));
      if (tweet.tweet_time > best.c.lastSeenAt) best.c.lastSeenAt = tweet.tweet_time;
    } else {
      clusters.push({
        id: nextId++,
        headline: headlineOnly(tweet),
        facts: parseFacts(tweet.normalized_facts),
        // founding tweet vector — used to measure drift
        foundingVector: vec,
        centroid: vec,
        tweets: [{ tweet, vecIndex: ti }],
        firstSeenAt: tweet.tweet_time,
        lastSeenAt: tweet.tweet_time,
        mergedInto: null,
      });
    }
  }

  // merge pass
  for (const src of clusters) {
    if (src.mergedInto) continue;
    let best = null;
    for (const other of clusters) {
      if (other.id === src.id || other.mergedInto) continue;
      const sim = cosine(src.centroid, other.centroid);
      if (sim < config.merge) continue;
      const rawSrc = { tweets: src.tweets, firstSeenAt: src.firstSeenAt, id: src.id };
      const rawOther = { tweets: other.tweets, firstSeenAt: other.firstSeenAt, id: other.id };
      const dir = mergeDirection(rawSrc, rawOther);
      if (dir.source.id !== src.id) continue;
      if (!best || sim > best.sim) best = { source: src, target: clusters.find((c) => c.id === dir.target.id), sim };
    }
    if (!best) continue;
    best.target.tweets.push(...best.source.tweets);
    best.target.centroid = mean(best.target.tweets.map((m) => hlVectors[m.vecIndex]).filter(Array.isArray));
    if (best.source.lastSeenAt > best.target.lastSeenAt) best.target.lastSeenAt = best.source.lastSeenAt;
    best.source.mergedInto = best.target.id;
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Method C: Stable identity (headline+facts embedding, founding vector frozen)
// ---------------------------------------------------------------------------

function methodC_stableIdentity(tweets, hlfVectors, config) {
  const clusters = [];
  let nextId = 1;

  for (let ti = 0; ti < tweets.length; ti++) {
    const tweet = tweets[ti];
    const vec = hlfVectors[ti];
    if (!Array.isArray(vec)) continue;

    let best = null;
    for (const c of clusters) {
      if (c.mergedInto) continue;
      // compare against identity vector — NEVER the centroid
      const sim = cosine(vec, c.identityVector);
      if (!best || sim > best.sim) best = { c, sim };
    }

    if (best && best.sim >= config.assign) {
      best.c.tweets.push({ tweet, vecIndex: ti });
      if (tweet.tweet_time > best.c.lastSeenAt) best.c.lastSeenAt = tweet.tweet_time;
      // identityVector intentionally NOT updated
    } else {
      clusters.push({
        id: nextId++,
        headline: headlineOnly(tweet),
        facts: parseFacts(tweet.normalized_facts),
        // identity is frozen at founding tweet — never mutated
        identityVector: vec,
        tweets: [{ tweet, vecIndex: ti }],
        firstSeenAt: tweet.tweet_time,
        lastSeenAt: tweet.tweet_time,
        mergedInto: null,
      });
    }
  }

  // merge pass — compare identity vectors, target keeps its identity
  for (const src of clusters) {
    if (src.mergedInto) continue;
    let best = null;
    for (const other of clusters) {
      if (other.id === src.id || other.mergedInto) continue;
      const sim = cosine(src.identityVector, other.identityVector);
      if (sim < config.merge) continue;
      const rawSrc = { tweets: src.tweets, firstSeenAt: src.firstSeenAt, id: src.id };
      const rawOther = { tweets: other.tweets, firstSeenAt: other.firstSeenAt, id: other.id };
      const dir = mergeDirection(rawSrc, rawOther);
      if (dir.source.id !== src.id) continue;
      if (!best || sim > best.sim) best = { source: src, target: clusters.find((c) => c.id === dir.target.id), sim };
    }
    if (!best) continue;
    best.target.tweets.push(...best.source.tweets);
    if (best.source.lastSeenAt > best.target.lastSeenAt) best.target.lastSeenAt = best.source.lastSeenAt;
    // target.identityVector intentionally NOT updated
    best.source.mergedInto = best.target.id;
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Summarize clusters — works for all three methods
// Options:
//   getVector(member)  — returns the embedding vector for a cluster member
//   getIdentity(c)     — returns the cluster's stored "identity" vector (null for lexical)
// ---------------------------------------------------------------------------

function summarize(label, clusters, opts) {
  const { getVector, getIdentity, dupThreshold } = opts;
  const active = clusters.filter((c) => !c.mergedInto);

  const enriched = active.map((c) => {
    const rawTweets = c.tweets.map((m) => (m.tweet !== undefined ? m.tweet : m));
    const uniqueUsers = new Set(rawTweets.map((t) => compact(t.username || `tweet:${t.tweet_id}`).toLowerCase())).size;
    const isRawCandidate = rawTweets.length >= 3 && uniqueUsers >= 2;
    const spam = isPromoOrSpam({ headline: c.headline, facts: c.facts, tweets: rawTweets });

    // true mean vector from member embeddings (for dup detection regardless of method)
    const memberVecs = getVector ? c.tweets.map(getVector).filter(Array.isArray) : [];
    const trueCentroid = memberVecs.length ? mean(memberVecs) : null;

    // drift: how far has the cluster's stored "address" moved from its founding vector?
    let driftAngle = null;
    if (getIdentity && trueCentroid && trueCentroid.length) {
      const identity = getIdentity(c);
      if (identity && identity.length) {
        driftAngle = 1 - cosine(identity, trueCentroid);
      }
    }

    return { ...c, rawTweets, uniqueUsers, isRawCandidate, spam, trueCentroid, driftAngle, tweetCount: rawTweets.length };
  });

  // residual duplicate pairs — measured using true mean centroids
  const residualPairs = [];
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i];
      const b = enriched[j];
      if (!a.trueCentroid || !b.trueCentroid) continue;
      const sim = cosine(a.trueCentroid, b.trueCentroid);
      if (sim >= dupThreshold) {
        residualPairs.push({ sim, aId: a.id, bId: b.id, aSize: a.tweetCount, bSize: b.tweetCount, aHeadline: a.headline, bHeadline: b.headline });
      }
    }
  }
  residualPairs.sort((a, b) => b.sim - a.sim);

  // drift stats for methods with identity vectors
  const driftValues = enriched.filter((c) => c.driftAngle !== null).map((c) => c.driftAngle);
  const avgDrift = driftValues.length ? driftValues.reduce((s, v) => s + v, 0) / driftValues.length : null;
  const maxDrift = driftValues.length ? Math.max(...driftValues) : null;

  // top stories
  const stories = enriched
    .filter((c) => c.isRawCandidate && !c.spam)
    .sort((a, b) => b.tweetCount - a.tweetCount || b.uniqueUsers - a.uniqueUsers)
    .slice(0, 10)
    .map((c) => ({
      headline: c.headline,
      tweet_count: c.tweetCount,
      unique_users: c.uniqueUsers,
      first_seen_at: c.firstSeenAt,
      last_seen_at: c.lastSeenAt,
      drift_angle: c.driftAngle !== null ? Number(c.driftAngle.toFixed(4)) : null,
      sample_tweets: c.rawTweets.slice(0, 5).map((t) => ({ username: t.username, tweet_text: t.tweet_text, tweet_time: t.tweet_time })),
    }));

  return {
    label,
    clusters: enriched.length,
    singletons: enriched.filter((c) => c.tweetCount === 1).length,
    multi: enriched.filter((c) => c.tweetCount > 1).length,
    story_raw: enriched.filter((c) => c.isRawCandidate).length,
    story_filtered: enriched.filter((c) => c.isRawCandidate && !c.spam).length,
    promo_clusters: enriched.filter((c) => c.spam).length,
    largest: enriched.reduce((m, c) => Math.max(m, c.tweetCount), 0),
    residual_dup_pairs: residualPairs.length,
    avg_drift: avgDrift !== null ? Number(avgDrift.toFixed(4)) : null,
    max_drift: maxDrift !== null ? Number(maxDrift.toFixed(4)) : null,
    top_residual_pairs: residualPairs.slice(0, 6),
    stories,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  console.log(`Loading tweets: hours=${opts.hours} limit=${opts.limit}`);
  const tweets = await fetchTweets(opts);

  if (!tweets.length) {
    console.log("No normalized tweets found in selected window.");
    return;
  }

  console.log(`Loaded ${tweets.length} tweets. Embedding...`);

  // embed headline-only texts (for method B)
  const hlTexts = tweets.map(headlineOnly);
  const embedHL = await embedTexts(hlTexts, opts.provider, opts.model);
  const costStr = (c) => opts.provider === "google" ? "(Google — no cost reported)" : `$${c.toFixed(5)}`;
  console.log(`  headline-only:   ~${embedHL.totalTokens} chars  ${costStr(embedHL.costUSD)}`);

  // embed headline+facts texts (for method C)
  const hlfTexts = tweets.map(headlineAndFacts);
  const embedHLF = await embedTexts(hlfTexts, opts.provider, opts.model);
  console.log(`  headline+facts:  ~${embedHLF.totalTokens} chars  ${costStr(embedHLF.costUSD)}`);

  const totalCost = embedHL.costUSD + embedHLF.costUSD;
  console.log(`  total cost:      ${costStr(totalCost)}`);

  // ---------------------------------------------------------------------------
  // Run all three methods
  // ---------------------------------------------------------------------------

  console.log("\nRunning simulations...");

  // A: Lexical
  const clustersA = methodA_lexical(tweets);
  const summaryA = summarize("A_lexical", clustersA, {
    getVector: null,
    getIdentity: null,
    dupThreshold: opts.dupThreshold,
  });

  // B: Drifting centroid, headline-only
  const clustersB = methodB_driftingCentroid(tweets, embedHL.vectors, { assign: opts.assignB, merge: opts.mergeB });
  const summaryB = summarize("B_drift_hl_only", clustersB, {
    getVector: (m) => embedHL.vectors[m.vecIndex],
    // founding vector = first tweet's vector; centroid = running mean → drift = distance between them
    getIdentity: (c) => c.foundingVector,
    dupThreshold: opts.dupThreshold,
  });

  // C: Stable identity, headline+facts
  const clustersC = methodC_stableIdentity(tweets, embedHLF.vectors, { assign: opts.assignC, merge: opts.mergeC });
  const summaryC = summarize("C_stable_hlf", clustersC, {
    getVector: (m) => embedHLF.vectors[m.vecIndex],
    // identity vector = founding tweet, never mutated → drift is by definition 0
    getIdentity: (c) => c.identityVector,
    dupThreshold: opts.dupThreshold,
  });

  // ---------------------------------------------------------------------------
  // Print results
  // ---------------------------------------------------------------------------

  console.log("\n─── Comparison table ─────────────────────────────────────────────────────────");
  console.table([summaryA, summaryB, summaryC].map((s) => ({
    method: s.label,
    clusters: s.clusters,
    singletons: s.singletons,
    multi: s.multi,
    stories: s.story_filtered,
    promo: s.promo_clusters,
    largest: s.largest,
    residual_dups: s.residual_dup_pairs,
    avg_drift: s.avg_drift ?? "n/a",
    max_drift: s.max_drift ?? "n/a",
  })));

  console.log("\n─── Drift analysis (method B vs C) ───────────────────────────────────────────");
  console.log(`Method B avg drift from founding vector: ${summaryB.avg_drift ?? "n/a"} (max: ${summaryB.max_drift ?? "n/a"})`);
  console.log(`Method C drift: 0 by construction (identity never mutated)`);
  console.log("");
  console.log("Drift = 1 - cosine(founding_vector, final_centroid). Higher = more topic wander.");
  console.log("Clusters with high drift in method B are likely absorbing off-topic tweets.");

  function printResidualPairs(summary) {
    console.log(`\n─── ${summary.label}: residual duplicate pairs (threshold=${opts.dupThreshold}) ─`);
    if (!summary.top_residual_pairs.length) { console.log("  (none)"); return; }
    for (const p of summary.top_residual_pairs) {
      console.log(`  sim=${p.sim.toFixed(3)} sizes=${p.aSize}/${p.bSize}`);
      console.log(`    A: ${p.aHeadline}`);
      console.log(`    B: ${p.bHeadline}`);
    }
  }

  printResidualPairs(summaryA);
  printResidualPairs(summaryB);
  printResidualPairs(summaryC);

  console.log("\n─── Method C: top story clusters ─────────────────────────────────────────────");
  for (const story of summaryC.stories.slice(0, 6)) {
    console.log(`\n[${story.tweet_count} tweets / ${story.unique_users} users] ${story.headline}`);
    for (const t of story.sample_tweets.slice(0, 3)) {
      const time = t.tweet_time ? new Date(t.tweet_time).toISOString().slice(11, 16) : "?";
      console.log(`  @${t.username} ${time}: ${compact(t.tweet_text || "").slice(0, 100)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Save output
  // ---------------------------------------------------------------------------

  const output = {
    generated_at: new Date().toISOString(),
    options: { ...opts, provider: opts.provider, model: opts.model },
    input_tweets: tweets.length,
    embedding: {
      provider: opts.provider,
      model: opts.model,
      headline_only_chars: embedHL.totalTokens,
      headline_facts_chars: embedHLF.totalTokens,
      total_cost_usd: opts.provider === "google" ? null : Number(totalCost.toFixed(6)),
    },
    methods: {
      A_lexical: summaryA,
      B_drift_headline_only: summaryB,
      C_stable_headline_and_facts: summaryC,
    },
  };

  const outputDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const ts = output.generated_at.replace(/[:.]/g, "-");
  const outPath = path.join(outputDir, `cluster-stability-eval-${ts}.json`);
  const latestPath = path.join(outputDir, "cluster-stability-eval-latest.json");

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(output, null, 2));

  console.log(`\nsaved=${outPath}`);
  console.log(`saved=${latestPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
