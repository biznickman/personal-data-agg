import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function main() {
  // Find Warner Bros cluster
  console.log("=== Warner Bros clusters ===");
  const { data: wbClusters } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, is_active, is_story_candidate, merged_into_cluster_id, curated_at")
    .or("normalized_headline.ilike.%warner%,normalized_headline.ilike.%netflix%paramount%")
    .order("last_seen_at", { ascending: false })
    .limit(10);

  for (const c of wbClusters ?? []) {
    console.log(`\n#${c.id} active:${c.is_active} candidate:${c.is_story_candidate} merged_into:${c.merged_into_cluster_id}`);
    console.log(`  headline: ${c.normalized_headline}`);
    console.log(`  ${c.tweet_count}tw, ${c.unique_user_count}u, curated_at: ${c.curated_at}`);
  }

  // Search tweets about Warner Bros
  console.log("\n\n=== Warner Bros tweets ===");
  const { data: wbTweets } = await supabase
    .from("tweets")
    .select("id, tweet_id, username, tweet_text, normalized_headline, likes, retweets, normalized_headline_embedding")
    .or("tweet_text.ilike.%warner%,normalized_headline.ilike.%warner%")
    .order("tweet_time", { ascending: false })
    .limit(10);

  for (const t of wbTweets ?? []) {
    const hasEmb = t.normalized_headline_embedding != null;
    console.log(`\n@${t.username} (id:${t.id}) emb:${hasEmb} likes:${t.likes} rts:${t.retweets}`);
    console.log(`  headline: ${t.normalized_headline}`);
    console.log(`  text: ${(t.tweet_text || "").substring(0, 200)}`);
  }

  // Find "Link Shared Without Context" cluster
  console.log("\n\n=== 'Link Shared Without Context' cluster ===");
  const { data: linkClusters } = await supabase
    .from("x_news_clusters")
    .select("id, normalized_headline, tweet_count, unique_user_count, is_active")
    .eq("is_active", true)
    .ilike("normalized_headline", "%Link Shared Without Context%");

  for (const c of linkClusters ?? []) {
    console.log(`\nCluster #${c.id} (${c.tweet_count}tw, ${c.unique_user_count}u)`);

    const { data: members } = await supabase
      .from("x_news_cluster_tweets")
      .select("tweet_id")
      .eq("cluster_id", c.id);
    const dbIds = (members ?? []).map((r) => r.tweet_id);
    const { data: tweets } = await supabase
      .from("tweets")
      .select("id, username, tweet_text, normalized_headline, likes, link")
      .in("id", dbIds)
      .order("likes", { ascending: false })
      .limit(15);

    for (const t of tweets ?? []) {
      console.log(`\n  @${t.username} likes:${t.likes}`);
      console.log(`    headline: ${t.normalized_headline}`);
      console.log(`    text: ${(t.tweet_text || "").substring(0, 200)}`);
      console.log(`    link: ${t.link}`);
    }
  }
}

main();
