import Link from "next/link";
import { StoryCluster } from "@/lib/x-news-stories";
import { StoryFeedback } from "./story-feedback";

interface StoryListProps {
  stories: StoryCluster[];
  showFeedback?: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function formatMetric(value: number | null): string {
  if (typeof value !== "number") return "0";
  return value.toLocaleString();
}

export function StoryList({ stories, showFeedback = false }: StoryListProps) {
  if (stories.length === 0) {
    return (
      <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-slate-400">
        No stories found for this window.
      </article>
    );
  }

  return (
    <>
      {stories.map((story) => (
        <article
          key={story.clusterId}
          className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-medium">
              {story.normalizedHeadline ?? "Untitled story cluster"}
            </h2>
            <span className="text-xs text-slate-400">#{story.clusterId}</span>
            <span className="text-xs text-slate-400">
              {story.tweetCount} tweets / {story.uniqueUserCount} users
            </span>
            <span className="text-xs text-slate-400">rank {story.rankScore.toFixed(2)}</span>
            {story.isStoryCandidate ? (
              <span className="text-xs px-2 py-0.5 border rounded border-green-500/50 text-green-300">
                story candidate
              </span>
            ) : null}
          </div>

          <p className="text-xs text-slate-400">
            First seen: {formatDate(story.firstSeenAt)} • Last seen: {formatDate(story.lastSeenAt)}
          </p>

          {story.normalizedFacts.length > 0 ? (
            <ul className="list-disc list-inside text-sm text-slate-300">
              {story.normalizedFacts.slice(0, 5).map((fact, idx) => (
                <li key={`${story.clusterId}-fact-${idx}`}>{fact}</li>
              ))}
            </ul>
          ) : null}

          {showFeedback ? (
            <StoryFeedback clusterId={story.clusterId} initialSummary={story.feedback} />
          ) : null}

          {story.tweets.length > 0 ? (
            <details className="rounded border border-slate-800 bg-slate-950/30 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-200">
                Tweets ({story.tweets.length})
              </summary>
              <div className="space-y-2 mt-3">
                {story.tweets.map((tweet) => (
                  <div
                    key={tweet.tweetId}
                    className="rounded border border-slate-800 bg-slate-950/50 p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span>{tweet.username ? `@${tweet.username}` : tweet.tweetId}</span>
                      <span>{formatDate(tweet.tweetTime)}</span>
                      {tweet.similarityScore !== null ? (
                        <span>sim: {tweet.similarityScore.toFixed(2)}</span>
                      ) : null}
                      {tweet.link ? (
                        <Link href={tweet.link} className="text-cyan-300 underline">
                          open
                        </Link>
                      ) : null}
                    </div>
                    {tweet.tweetText ? <p className="mt-1 text-slate-300">{tweet.tweetText}</p> : null}
                    <p className="mt-2 text-xs text-slate-500">
                      likes {formatMetric(tweet.likes)} • retweets {formatMetric(tweet.retweets)}
                      {" • "}replies {formatMetric(tweet.replies)} • quotes {formatMetric(tweet.quotes)}
                      {" • "}bookmarks {formatMetric(tweet.bookmarks)} • impressions{" "}
                      {formatMetric(tweet.impressions)}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </article>
      ))}
    </>
  );
}

