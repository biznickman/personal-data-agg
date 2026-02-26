import type { StoryCluster, StoryTweet } from "@/lib/x-news-stories";

export function StoryClusterCard({
  story,
  isLead,
}: {
  story: StoryCluster;
  isLead?: boolean;
}) {
  const leadTweet = story.tweets[0];
  const headline = story.normalizedHeadline ?? "Untitled story";
  const summary = story.normalizedFacts[0] ?? leadTweet?.tweetText ?? "";

  // Build a map of best (highest-engagement, i.e. first in sorted array) tweet per user
  const bestPerUser = new Map<string, StoryTweet>();
  for (const t of story.tweets) {
    if (!t.username) continue;
    const key = t.username.toLowerCase();
    if (!bestPerUser.has(key)) {
      bestPerUser.set(key, t);
    }
  }

  return (
    <article
      className="py-3"
      style={{ borderBottom: "1px solid var(--tm-border-light)" }}
    >
      {/* Source attribution */}
      <div
        className="text-xs mb-1"
        style={{ color: "var(--tm-text-muted)", fontFamily: "var(--tm-font-nav)" }}
      >
        {leadTweet?.username ? (
          <span>{leadTweet.username} / X:</span>
        ) : (
          <span>X:</span>
        )}
      </div>

      {/* Headline */}
      {leadTweet?.link ? (
        <a
          href={leadTweet.link}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold leading-snug tm-link"
          style={{ color: "var(--tm-headline)", fontSize: "22px" }}
        >
          {headline}
        </a>
      ) : (
        <span
          className="font-bold leading-snug"
          style={{ color: "var(--tm-headline)", fontSize: "22px" }}
        >
          {headline}
        </span>
      )}

      {/* Summary */}
      {summary ? (
        <p
          className="text-sm mt-1 line-clamp-2"
          style={{ color: "var(--tm-text)" }}
        >
          &mdash; {summary}
        </p>
      ) : null}

      {/* X: accounts with hover previews */}
      {bestPerUser.size > 1 ? (
        <div className="mt-1" style={{ color: "var(--tm-text-muted)", fontSize: "14px" }}>
          <span className="font-semibold">X: </span>
          {[...bestPerUser.values()].map((tweet, i) => {
            const previewBody = tweet.tweetText
              ? tweet.tweetText.slice(0, 280 - `@${tweet.username}: `.length)
              : null;
            return (
              <span key={tweet.tweetId}>
                {i > 0 ? ", " : ""}
                <span className="tweet-preview-wrap">
                  <a
                    href={tweet.link ?? `https://x.com/${tweet.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tm-link"
                  >
                    @{tweet.username}
                  </a>
                  {previewBody ? (
                    <div className="tweet-preview">
                      <strong>@{tweet.username}:</strong> {previewBody}
                    </div>
                  ) : null}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
