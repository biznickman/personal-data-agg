const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function main() {
  console.log("=== RECENT PROMOTED STORIES ===\n");
  
  const { data: promoted } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, promoted_at, curated_at, first_seen_at, last_seen_at")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .not("promoted_at", "is", null)
    .order("promoted_at", { ascending: false })
    .limit(30);

  if (promoted && promoted.length > 0) {
    console.log(`Found ${promoted.length} promoted story candidates:\n`);
    for (const story of promoted) {
      const promotedTime = story.promoted_at ? new Date(story.promoted_at).toLocaleString() : "N/A";
      const lastSeenTime = story.last_seen_at ? new Date(story.last_seen_at).toLocaleString() : "N/A";
      console.log(`#${story.id} - "${story.normalized_headline}"`);
      console.log(`  Promoted: ${promotedTime}`);
      console.log(`  Tweets: ${story.tweet_count}, Users: ${story.unique_user_count}`);
      console.log(`  Last seen: ${lastSeenTime}`);
      console.log();
    }
  } else {
    console.log("No promoted stories found.");
  }

  console.log("\n=== RECENT STORY CANDIDATES (24h, NOT promoted) ===\n");
  
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, promoted_at, curated_at, first_seen_at, last_seen_at")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .is("promoted_at", null)
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(50);

  if (candidates && candidates.length > 0) {
    console.log(`Found ${candidates.length} unpromoted story candidates in last 24h.\n`);
    console.log("TOP 10:\n");
    for (const story of candidates.slice(0, 10)) {
      const lastSeenTime = story.last_seen_at ? new Date(story.last_seen_at).toLocaleString() : "N/A";
      console.log(`#${story.id} - "${story.normalized_headline}"`);
      console.log(`  Tweets: ${story.tweet_count}, Users: ${story.unique_user_count}`);
      console.log(`  Last seen: ${lastSeenTime}`);
      console.log(`  Curated: ${story.curated_at ? "Yes" : "No"}`);
      console.log();
    }
  } else {
    console.log("No unpromoted story candidates found in last 24h.");
  }

  console.log("\n=== ALL ACTIVE STORY CANDIDATES (24h window) ===\n");
  
  const { data: allStories } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, promoted_at, curated_at, first_seen_at, last_seen_at")
    .eq("is_active", true)
    .eq("is_story_candidate", true)
    .gte("last_seen_at", since)
    .order("tweet_count", { ascending: false })
    .limit(100);

  if (allStories && allStories.length > 0) {
    console.log(`Summary stats (24h window):`);
    console.log(`  Total story candidates: ${allStories.length}`);
    const promoted_count = allStories.filter(s => s.promoted_at).length;
    const unpromoted_count = allStories.length - promoted_count;
    console.log(`  Promoted: ${promoted_count}`);
    console.log(`  Not promoted: ${unpromoted_count}`);
    
    const avgTweets = allStories.reduce((s, c) => s + (c.tweet_count || 0), 0) / allStories.length;
    const avgUsers = allStories.reduce((s, c) => s + (c.unique_user_count || 0), 0) / allStories.length;
    console.log(`  Avg tweets per story: ${avgTweets.toFixed(1)}`);
    console.log(`  Avg users per story: ${avgUsers.toFixed(1)}`);
  }
}

main().catch(console.error);
