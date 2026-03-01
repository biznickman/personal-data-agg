import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function main() {
  const { data, error } = await supabase
    .from("x_news_source_signal_stats")
    .select("*")
    .order("signal_pct", { ascending: false });

  if (error) {
    console.error("Failed to query signal stats:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No source signal stats found.");
    return;
  }

  const header = [
    "Account".padEnd(22),
    "Active",
    "Tweets".padStart(8),
    "In Stories".padStart(12),
    "Stories".padStart(9),
    "Signal %".padStart(10),
  ].join(" ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of data) {
    console.log(
      [
        String(row.name).padEnd(22),
        row.is_active ? "  yes " : "  no  ",
        String(row.total_tweets_30d).padStart(8),
        String(row.tweets_in_stories_30d).padStart(12),
        String(row.distinct_stories_30d).padStart(9),
        `${row.signal_pct}%`.padStart(10),
      ].join(" ")
    );
  }

  const totals = data.reduce(
    (acc, row) => {
      acc.tweets += row.total_tweets_30d;
      acc.inStories += row.tweets_in_stories_30d;
      acc.stories += row.distinct_stories_30d;
      return acc;
    },
    { tweets: 0, inStories: 0, stories: 0 }
  );

  console.log("-".repeat(header.length));
  const overallPct =
    totals.tweets === 0
      ? 0
      : Math.round((1000 * totals.inStories) / totals.tweets) / 10;
  console.log(
    [
      "TOTAL".padEnd(22),
      "      ",
      String(totals.tweets).padStart(8),
      String(totals.inStories).padStart(12),
      String(totals.stories).padStart(9),
      `${overallPct}%`.padStart(10),
    ].join(" ")
  );
}

main();
