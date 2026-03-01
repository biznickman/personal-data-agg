const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function main() {
  console.log("=== SOURCE SIGNAL STATS ===\n");
  
  const { data: sources } = await supabase
    .from("x_news_source_signal_stats")
    .select("*")
    .order("signal_pct", { ascending: false })
    .limit(20);

  if (sources && sources.length > 0) {
    console.log("Top 20 most helpful sources (by % of tweets in stories):\n");
    for (const s of sources) {
      console.log(`@${s.name.padEnd(20)} | ${s.signal_pct.toFixed(1)}% signal (${s.tweets_in_stories_30d}/${s.total_tweets_30d} tweets, ${s.distinct_stories_30d} stories)`);
    }
  }

  console.log("\n\n=== CLUSTER FEEDBACK SUMMARY ===\n");
  
  const { data: feedback } = await supabase
    .from("x_news_cluster_feedback")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (feedback && feedback.length > 0) {
    console.log(`Latest ${feedback.length} feedback entries:\n`);
    const feedbackByType = { useful: 0, noise: 0, bad_cluster: 0 };
    for (const f of feedback) {
      feedbackByType[f.feedback_type] = (feedbackByType[f.feedback_type] || 0) + 1;
    }
    console.log("Feedback breakdown:");
    console.log(`  Useful: ${feedbackByType.useful}`);
    console.log(`  Noise: ${feedbackByType.noise}`);
    console.log(`  Bad cluster: ${feedbackByType.bad_cluster}`);
  } else {
    console.log("No feedback entries found yet.");
  }

  console.log("\n\n=== NOISE/SPAM PATTERN ANALYSIS ===\n");
  
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: noisyStories } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, is_story_candidate, normalized_facts")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .gte("last_seen_at", since)
    .order("tweet_count", { ascending: false })
    .limit(100);

  if (noisyStories) {
    // Look for patterns that suggest spam or noise
    const patterns = {
      "airdrop/giveaway": 0,
      "trading signals": 0,
      "price updates only": 0,
      "crypto spam": 0,
    };

    for (const story of noisyStories) {
      const text = (story.normalized_headline || "").toLowerCase();
      if (text.includes("airdrop") || text.includes("giveaway")) patterns["airdrop/giveaway"]++;
      if (text.includes("signal") || text.includes("signal service")) patterns["trading signals"]++;
      if (/price|trading|market|up|down|bullish|bearish/.test(text) && text.length < 60) patterns["price updates only"]++;
      if (text.includes("crypto") || text.includes("bitcoin") || text.includes("ethereum")) patterns["crypto spam"]++;
    }

    console.log("Potential noise patterns detected (24h candidates):");
    for (const [pattern, count] of Object.entries(patterns)) {
      if (count > 0) {
        const pct = ((count / noisyStories.length) * 100).toFixed(1);
        console.log(`  ${pattern}: ${count} (${pct}%)`);
      }
    }
  }

  console.log("\n\n=== CURATION STATUS ===\n");
  
  const { data: uncurated } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, is_story_candidate")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .is("curated_at", null)
    .gte("last_seen_at", since)
    .limit(100);

  if (uncurated) {
    console.log(`Story candidates awaiting curation (24h): ${uncurated.length}`);
  }

  const { data: curated } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, is_story_candidate")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .not("curated_at", "is", null)
    .gte("last_seen_at", since)
    .limit(100);

  if (curated) {
    console.log(`Story candidates already curated (24h): ${curated.length}`);
  }
}

main().catch(console.error);
