#!/usr/bin/env node
/**
 * cluster-health-check.cjs
 *
 * Post-deploy analysis of cluster quality after the Jaccard fix.
 * Checks for duplicates, size distribution, and overall health.
 */

"use strict";

const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.local"), quiet: true });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  console.log("=== Cluster Health Check ===\n");

  // 1. Overall cluster counts
  const { data: allClusters, error: clusterErr } = await supabase
    .from("x_news_clusters")
    .select("id,normalized_headline,tweet_count,unique_user_count,is_active,is_story_candidate,first_seen_at,last_seen_at,merged_into_cluster_id");

  if (clusterErr) {
    console.error("Failed to load clusters:", clusterErr.message);
    return;
  }

  const active = allClusters.filter(c => c.is_active && !c.merged_into_cluster_id);
  const merged = allClusters.filter(c => c.merged_into_cluster_id);
  const inactive = allClusters.filter(c => !c.is_active && !c.merged_into_cluster_id);
  const storyCandidates = active.filter(c => c.is_story_candidate);

  console.log("── Cluster Overview ──");
  console.log(`  Total rows:         ${allClusters.length}`);
  console.log(`  Active (unmerged):  ${active.length}`);
  console.log(`  Inactive:           ${inactive.length}`);
  console.log(`  Merged:             ${merged.length}`);
  console.log(`  Story candidates:   ${storyCandidates.length}`);
  console.log();

  // 2. Size distribution of active clusters
  const sizeBuckets = { "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11-20": 0, "21-50": 0, "51+": 0 };
  for (const c of active) {
    const n = c.tweet_count;
    if (n <= 1) sizeBuckets["1"]++;
    else if (n <= 2) sizeBuckets["2"]++;
    else if (n <= 5) sizeBuckets["3-5"]++;
    else if (n <= 10) sizeBuckets["6-10"]++;
    else if (n <= 20) sizeBuckets["11-20"]++;
    else if (n <= 50) sizeBuckets["21-50"]++;
    else sizeBuckets["51+"]++;
  }

  console.log("── Active Cluster Size Distribution ──");
  for (const [bucket, count] of Object.entries(sizeBuckets)) {
    const bar = "█".repeat(Math.min(count, 60));
    console.log(`  ${bucket.padStart(5)} tweets: ${String(count).padStart(4)} ${bar}`);
  }
  console.log();

  // 3. Duplicate headline detection
  const headlineMap = new Map();
  for (const c of active) {
    const h = (c.normalized_headline || "").trim().toLowerCase();
    if (!h) continue;
    if (!headlineMap.has(h)) headlineMap.set(h, []);
    headlineMap.get(h).push(c);
  }

  const exactDupes = [...headlineMap.entries()]
    .filter(([, clusters]) => clusters.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log("── Exact Headline Duplicates (active clusters) ──");
  if (exactDupes.length === 0) {
    console.log("  None found! ✓");
  } else {
    console.log(`  ${exactDupes.length} duplicate headline groups found:\n`);
    for (const [headline, clusters] of exactDupes.slice(0, 15)) {
      const display = headline.length > 80 ? headline.slice(0, 80) + "…" : headline;
      console.log(`  [${clusters.length}x] "${display}"`);
      for (const c of clusters) {
        console.log(`        cluster #${c.id} — ${c.tweet_count} tweets, ${c.unique_user_count} users`);
      }
    }
    if (exactDupes.length > 15) {
      console.log(`  ... and ${exactDupes.length - 15} more groups`);
    }
  }
  console.log();

  // 4. Near-duplicate detection (first 8 words match)
  const prefixMap = new Map();
  for (const c of active) {
    const h = (c.normalized_headline || "").trim().toLowerCase();
    if (!h) continue;
    const prefix = h.split(/\s+/).slice(0, 8).join(" ");
    if (!prefix) continue;
    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix).push(c);
  }

  const nearDupes = [...prefixMap.entries()]
    .filter(([, clusters]) => clusters.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log("── Near-Duplicate Headlines (first 8 words match) ──");
  if (nearDupes.length === 0) {
    console.log("  None found! ✓");
  } else {
    console.log(`  ${nearDupes.length} near-duplicate groups:\n`);
    for (const [prefix, clusters] of nearDupes.slice(0, 10)) {
      const display = prefix.length > 70 ? prefix.slice(0, 70) + "…" : prefix;
      console.log(`  [${clusters.length}x] "${display}..."`);
      for (const c of clusters) {
        const fullH = (c.normalized_headline || "").slice(0, 90);
        console.log(`        #${c.id} (${c.tweet_count} tw) ${fullH}`);
      }
    }
    if (nearDupes.length > 10) {
      console.log(`  ... and ${nearDupes.length - 10} more groups`);
    }
  }
  console.log();

  // 5. Top stories by tweet count
  const topByTweets = [...active]
    .sort((a, b) => b.tweet_count - a.tweet_count)
    .slice(0, 15);

  console.log("── Top 15 Active Clusters by Tweet Count ──");
  for (const c of topByTweets) {
    const h = (c.normalized_headline || "(no headline)").slice(0, 80);
    const sc = c.is_story_candidate ? "★" : " ";
    console.log(`  ${sc} #${String(c.id).padStart(5)} | ${String(c.tweet_count).padStart(4)} tweets | ${String(c.unique_user_count).padStart(3)} users | ${h}`);
  }
  console.log();

  // 6. Cluster membership stats
  const { count: totalMemberships } = await supabase
    .from("x_news_cluster_tweets")
    .select("*", { count: "exact", head: true });

  const { count: totalMerges } = await supabase
    .from("x_news_cluster_merges")
    .select("*", { count: "exact", head: true });

  console.log("── Membership & Merge Stats ──");
  console.log(`  Total tweet-cluster assignments: ${totalMemberships}`);
  console.log(`  Total merges recorded:           ${totalMerges}`);
  if (active.length > 0) {
    const avgSize = active.reduce((s, c) => s + c.tweet_count, 0) / active.length;
    const maxSize = Math.max(...active.map(c => c.tweet_count));
    console.log(`  Avg active cluster size:         ${avgSize.toFixed(1)} tweets`);
    console.log(`  Max active cluster size:         ${maxSize} tweets`);
  }
  console.log();

  // 7. Summary verdict
  const totalDupeHeadlines = exactDupes.reduce((s, [, c]) => s + c.length, 0);
  console.log("── Summary ──");
  if (exactDupes.length === 0 && nearDupes.length <= 3) {
    console.log("  Cluster quality looks good — minimal duplication detected.");
  } else if (exactDupes.length > 0) {
    console.log(`  ⚠ Found ${exactDupes.length} exact-duplicate headline groups (${totalDupeHeadlines} clusters).`);
    console.log("  The curate function should clean these up on its next run.");
  }
  if (nearDupes.length > 3) {
    console.log(`  ⚠ Found ${nearDupes.length} near-duplicate groups — worth monitoring.`);
  }
}

run().catch(console.error);
