import Link from "next/link";
import { getSystemHealth, type FunctionHealth } from "@/lib/monitoring";
import { getLatestXNewsStories } from "@/lib/x-news-stories";

export const dynamic = "force-dynamic";

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function statusClasses(status: FunctionHealth["status"]): string {
  if (status === "ok") return "bg-green-600/20 text-green-200 border-green-500/50";
  if (status === "stale") return "bg-amber-600/20 text-amber-200 border-amber-500/50";
  if (status === "error") return "bg-red-600/20 text-red-200 border-red-500/50";
  return "bg-slate-600/20 text-slate-200 border-slate-500/50";
}

export default async function Home() {
  const [health, stories] = await Promise.all([
    getSystemHealth(),
    getLatestXNewsStories({
      limit: 8,
      lookbackHours: 24,
      onlyStoryCandidates: false,
      maxTweetsPerStory: 3,
    }),
  ]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Ingestion Engine</h1>
          <p className="text-slate-400">
            API-driven ingestion pipeline with Inngest scheduling and Supabase storage.
          </p>
          <div className="text-sm text-slate-300">
            <span className="mr-2">Overall:</span>
            <span
              className={`inline-flex px-2 py-1 rounded border ${statusClasses(
                health.overall === "degraded" ? "stale" : health.overall
              )}`}
            >
              {health.overall}
            </span>
            <span className="ml-4 text-slate-400">Checked: {formatDate(health.checkedAt)}</span>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {health.functions.map((item) => (
            <article
              key={item.id}
              className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">{item.name}</h2>
                  <p className="text-sm text-slate-400">{item.schedule}</p>
                </div>
                <span className={`inline-flex px-2 py-1 rounded border ${statusClasses(item.status)}`}>
                  {item.status}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-slate-400">Rows</dt>
                  <dd>{item.rowCount?.toLocaleString() ?? "n/a"}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Latest Data</dt>
                  <dd>{formatDate(item.latestDataAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Last Run</dt>
                  <dd>{formatDate(item.lastRunAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Function ID</dt>
                  <dd className="font-mono text-xs">{item.id}</dd>
                </div>
              </dl>

              {item.errorMessage ? (
                <p className="text-sm text-red-300">Last error: {item.errorMessage}</p>
              ) : null}
              {item.queryError ? (
                <p className="text-sm text-red-300">Supabase query error: {item.queryError}</p>
              ) : null}

              <div className="flex gap-3 text-sm">
                <Link href={item.logsUrl} className="text-cyan-300 hover:text-cyan-200 underline">
                  Inngest logs
                </Link>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-5 text-sm">
          <p>Supabase connection: {health.supabase.ok ? "ok" : "error"}</p>
          {health.supabase.error ? (
            <p className="text-red-300 mt-1">Error: {health.supabase.error}</p>
          ) : null}
          <p className="mt-2">
            Health endpoint:{" "}
            <Link href="/api/health" className="text-cyan-300 hover:text-cyan-200 underline">
              /api/health
            </Link>
          </p>
          <p className="mt-1">
            Stories endpoint:{" "}
            <Link
              href="/api/x-news/stories?hours=24&limit=20"
              className="text-cyan-300 hover:text-cyan-200 underline"
            >
              /api/x-news/stories
            </Link>
          </p>
          <p className="mt-1">
            Stories page:{" "}
            <Link href="/news" className="text-cyan-300 hover:text-cyan-200 underline">
              /news
            </Link>
          </p>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">Latest X News Clusters (24h)</h2>
            <span className="text-xs text-slate-400">{stories.length} clusters</span>
          </div>

          {stories.length === 0 ? (
            <p className="text-sm text-slate-400 mt-3">No clusters in the current window.</p>
          ) : (
            <ul className="mt-4 space-y-3 text-sm">
              {stories.map((story) => (
                <li key={story.clusterId} className="rounded border border-slate-800 p-3 bg-slate-950/40">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{story.normalizedHeadline ?? "Untitled cluster"}</span>
                    <span className="text-xs text-slate-400">#{story.clusterId}</span>
                    <span className="text-xs text-slate-400">
                      {story.tweetCount} tweets / {story.uniqueUserCount} users
                    </span>
                    {story.isStoryCandidate ? (
                      <span className="text-xs px-2 py-0.5 border rounded border-green-500/50 text-green-300">
                        story candidate
                      </span>
                    ) : null}
                  </div>

                  {story.normalizedFacts.length > 0 ? (
                    <p className="mt-2 text-slate-300 line-clamp-2">{story.normalizedFacts.join(" ")}</p>
                  ) : null}

                  {story.tweets.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                      {story.tweets.map((tweet) =>
                        tweet.link ? (
                          <Link key={tweet.tweetId} href={tweet.link} className="underline text-cyan-300">
                            {tweet.username ? `@${tweet.username}` : tweet.tweetId}
                          </Link>
                        ) : (
                          <span key={tweet.tweetId}>{tweet.username ? `@${tweet.username}` : tweet.tweetId}</span>
                        )
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
