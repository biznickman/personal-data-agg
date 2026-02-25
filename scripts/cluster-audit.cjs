#!/usr/bin/env node
/**
 * cluster-audit.cjs
 *
 * Loads real cluster + tweet data from the database, audits quality, and
 * optionally executes a structured cleaning pass.
 *
 * Analysis (default / --dry-run):
 *   - Per-cluster coherence: average pairwise Jaccard between member tweet tokens
 *   - Merge candidates: cluster pairs whose token_sets exceed the merge threshold
 *   - Umbrella clusters: large clusters with low coherence (absorbed unrelated tweets)
 *   - Summary report + JSON cleaning plan saved to scripts/output/
 *
 * Execution (--execute):
 *   - Applies all recommended merges to the database
 *   - Recomputes story-candidate stats for affected clusters
 *   - Safe to re-run: skips already-merged clusters
 *
 * Usage:
 *   node scripts/cluster-audit.cjs [options]
 *
 * Options:
 *   --hours N             Lookback window (default: 48)
 *   --limit N             Max clusters to load (default: 500)
 *   --merge-threshold N   Jaccard threshold for merge candidates (default: 0.45)
 *   --coherence-warn N    Coherence below this flags a cluster (default: 0.08)
 *   --min-tweets N        Ignore clusters smaller than this (default: 2)
 *   --execute             Apply cleaning plan to DB (default: dry-run)
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
    hours: 48,
    limit: 500,
    mergeThreshold: 0.45,
    coherenceWarn: 0.08,
    minTweets: 2,
    execute: false,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === "--hours" && val)            { opts.hours = Number(val); i++; }
    else if (key === "--limit" && val)       { opts.limit = Number(val); i++; }
    else if (key === "--merge-threshold" && val) { opts.mergeThreshold = Number(val); i++; }
    else if (key === "--coherence-warn" && val)  { opts.coherenceWarn = Number(val); i++; }
    else if (key === "--min-tweets" && val)  { opts.minTweets = Number(val); i++; }
    else if (key === "--execute")            { opts.execute = true; }
  }

  if (!Number.isFinite(opts.hours) || opts.hours <= 0) opts.hours = 48;
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = 500;
  opts.hours = Math.min(Math.floor(opts.hours), 24 * 14);
  opts.limit = Math.min(Math.floor(opts.limit), 2000);
  return opts;
}

// ---------------------------------------------------------------------------
// Text / token helpers
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

function parseTokenSet(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function mergeTokenSets(a, b, max = 260) {
  const seen = new Set(a);
  const out = [...a];
  for (const t of b) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Promo / spam
// ---------------------------------------------------------------------------

function isPromoOrSpam(headline, facts, tweetTexts) {
  const combined = compact(
    [headline, ...(facts || []), ...tweetTexts].join(" ").toLowerCase()
  );
  if (!combined) return false;
  const termHits = PROMO_SPAM_TERMS.filter((t) => combined.includes(t)).length;
  const signal = /(trading signal|signal service|telegram channel|accuracy rate|free signals?)/.test(combined);
  const gweiAirdrop = /\bgwei\b/.test(combined) && /\bairdrop\b/.test(combined);
  return gweiAirdrop || signal || termHits >= 3;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadClusters(opts) {
  const cutoff = new Date(Date.now() - opts.hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("x_news_clusters")
    .select("id,normalized_headline,normalized_facts,token_set,tweet_count,unique_user_count,is_story_candidate,first_seen_at,last_seen_at")
    .is("merged_into_cluster_id", null)
    .gte("last_seen_at", cutoff)
    .order("tweet_count", { ascending: false })
    .limit(opts.limit);

  if (error) throw new Error(`Cluster load failed: ${error.message}`);
  return data || [];
}

async function loadMemberTweets(clusterIds) {
  if (!clusterIds.length) return new Map();

  // Load assignments in chunks to avoid query limits
  const CHUNK = 200;
  const allAssignments = [];
  for (let i = 0; i < clusterIds.length; i += CHUNK) {
    const chunk = clusterIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("x_news_cluster_tweets")
      .select("cluster_id,tweet_id")
      .in("cluster_id", chunk);
    if (error) throw new Error(`Assignment load failed: ${error.message}`);
    allAssignments.push(...(data || []));
  }

  // Load tweet data for all referenced tweet DB IDs
  const tweetDbIds = [...new Set(allAssignments.map((a) => a.tweet_id))];
  const allTweets = [];
  for (let i = 0; i < tweetDbIds.length; i += CHUNK) {
    const chunk = tweetDbIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("tweets")
      .select("id,tweet_id,username,tweet_text,normalized_headline,tweet_time")
      .in("id", chunk);
    if (error) throw new Error(`Tweet load failed: ${error.message}`);
    allTweets.push(...(data || []));
  }

  // Build tweet lookup and cluster -> tweets map
  const tweetByDbId = new Map(allTweets.map((t) => [t.id, t]));
  const clusterTweets = new Map();
  for (const { cluster_id, tweet_id } of allAssignments) {
    const tweet = tweetByDbId.get(tweet_id);
    if (!tweet) continue;
    if (!clusterTweets.has(cluster_id)) clusterTweets.set(cluster_id, []);
    clusterTweets.get(cluster_id).push(tweet);
  }

  return clusterTweets;
}

// ---------------------------------------------------------------------------
// Coherence scoring
// ---------------------------------------------------------------------------

// Average pairwise Jaccard between member tweet tokens.
// Capped at 50 members for performance (sample if larger).
function computeCoherence(tweets) {
  if (tweets.length < 2) return null;

  const sample = tweets.length > 50
    ? tweets.slice().sort(() => Math.random() - 0.5).slice(0, 50)
    : tweets;

  const tokenSets = sample
    .map((t) => tokenize(compact(t.normalized_headline || t.tweet_text || "")))
    .filter((tokens) => tokens.length > 0);

  if (tokenSets.length < 2) return null;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      total += jaccard(tokenSets[i], tokenSets[j]);
      pairs++;
    }
  }

  return pairs > 0 ? total / pairs : null;
}

// ---------------------------------------------------------------------------
// Merge direction (same as production)
// ---------------------------------------------------------------------------

function chooseMergeDirection(a, b) {
  const aCount = a.tweet_count || 0;
  const bCount = b.tweet_count || 0;
  if (aCount !== bCount) {
    return aCount > bCount ? { source: b, target: a } : { source: a, target: b };
  }
  const aMs = new Date(a.first_seen_at || "").getTime();
  const bMs = new Date(b.first_seen_at || "").getTime();
  if (!isNaN(aMs) && !isNaN(bMs) && aMs !== bMs) {
    return aMs <= bMs ? { source: b, target: a } : { source: a, target: b };
  }
  return a.id < b.id ? { source: b, target: a } : { source: a, target: b };
}

// ---------------------------------------------------------------------------
// Audit: find merge candidates and flag low-coherence clusters
// ---------------------------------------------------------------------------

function buildAudit(clusters, clusterTweets, opts) {
  // Enrich clusters with coherence scores and member tweet data
  const enriched = clusters.map((c) => {
    const tweets = clusterTweets.get(c.id) || [];
    const tokenSet = parseTokenSet(c.token_set);
    const coherence = computeCoherence(tweets);
    const tweetCount = tweets.length || c.tweet_count || 0;
    const uniqueUsers = new Set(
      tweets.map((t) => compact(t.username || `id:${t.tweet_id}`).toLowerCase())
    ).size;
    const spam = isPromoOrSpam(
      c.normalized_headline,
      Array.isArray(c.normalized_facts) ? c.normalized_facts : [],
      tweets.map((t) => t.tweet_text || "")
    );

    return { ...c, tweets, tokenSet, coherence, tweetCount, uniqueUsers, spam };
  }).filter((c) => c.tweetCount >= opts.minTweets);

  // Find merge candidates: pairs whose token_sets exceed the merge threshold.
  // We find the best merge target for each cluster (same greedy logic as merge.ts).
  const mergedIds = new Set();
  const mergePlan = [];

  for (const src of enriched) {
    if (mergedIds.has(src.id)) continue;

    let best = null;
    for (const other of enriched) {
      if (other.id === src.id || mergedIds.has(other.id)) continue;
      const sim = jaccard(src.tokenSet, other.tokenSet);
      if (sim < opts.mergeThreshold) continue;

      const dir = chooseMergeDirection(src, other);
      if (dir.source.id !== src.id) continue;

      if (!best || sim > best.sim) {
        best = { source: src, target: other, sim };
      }
    }

    if (!best) continue;

    mergePlan.push({
      source_cluster_id: best.source.id,
      target_cluster_id: best.target.id,
      similarity: Number(best.sim.toFixed(4)),
      source_headline: best.source.normalized_headline,
      target_headline: best.target.normalized_headline,
      source_tweet_count: best.source.tweetCount,
      target_tweet_count: best.target.tweetCount,
    });

    mergedIds.add(best.source.id);
  }

  // Flag umbrella clusters: large + low coherence (OR any cluster below warn threshold)
  const lowCoherence = enriched
    .filter((c) => c.coherence !== null && c.coherence < opts.coherenceWarn && c.tweetCount >= 3)
    .sort((a, b) => a.coherence - b.coherence)
    .map((c) => ({
      cluster_id: c.id,
      headline: c.normalized_headline,
      tweet_count: c.tweetCount,
      unique_users: c.uniqueUsers,
      coherence: Number(c.coherence.toFixed(4)),
      is_story_candidate: c.is_story_candidate,
      is_promo: c.spam,
      sample_tweets: c.tweets.slice(0, 4).map((t) => ({
        username: t.username,
        tweet_time: t.tweet_time,
        headline: compact(t.normalized_headline || ""),
        text: compact(t.tweet_text || "").slice(0, 100),
      })),
    }));

  // Top story clusters for reference
  const stories = enriched
    .filter((c) => c.is_story_candidate && !c.spam)
    .slice(0, 10)
    .map((c) => ({
      cluster_id: c.id,
      headline: c.normalized_headline,
      tweet_count: c.tweetCount,
      unique_users: c.uniqueUsers,
      coherence: c.coherence !== null ? Number(c.coherence.toFixed(4)) : null,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
    }));

  return { enriched, mergePlan, lowCoherence, stories };
}

// ---------------------------------------------------------------------------
// Execute: apply merge plan to DB
// ---------------------------------------------------------------------------

async function executeMerge(merge) {
  const { source_cluster_id: sourceId, target_cluster_id: targetId } = merge;

  // Fetch current token sets and counts for both clusters
  const { data: rows, error: fetchErr } = await supabase
    .from("x_news_clusters")
    .select("id,token_set,last_seen_at,tweet_count,centroid_embedding")
    .in("id", [sourceId, targetId]);

  if (fetchErr) throw new Error(`Fetch before merge failed: ${fetchErr.message}`);

  const source = rows.find((r) => r.id === sourceId);
  const target = rows.find((r) => r.id === targetId);
  if (!source || !target) throw new Error(`Cluster not found: ${sourceId} or ${targetId}`);

  // Merge token sets
  const mergedTokens = mergeTokenSets(parseTokenSet(target.token_set), parseTokenSet(source.token_set));

  // Pick latest last_seen_at
  const srcMs = new Date(source.last_seen_at || "").getTime();
  const tgtMs = new Date(target.last_seen_at || "").getTime();
  const mergedLastSeen = (!isNaN(srcMs) && !isNaN(tgtMs) && srcMs > tgtMs)
    ? source.last_seen_at
    : target.last_seen_at;

  // Reassign all source tweets to target
  const { error: moveErr } = await supabase
    .from("x_news_cluster_tweets")
    .update({ cluster_id: targetId })
    .eq("cluster_id", sourceId);

  if (moveErr) throw new Error(`Tweet reassignment failed: ${moveErr.message}`);

  // Update target cluster
  const { error: targetErr } = await supabase
    .from("x_news_clusters")
    .update({
      token_set: mergedTokens,
      last_seen_at: mergedLastSeen ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId)
    .is("merged_into_cluster_id", null);

  if (targetErr) throw new Error(`Target cluster update failed: ${targetErr.message}`);

  // Mark source as merged
  const { error: sourceErr } = await supabase
    .from("x_news_clusters")
    .update({
      merged_into_cluster_id: targetId,
      is_story_candidate: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sourceId)
    .is("merged_into_cluster_id", null);

  if (sourceErr) throw new Error(`Source cluster merge update failed: ${sourceErr.message}`);

  // Record in merge history
  await supabase.from("x_news_cluster_merges").insert({
    source_cluster_id: sourceId,
    target_cluster_id: targetId,
    similarity_score: merge.similarity,
    reason: "audit_token_set_similarity",
  });

  // Recompute stats for target
  await recomputeStats(targetId);
}

async function recomputeStats(clusterId) {
  const { data: assignments } = await supabase
    .from("x_news_cluster_tweets")
    .select("tweet_id,tweets(username,tweet_text,normalized_headline)")
    .eq("cluster_id", clusterId);

  if (!assignments) return;

  const tweets = assignments.map((a) => a.tweets).filter(Boolean);
  const tweetCount = tweets.length;
  const uniqueUsers = new Set(
    tweets.map((t) => compact(t.username || "unknown").toLowerCase())
  ).size;

  const spam = isPromoOrSpam(null, [], tweets.map((t) => t.tweet_text || ""));
  const isStoryCandidate = tweetCount >= 3 && uniqueUsers >= 2 && !spam;

  await supabase
    .from("x_news_clusters")
    .update({ tweet_count: tweetCount, unique_user_count: uniqueUsers, is_story_candidate: isStoryCandidate, updated_at: new Date().toISOString() })
    .eq("id", clusterId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const mode = opts.execute ? "EXECUTE" : "DRY RUN";

  console.log(`cluster-audit [${mode}] hours=${opts.hours} limit=${opts.limit} merge_threshold=${opts.mergeThreshold}`);
  console.log("Loading clusters...");

  const clusters = await loadClusters(opts);
  console.log(`  Loaded ${clusters.length} active clusters`);

  console.log("Loading member tweets...");
  const clusterTweets = await loadMemberTweets(clusters.map((c) => c.id));
  const totalTweets = [...clusterTweets.values()].reduce((s, ts) => s + ts.length, 0);
  console.log(`  Loaded ${totalTweets} tweet assignments across ${clusterTweets.size} clusters`);

  console.log("Auditing...");
  const { enriched, mergePlan, lowCoherence, stories } = buildAudit(clusters, clusterTweets, opts);

  // ---------------------------------------------------------------------------
  // Summary stats
  // ---------------------------------------------------------------------------

  const coherenceValues = enriched.map((c) => c.coherence).filter((v) => v !== null);
  const avgCoherence = coherenceValues.length
    ? coherenceValues.reduce((s, v) => s + v, 0) / coherenceValues.length
    : null;

  const storyCandidates = enriched.filter((c) => c.is_story_candidate && !c.spam).length;
  const promoFiltered = enriched.filter((c) => c.spam).length;
  const singletons = clusters.filter((c) => (c.tweet_count || 0) < opts.minTweets).length;
  const largest = enriched.reduce((m, c) => Math.max(m, c.tweetCount), 0);

  console.log("\n─── Cluster summary ───────────────────────────────────────────────────────────");
  console.log(`  Total active clusters (in window): ${clusters.length}`);
  console.log(`  Audited (>= ${opts.minTweets} tweets):         ${enriched.length}`);
  console.log(`  Story candidates:                  ${storyCandidates}`);
  console.log(`  Promo/spam filtered:               ${promoFiltered}`);
  console.log(`  Singletons (excluded):             ${singletons}`);
  console.log(`  Largest cluster:                   ${largest} tweets`);
  console.log(`  Avg coherence:                     ${avgCoherence !== null ? avgCoherence.toFixed(4) : "n/a"}`);

  console.log("\n─── Merge candidates ──────────────────────────────────────────────────────────");
  if (!mergePlan.length) {
    console.log("  (none above threshold)");
  } else {
    console.log(`  ${mergePlan.length} pair(s) to merge:\n`);
    for (const m of mergePlan) {
      console.log(`  sim=${m.similarity.toFixed(3)}  [${m.source_tweet_count}→${m.target_tweet_count} tweets]`);
      console.log(`    SOURCE  #${m.source_cluster_id}: ${m.source_headline}`);
      console.log(`    TARGET  #${m.target_cluster_id}: ${m.target_headline}`);
    }
  }

  console.log("\n─── Low coherence clusters ────────────────────────────────────────────────────");
  if (!lowCoherence.length) {
    console.log(`  (none below ${opts.coherenceWarn})`);
  } else {
    console.log(`  ${lowCoherence.length} cluster(s) with low coherence:\n`);
    for (const c of lowCoherence.slice(0, 8)) {
      console.log(`  #${c.cluster_id} coherence=${c.coherence} tweets=${c.tweet_count} story=${c.is_story_candidate}`);
      console.log(`    "${c.headline}"`);
      for (const t of c.sample_tweets.slice(0, 3)) {
        const time = t.tweet_time ? new Date(t.tweet_time).toISOString().slice(11, 16) : "?";
        console.log(`    @${t.username} ${time}: ${t.headline || t.text}`);
      }
      console.log();
    }
  }

  console.log("\n─── Top story clusters ────────────────────────────────────────────────────────");
  for (const s of stories.slice(0, 8)) {
    console.log(`  #${s.cluster_id} [${s.tweet_count} tweets / ${s.unique_users} users] coherence=${s.coherence ?? "n/a"}`);
    console.log(`    "${s.headline}"`);
  }

  // ---------------------------------------------------------------------------
  // Save plan
  // ---------------------------------------------------------------------------

  const plan = {
    generated_at: new Date().toISOString(),
    mode,
    options: opts,
    summary: {
      total_clusters: clusters.length,
      audited_clusters: enriched.length,
      story_candidates: storyCandidates,
      promo_filtered: promoFiltered,
      singletons,
      largest_cluster: largest,
      avg_coherence: avgCoherence !== null ? Number(avgCoherence.toFixed(4)) : null,
    },
    merge_plan: mergePlan,
    low_coherence_clusters: lowCoherence,
    stories,
  };

  const outputDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const ts = plan.generated_at.replace(/[:.]/g, "-");
  const planPath = path.join(outputDir, `cluster-audit-${ts}.json`);
  const latestPath = path.join(outputDir, "cluster-audit-latest.json");
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(plan, null, 2));
  console.log(`\n  saved=${planPath}`);

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  if (!opts.execute) {
    console.log(`\n[DRY RUN] Re-run with --execute to apply ${mergePlan.length} merge(s) to the database.`);
    return;
  }

  if (!mergePlan.length) {
    console.log("\n[EXECUTE] Nothing to merge.");
    return;
  }

  console.log(`\n[EXECUTE] Applying ${mergePlan.length} merge(s)...`);
  let succeeded = 0;
  let failed = 0;

  for (const merge of mergePlan) {
    try {
      await executeMerge(merge);
      console.log(`  ✓ merged #${merge.source_cluster_id} → #${merge.target_cluster_id} (sim=${merge.similarity})`);
      succeeded++;
    } catch (err) {
      console.error(`  ✗ failed #${merge.source_cluster_id} → #${merge.target_cluster_id}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. succeeded=${succeeded} failed=${failed}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
