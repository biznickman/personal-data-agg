import type { StoryCluster } from "@/lib/x-news-stories";

export function StoryClusterCard({
  story,
  isLead,
}: {
  story: StoryCluster;
  isLead?: boolean;
}) {
  const leadTweet = story.tweets[0];
  const additionalTweets = story.tweets.slice(1);
  const headline = story.normalizedHeadline ?? "Untitled story";
  const summary = story.normalizedFacts[0] ?? leadTweet?.tweetText ?? "";

  // Collect unique usernames for the "X:" row
  const uniqueUsernames = [
    ...new Set(
      story.tweets
        .map((t) => t.username)
        .filter((u): u is string => u !== null)
    ),
  ];

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
          className={`font-bold leading-snug tm-link ${isLead ? "text-lg" : "text-base"}`}
          style={{ color: "var(--tm-headline)" }}
        >
          {headline}
        </a>
      ) : (
        <span
          className={`font-bold leading-snug ${isLead ? "text-lg" : "text-base"}`}
          style={{ color: "var(--tm-headline)" }}
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

      {/* More: links */}
      {additionalTweets.length > 0 ? (
        <div className="mt-1.5 text-xs" style={{ color: "var(--tm-text-muted)" }}>
          <span className="font-semibold">More: </span>
          {additionalTweets.map((tweet, i) => (
            <span key={tweet.tweetId}>
              {i > 0 ? ", " : ""}
              {tweet.link ? (
                <a
                  href={tweet.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tm-link"
                >
                  @{tweet.username ?? tweet.tweetId}
                </a>
              ) : (
                <span>@{tweet.username ?? tweet.tweetId}</span>
              )}
            </span>
          ))}
        </div>
      ) : null}

      {/* X: accounts */}
      {uniqueUsernames.length > 1 ? (
        <div className="mt-1 text-xs" style={{ color: "var(--tm-text-muted)" }}>
          <span className="font-semibold">X: </span>
          {uniqueUsernames.map((username, i) => (
            <span key={username}>
              {i > 0 ? ", " : ""}
              <a
                href={`https://x.com/${username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tm-link"
              >
                @{username}
              </a>
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
