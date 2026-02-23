import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type PreviewTweet = {
  tweet_id: string;
  username: string | null;
  tweet_time: string | null;
  link: string | null;
  tweet_text: string | null;
};

type PreviewStory = {
  cluster_id: number;
  headline: string;
  tweet_count: number;
  unique_users: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  tweets: PreviewTweet[];
};

type PreviewConfig = {
  name: string;
  assign_threshold: number;
  merge_threshold: number;
  score: number;
  clusters: number;
  singletons: number;
  story_filtered: number;
  residual_dup_pairs: number;
};

type PreviewPayload = {
  generated_at: string;
  input_tweets: number;
  lexical_baseline_clusters: number;
  embedding: {
    provider: string;
    model: string;
    total_tokens: number;
    estimated_cost_usd: number;
  };
  best_config: {
    name: string;
    assign_threshold: number;
    merge_threshold: number;
    score: number;
    metrics: {
      clusters: number;
      singletons: number;
      multi: number;
      story_raw: number;
      story_filtered: number;
      promo_filtered_clusters: number;
      residual_dup_pairs: number;
      largest: number;
    };
  };
  top_configs: PreviewConfig[];
  stories: PreviewStory[];
};

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

async function loadPreview(): Promise<{ payload: PreviewPayload | null; sourcePath: string }> {
  const sourcePath = path.join(
    process.cwd(),
    "scripts",
    "output",
    "embedding-story-preview-latest.json"
  );

  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const payload = JSON.parse(raw) as PreviewPayload;
    return { payload, sourcePath };
  } catch {
    return { payload: null, sourcePath };
  }
}

export default async function NewsPreviewPage() {
  const { payload, sourcePath } = await loadPreview();

  if (!payload) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
        <div className="max-w-5xl mx-auto space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight">Embedding Story Preview</h1>
          <p className="text-slate-400">No preview file found yet.</p>
          <pre className="text-xs p-3 bg-slate-900 border border-slate-800 rounded overflow-x-auto">
            {`Expected: ${sourcePath}`}
          </pre>
          <pre className="text-xs p-3 bg-slate-900 border border-slate-800 rounded overflow-x-auto">
            {"Run: pnpm stories:embedding-preview -- --hours 24 --limit 300"}
          </pre>
          <Link href="/news" className="text-cyan-300 underline">
            Back to /news
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Embedding Story Preview</h1>
          <p className="text-slate-400">
            Offline semantic clustering preview from latest run.
          </p>
          <p className="text-xs text-slate-500">
            Generated: {formatDate(payload.generated_at)} • Input tweets: {payload.input_tweets}
          </p>
          <div className="text-xs text-slate-400">
            Embedding: {payload.embedding.provider} / {payload.embedding.model} • tokens {payload.embedding.total_tokens} • est ${payload.embedding.estimated_cost_usd.toFixed(6)}
          </div>
          <div className="text-xs text-slate-400">
            Best config: {payload.best_config.name} (assign {payload.best_config.assign_threshold}, merge {payload.best_config.merge_threshold})
          </div>
          <div className="flex gap-3 text-sm">
            <Link href="/news" className="text-cyan-300 underline">
              /news
            </Link>
            <Link href="/api/x-news/stories/preview" className="text-cyan-300 underline">
              /api/x-news/stories/preview
            </Link>
          </div>
        </header>

        <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <h2 className="text-lg font-medium">Top Configs</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="py-2 pr-3">Config</th>
                  <th className="py-2 pr-3">Assign</th>
                  <th className="py-2 pr-3">Merge</th>
                  <th className="py-2 pr-3">Score</th>
                  <th className="py-2 pr-3">Clusters</th>
                  <th className="py-2 pr-3">Singletons</th>
                  <th className="py-2 pr-3">Stories</th>
                  <th className="py-2 pr-3">Residual Dupes</th>
                </tr>
              </thead>
              <tbody>
                {payload.top_configs.map((row) => (
                  <tr key={row.name} className="border-b border-slate-900/60">
                    <td className="py-2 pr-3 font-mono text-xs">{row.name}</td>
                    <td className="py-2 pr-3">{row.assign_threshold}</td>
                    <td className="py-2 pr-3">{row.merge_threshold}</td>
                    <td className="py-2 pr-3">{row.score.toFixed(1)}</td>
                    <td className="py-2 pr-3">{row.clusters}</td>
                    <td className="py-2 pr-3">{row.singletons}</td>
                    <td className="py-2 pr-3">{row.story_filtered}</td>
                    <td className="py-2 pr-3">{row.residual_dup_pairs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Generated Stories</h2>
          {payload.stories.length === 0 ? (
            <div className="rounded border border-slate-800 bg-slate-900/50 p-4 text-slate-400 text-sm">
              No stories in the best config for this run.
            </div>
          ) : (
            payload.stories.map((story) => (
              <article
                key={story.cluster_id}
                className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-2"
              >
                <div className="flex flex-wrap gap-2 items-center">
                  <h3 className="text-base font-medium">{story.headline}</h3>
                  <span className="text-xs text-slate-400">#{story.cluster_id}</span>
                  <span className="text-xs text-slate-400">
                    {story.tweet_count} tweets / {story.unique_users} users
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  First: {formatDate(story.first_seen_at)} • Last: {formatDate(story.last_seen_at)}
                </p>
                <div className="space-y-1 text-sm">
                  {story.tweets.map((tweet) => (
                    <div key={tweet.tweet_id} className="text-slate-300">
                      <span className="text-slate-400 mr-2">{tweet.username ? `@${tweet.username}` : tweet.tweet_id}</span>
                      {tweet.link ? (
                        <Link href={tweet.link} className="text-cyan-300 underline mr-2">
                          open
                        </Link>
                      ) : null}
                      <span className="text-slate-500 text-xs">{formatDate(tweet.tweet_time)}</span>
                    </div>
                  ))}
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
