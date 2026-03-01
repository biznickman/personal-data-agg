import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function main() {
  // Check most recent clusters
  const { data: clusters } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, first_seen_at, last_seen_at, promoted_at, curated_at, is_active, is_story_candidate, tweet_count")
    .eq("is_active", true)
    .order("last_seen_at", { ascending: false })
    .limit(10);

  console.log("=== Most recent active clusters ===");
  for (const c of clusters ?? []) {
    console.log(`\nCluster #${c.id} (${c.tweet_count}tw, candidate:${c.is_story_candidate})`);
    console.log(`  headline: ${(c.normalized_headline ?? "(null)").substring(0, 80)}`);
    console.log(`  first_seen:  ${c.first_seen_at}`);
    console.log(`  last_seen:   ${c.last_seen_at}`);
    console.log(`  promoted_at: ${c.promoted_at}`);
  }

  // Check most recent tweets ingested
  const { data: tweets } = await supabase
    .from("tweets")
    .select("id, username, tweet_time, normalized_headline")
    .order("tweet_time", { ascending: false })
    .limit(5);

  console.log("\n\n=== Most recent tweets ingested ===");
  for (const t of tweets ?? []) {
    console.log(`@${t.username} at ${t.tweet_time} - ${(t.normalized_headline ?? "(no headline)").substring(0, 60)}`);
  }

  console.log("\n\nCurrent time: " + new Date().toISOString());
}

main();
