#!/usr/bin/env node
/**
 * embedding-cluster-eval.cjs
 *
 * Evaluates the cluster_tweets_by_embedding Postgres function against
 * production data. Calls the function, loads tweet content for cluster
 * members, and reports quality metrics.
 *
 * Default mode: evaluates a single threshold in detail.
 * Sweep mode (--sweep): tests a range of thresholds and prints a summary
 *   table so you can find the right calibration point.
 *
 * Usage:
 *   node scripts/embedding-cluster-eval.cjs [options]
 *
 * Options:
 *   --hours N          Tweet lookback window in hours (default: 24)
 *   --threshold N      Similarity threshold to test (default: 0.86)
 *   --min-cluster N    Min tweets per cluster returned (default: 2)
 *   --max-days N       Max day span within a cluster (default: 3)
 *   --sweep            Test thresholds 0.78, 0.82, 0.86, 0.88, 0.90, 0.92, 0.94
 *   --compare          Cross-reference clusters against existing persistent clusters
 */

"use strict";

const fs   = require("fs");
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

const SWEEP_THRESHOLDS = [0.78, 0.82, 0.86, 0.88, 0.90, 0.92, 0.94];
const STORY_MIN_TWEETS = 3;
const STORY_MIN_USERS  = 2;

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","by","for","from",
  "has","have","in","is","it","its","of","on","or","that",
  "the","their","this","to","was","were","will","with",
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    hours:      24,
    threshold:  0.86,
    minCluster: 2,
    maxDays:    3,
    sweep:      false,
    compare:    false,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if      (key === "--hours"       && val) { opts.hours      = Number(val); i++; }
    else if (key === "--threshold"   && val) { opts.threshold  = Number(val); i++; }
    else if (key === "--min-cluster" && val) { opts.minCluster = Number(val); i++; }
    else if (key === "--max-days"    && val) { opts.maxDays    = Number(val); i++; }
    else if (key === "--sweep")              { opts.sweep      = true; }
    else if (key === "--compare")            { opts.compare    = true; }
  }

  if (!Number.isFinite(opts.hours)     || opts.hours     <= 0) opts.hours     = 24;
  if (!Number.isFinite(opts.threshold) || opts.threshold <= 0) opts.threshold = 0.86;
  opts.hours = Math.min(Math.floor(opts.hours), 24 * 7);
  return opts;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function compact(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function tokenize(text, max = 240) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9$][a-z0-9$._-]*/g) || [];
  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    const token = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (!token) continue;
    const isTicker  = token.startsWith("$") && token.length > 1;
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

// Average pairwise Jaccard of an array of token arrays (sample capped at 40)
function avgPairwiseJaccard(tokenSets) {
  const sample = tokenSets.length > 40
    ? tokenSets.slice().sort(() => Math.random() - 0.5).slice(0, 40)
    : tokenSets;
  let total = 0, pairs = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      total += jaccard(sample[i], sample[j]);
      pairs++;
    }
  }
  return pairs > 0 ? total / pairs : null;
}

function fmt(n, d = 3) {
  return n == null ? "  n/a" : n.toFixed(d);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

// Load persistent cluster assignments for a list of tweet DB IDs
async function loadPersistentAssignments(tweetDbIds) {
  if (!tweetDbIds.length) return new Map();

  const CHUNK = 300;
  const all = [];
  for (let i = 0; i < tweetDbIds.length; i += CHUNK) {
    const chunk = tweetDbIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("x_news_cluster_tweets")
      .select("tweet_id,cluster_id")
      .in("tweet_id", chunk);
    if (error) throw new Error(`Persistent assignment load failed: ${error.message}`);
    all.push(...(data || []));
  }

  // tweet DB id → persistent cluster id
  return new Map(all.map((a) => [a.tweet_id, a.cluster_id]));
}

// Load persistent cluster metadata for a list of cluster IDs
async function loadPersistentClusters(clusterIds) {
  if (!clusterIds.length) return new Map();

  const CHUNK = 200;
  const all = [];
  for (let i = 0; i < clusterIds.length; i += CHUNK) {
    const chunk = clusterIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("x_news_clusters")
      .select("id,normalized_headline,tweet_count,is_story_candidate")
      .in("id", chunk);
    if (error) throw new Error(`Persistent cluster load failed: ${error.message}`);
    all.push(...(data || []));
  }

  return new Map(all.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// Fetch embeddings + run clustering in JS
// ---------------------------------------------------------------------------
// We compute pairwise cosine similarity and connected components locally
// rather than in SQL, so there's no PostgREST statement-timeout issue and
// we can re-sweep multiple thresholds against the same cached embedding data.

async function fetchEligibleTweets(since) {
  const CHUNK = 500;
  const all   = [];

  // First get the count / IDs to page through
  const { data: ids, error: idErr } = await supabase
    .from("tweets")
    .select("id")
    .gte("tweet_time", since)
    .not("normalized_headline_embedding", "is", null)
    .not("normalized_headline", "is", null)
    .eq("is_latest_version", true)
    .eq("is_retweet", false)
    .eq("is_reply",   false)
    .eq("is_quote",   false);

  if (idErr) throw new Error(`ID fetch failed: ${idErr.message}`);
  const allIds = (ids || []).map((r) => r.id);

  for (let i = 0; i < allIds.length; i += CHUNK) {
    const chunk = allIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("tweets")
      .select("id,tweet_id,username,tweet_text,normalized_headline,tweet_time,normalized_headline_embedding")
      .in("id", chunk);

    if (error) throw new Error(`Embedding fetch failed: ${error.message}`);
    all.push(...(data || []));
  }

  return all;
}

function parseEmbedding(raw) {
  if (!raw) return null;
  // Supabase returns vectors as a string like "[0.1,0.2,...]"
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Float32Array(parsed) : null;
    } catch { return null; }
  }
  if (Array.isArray(raw)) return new Float32Array(raw);
  return null;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function clusterInJS(tweets, threshold, minClusterSize, maxDaysWindow) {
  const t0 = Date.now();

  // Build index of tweets with valid embeddings
  const nodes = tweets
    .map((t, i) => ({ idx: i, tweet: t, vec: parseEmbedding(t.normalized_headline_embedding) }))
    .filter((n) => n.vec !== null);

  // Find all pairs above threshold — O(N²) but fast in JS with typed arrays
  const adj = new Map(); // idx → Set<idx>
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const sim = cosineSimilarity(nodes[i].vec, nodes[j].vec);
      if (sim >= threshold) {
        if (!adj.has(nodes[i].idx)) adj.set(nodes[i].idx, new Set());
        if (!adj.has(nodes[j].idx)) adj.set(nodes[j].idx, new Set());
        adj.get(nodes[i].idx).add(nodes[j].idx);
        adj.get(nodes[j].idx).add(nodes[i].idx);
      }
    }
  }

  // Connected components via BFS
  const visited    = new Set();
  const components = [];

  for (const node of nodes) {
    if (visited.has(node.idx) || !adj.has(node.idx)) continue;
    const component = [];
    const queue     = [node.idx];
    visited.add(node.idx);

    while (queue.length) {
      const cur = queue.shift();
      component.push(cur);
      for (const neighbor of (adj.get(cur) || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  const idxToTweet = new Map(nodes.map((n) => [n.idx, n.tweet]));

  // Build cluster objects, applying size + time-spread filters
  const clusters = [];
  let   clusterSeq = 1;
  for (const component of components) {
    if (component.length < minClusterSize) continue;

    const memberTweets = component.map((idx) => idxToTweet.get(idx)).filter(Boolean);
    const times = memberTweets
      .map((t) => t.tweet_time ? new Date(t.tweet_time).getTime() : null)
      .filter((ms) => ms !== null);

    const earliest = times.length ? new Date(Math.min(...times)) : null;
    const latest   = times.length ? new Date(Math.max(...times)) : null;
    const spanDays = earliest && latest ? (latest - earliest) / 86_400_000 : 0;

    if (spanDays > maxDaysWindow) continue;

    clusters.push({
      cluster_id:    clusterSeq++,
      tweet_ids:     memberTweets.map((t) => t.tweet_id),
      earliest_date: earliest ? earliest.toISOString() : null,
      latest_date:   latest   ? latest.toISOString()   : null,
      tweet_count:   memberTweets.length,
    });
  }

  // Sort by earliest_date ascending
  clusters.sort((a, b) => (a.earliest_date || "").localeCompare(b.earliest_date || ""));
  clusters.forEach((c, i) => { c.cluster_id = i + 1; });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  return { clusters, elapsed, nodeCount: nodes.length };
}

// ---------------------------------------------------------------------------
// Compare against persistent clusters
// ---------------------------------------------------------------------------

async function buildComparison(enrichedClusters) {
  const allDbIds = [...new Set(
    enrichedClusters.flatMap((c) => c.tweets.map((t) => t.id))
  )];

  const assignmentMap   = await loadPersistentAssignments(allDbIds);
  const persistentIds   = new Set([...assignmentMap.values()].filter(Boolean));
  const persistentMeta  = await loadPersistentClusters([...persistentIds]);

  return enrichedClusters.map((c) => {
    const persistentCounts = new Map();
    let unassigned = 0;

    for (const tweet of c.tweets) {
      const persistentId = assignmentMap.get(tweet.id);
      if (!persistentId) { unassigned++; continue; }
      persistentCounts.set(persistentId, (persistentCounts.get(persistentId) || 0) + 1);
    }

    const mappedClusters = [...persistentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const meta = persistentMeta.get(id);
        return {
          id,
          tweet_count_in_this_cluster: count,
          persistent_total: meta?.tweet_count || "?",
          headline: meta?.normalized_headline || "(no headline)",
          is_story: meta?.is_story_candidate || false,
        };
      });

    const verdict =
      mappedClusters.length === 0 ? "all-new"         :
      unassigned > 0               ? "partial-match"   :
      mappedClusters.length === 1  ? "exact-match"     :
                                     "split-in-persistent";

    return { ...c, comparison: { verdict, unassigned, mappedClusters } };
  });
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function runSweep(opts) {
  const since = new Date(Date.now() - opts.hours * 3_600_000).toISOString();
  console.log(`\nSweeping thresholds over last ${opts.hours}h  min_cluster=${opts.minCluster}  max_days=${opts.maxDays}`);
  console.log(`Fetching eligible tweets + embeddings...`);

  const rawTweets = await fetchEligibleTweets(since);
  const eligible  = rawTweets.length;
  console.log(`  Fetched ${eligible} tweets with embeddings\n`);

  const rows = [];
  for (const threshold of SWEEP_THRESHOLDS) {
    process.stdout.write(`  threshold=${threshold.toFixed(2)}  clustering...`);
    const { clusters, elapsed } = clusterInJS(rawTweets, threshold, opts.minCluster, opts.maxDays);
    process.stdout.write(` ${elapsed}s\n`);

    if (!clusters.length) {
      rows.push({ threshold, clusters: 0, avgSize: 0, maxSize: 0, stories: 0, coverage: 0, elapsed });
      continue;
    }

    const sizes       = clusters.map((c) => Number(c.tweet_count));
    const avgSize     = sizes.reduce((s, n) => s + n, 0) / sizes.length;
    const maxSize     = Math.max(...sizes);
    const uniqueTweets = new Set(clusters.flatMap((c) => c.tweet_ids || [])).size;
    const coverage    = eligible > 0 ? (uniqueTweets / eligible) * 100 : 0;
    const storyCandidates = clusters.filter((c) => Number(c.tweet_count) >= STORY_MIN_TWEETS).length;

    rows.push({ threshold, clusters: clusters.length, avgSize, maxSize, stories: storyCandidates, coverage, elapsed });
  }

  // Print table
  const header = [
    "threshold",
    "clusters",
    "avg_size",
    "max_size",
    "story_cands*",
    "coverage%",
    "elapsed_s",
  ];
  const colW = [10, 9, 9, 9, 13, 10, 10];
  const pad  = (s, w) => String(s).padStart(w);

  console.log("\n" + header.map((h, i) => pad(h, colW[i])).join("  "));
  console.log("-".repeat(colW.reduce((s, w) => s + w + 2, 0)));
  for (const r of rows) {
    console.log([
      pad(r.threshold.toFixed(2), colW[0]),
      pad(r.clusters,             colW[1]),
      pad(r.avgSize.toFixed(1),   colW[2]),
      pad(r.maxSize,              colW[3]),
      pad(r.stories,              colW[4]),
      pad(r.coverage.toFixed(1),  colW[5]),
      pad(r.elapsed,              colW[6]),
    ].join("  "));
  }
  console.log("\n* story_cands = clusters with >= 3 tweets (user diversity not checked in sweep)");
}

// ---------------------------------------------------------------------------
// Detailed single-threshold report
// ---------------------------------------------------------------------------

async function runDetailed(opts) {
  const since     = new Date(Date.now() - opts.hours * 3_600_000).toISOString();
  const threshold = opts.threshold;

  console.log(`\nDetailed eval  threshold=${threshold}  hours=${opts.hours}  min_cluster=${opts.minCluster}  max_days=${opts.maxDays}`);
  console.log("Fetching eligible tweets + embeddings...");
  const rawTweets = await fetchEligibleTweets(since);
  console.log(`  Fetched ${rawTweets.length} tweets with embeddings`);

  console.log("Clustering...");
  const { clusters: rawClusters, elapsed, nodeCount } = clusterInJS(rawTweets, threshold, opts.minCluster, opts.maxDays);
  console.log(`  ${rawClusters.length} clusters from ${nodeCount} embedded tweets in ${elapsed}s`);

  if (!rawClusters.length) {
    console.log("\nNo clusters at this threshold. Try lowering --threshold.");
    return;
  }

  // Enrich: build a tweet lookup from the already-fetched data
  const tweetByTwitterId = new Map(rawTweets.map((t) => [t.tweet_id, t]));
  const enriched = rawClusters.map((c) => {
    const tweets = (c.tweet_ids || []).map((tid) => tweetByTwitterId.get(tid)).filter(Boolean);
    const tokenSets = tweets
      .map((t) => tokenize(compact(t.normalized_headline || t.tweet_text || "")))
      .filter((ts) => ts.length > 0);
    const coherence   = tokenSets.length >= 2 ? avgPairwiseJaccard(tokenSets) : null;
    const uniqueUsers = new Set(tweets.map((t) => compact(t.username || `id:${t.tweet_id}`).toLowerCase())).size;
    const isStoryCandidate = tweets.length >= STORY_MIN_TWEETS && uniqueUsers >= STORY_MIN_USERS;
    const times    = tweets.map((t) => t.tweet_time ? new Date(t.tweet_time).getTime() : null).filter(Boolean);
    const spanHours = times.length >= 2
      ? (Math.max(...times) - Math.min(...times)) / 3_600_000
      : null;
    return { ...c, tweets, coherence, uniqueUsers, isStoryCandidate, spanHours };
  });

  const eligible = rawTweets.length;

  let compared = enriched;
  if (opts.compare) {
    console.log("Cross-referencing against persistent clusters...");
    compared = await buildComparison(enriched);
    console.log("  Done");
  }

  // ---------------------------------------------------------------------------
  // Summary stats
  // ---------------------------------------------------------------------------

  const sizes       = compared.map((c) => c.tweets.length);
  const totalTweets = new Set(compared.flatMap((c) => c.tweets.map((t) => t.tweet_id))).size;
  const coverage    = eligible > 0 ? (totalTweets / eligible) * 100 : 0;
  const avgSize     = sizes.reduce((s, n) => s + n, 0) / sizes.length;
  const maxSize     = Math.max(...sizes);
  const stories     = compared.filter((c) => c.isStoryCandidate);
  const coherences  = compared.map((c) => c.coherence).filter((v) => v != null);
  const avgCoherence = coherences.length
    ? coherences.reduce((s, v) => s + v, 0) / coherences.length
    : null;
  const medianCoherence = coherences.length
    ? coherences.slice().sort((a, b) => a - b)[Math.floor(coherences.length / 2)]
    : null;
  const lowCoherence = compared.filter((c) => c.coherence != null && c.coherence < 0.10 && c.tweets.length >= 3);
  const megaClusters = compared.filter((c) => c.tweets.length > 20);

  console.log("\n─── Summary ────────────────────────────────────────────────────────────────");
  console.log(`  Clusters:             ${compared.length}`);
  console.log(`  Unique tweets covered: ${totalTweets} / ${eligible}  (${coverage.toFixed(1)}% of eligible)`);
  console.log(`  Story candidates:     ${stories.length}`);
  console.log(`  Avg / max cluster:    ${avgSize.toFixed(1)} / ${maxSize} tweets`);
  console.log(`  Avg coherence:        ${fmt(avgCoherence)}`);
  console.log(`  Median coherence:     ${fmt(medianCoherence)}`);
  console.log(`  Low-coherence (<0.10): ${lowCoherence.length} cluster(s)`);
  console.log(`  Mega-clusters (>20):  ${megaClusters.length}`);

  // ---------------------------------------------------------------------------
  // Mega clusters (potential threshold-too-low signal)
  // ---------------------------------------------------------------------------

  if (megaClusters.length) {
    console.log("\n─── Mega clusters (threshold may be too low) ────────────────────────────────");
    for (const c of megaClusters) {
      const span = c.spanHours != null ? `${c.spanHours.toFixed(1)}h span` : "";
      console.log(`  [${c.tweets.length} tweets / ${c.uniqueUsers} users]  coherence=${fmt(c.coherence)}  ${span}`);
      const sample = c.tweets.slice(0, 3);
      for (const t of sample) {
        const hl = compact(t.normalized_headline || t.tweet_text || "").slice(0, 90);
        console.log(`    @${t.username}: ${hl}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Low-coherence clusters
  // ---------------------------------------------------------------------------

  if (lowCoherence.length) {
    console.log("\n─── Low-coherence clusters (incoherent grouping) ────────────────────────────");
    for (const c of lowCoherence.slice(0, 5)) {
      const span = c.spanHours != null ? `${c.spanHours.toFixed(1)}h` : "?h";
      console.log(`  [${c.tweets.length} tweets / ${c.uniqueUsers} users]  coherence=${fmt(c.coherence)}  span=${span}`);
      for (const t of c.tweets.slice(0, 4)) {
        const hl = compact(t.normalized_headline || t.tweet_text || "").slice(0, 80);
        console.log(`    @${t.username}: ${hl}`);
      }
      console.log();
    }
  }

  // ---------------------------------------------------------------------------
  // Top story clusters
  // ---------------------------------------------------------------------------

  const topStories = stories
    .slice()
    .sort((a, b) => b.tweets.length - a.tweets.length)
    .slice(0, 12);

  console.log("\n─── Top story clusters ──────────────────────────────────────────────────────");
  if (!topStories.length) {
    console.log("  (none)");
  } else {
    for (const c of topStories) {
      const span = c.spanHours != null ? `${c.spanHours.toFixed(1)}h` : "?h";
      const first = compact(c.tweets[0]?.normalized_headline || c.tweets[0]?.tweet_text || "").slice(0, 80);
      console.log(`  [${c.tweets.length} tweets / ${c.uniqueUsers} users]  coh=${fmt(c.coherence)}  span=${span}`);
      console.log(`    "${first}"`);

      if (opts.compare && c.comparison) {
        const { verdict, unassigned, mappedClusters } = c.comparison;
        console.log(`    persistent verdict: ${verdict}  unassigned=${unassigned}`);
        for (const m of mappedClusters.slice(0, 3)) {
          console.log(`      → persistent #${m.id} [${m.tweet_count_in_this_cluster}/${m.persistent_total} tweets] "${m.headline.slice(0, 60)}"`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent comparison summary (if requested)
  // ---------------------------------------------------------------------------

  if (opts.compare && compared.some((c) => c.comparison)) {
    const verdicts = { "exact-match": 0, "partial-match": 0, "split-in-persistent": 0, "all-new": 0 };
    for (const c of compared) {
      if (c.comparison) verdicts[c.comparison.verdict] = (verdicts[c.comparison.verdict] || 0) + 1;
    }
    const totalUnassigned = compared.reduce((s, c) => s + (c.comparison?.unassigned || 0), 0);

    console.log("\n─── Comparison with persistent clusters ─────────────────────────────────────");
    console.log(`  exact-match (same story, same tweets):  ${verdicts["exact-match"]}`);
    console.log(`  partial-match (some tweets not in DB):  ${verdicts["partial-match"]}`);
    console.log(`  split-in-persistent (persistent split what we grouped): ${verdicts["split-in-persistent"]}`);
    console.log(`  all-new (no persistent assignment):     ${verdicts["all-new"]}`);
    console.log(`  Total unassigned tweet-slots:           ${totalUnassigned}`);
  }

  // ---------------------------------------------------------------------------
  // Save output
  // ---------------------------------------------------------------------------

  const outputDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generated_at: new Date().toISOString(),
    params: { hours: opts.hours, threshold, minCluster: opts.minCluster, maxDays: opts.maxDays },
    rpc_elapsed_s: Number(elapsed),
    summary: {
      eligible_tweets:  eligible,
      total_clusters:   compared.length,
      unique_tweets_covered: totalTweets,
      coverage_pct:     Number(coverage.toFixed(2)),
      story_candidates: stories.length,
      avg_cluster_size: Number(avgSize.toFixed(2)),
      max_cluster_size: maxSize,
      avg_coherence:    avgCoherence != null ? Number(avgCoherence.toFixed(4)) : null,
      median_coherence: medianCoherence != null ? Number(medianCoherence.toFixed(4)) : null,
      low_coherence_count: lowCoherence.length,
      mega_cluster_count:  megaClusters.length,
    },
    clusters: compared.map((c) => ({
      cluster_id:   c.cluster_id,
      tweet_count:  c.tweets.length,
      unique_users: c.uniqueUsers,
      coherence:    c.coherence != null ? Number(c.coherence.toFixed(4)) : null,
      is_story:     c.isStoryCandidate,
      span_hours:   c.spanHours != null ? Number(c.spanHours.toFixed(1)) : null,
      earliest:     c.earliest_date,
      latest:       c.latest_date,
      sample_headlines: c.tweets.slice(0, 4).map((t) => ({
        username:  t.username,
        headline:  compact(t.normalized_headline || "").slice(0, 120),
        tweet_text: compact(t.tweet_text || "").slice(0, 120),
      })),
      comparison: c.comparison || null,
    })),
  };

  const outPath    = path.join(outputDir, `embedding-cluster-eval-${now}.json`);
  const latestPath = path.join(outputDir, "embedding-cluster-eval-latest.json");
  fs.writeFileSync(outPath,    JSON.stringify(report, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`\n  saved → ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.sweep) {
    await runSweep(opts);
  }

  // Always run detailed for the target threshold (after sweep if both flags present)
  await runDetailed(opts);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
