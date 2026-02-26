import type { StoryCluster } from "@/lib/x-news-stories";
import { formatRelativeTime } from "./relative-time";

export function NewestSidebar({ stories }: { stories: StoryCluster[] }) {
  if (stories.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--tm-text-muted)" }}>
        No recent stories.
      </p>
    );
  }

  return (
    <ul className="space-y-0">
      {stories.map((story) => {
        const leadTweet = story.tweets[0];
        const headline = story.normalizedHeadline ?? "Untitled story";

        return (
          <li
            key={story.clusterId}
            className="py-2.5"
            style={{ borderBottom: "1px solid var(--tm-border-light)" }}
          >
            {/* Source */}
            <div
              className="text-xs mb-0.5"
              style={{
                color: "var(--tm-text-muted)",
                fontFamily: "var(--tm-font-nav)",
              }}
            >
              {leadTweet?.username ? (
                <span>{leadTweet.username} / X</span>
              ) : (
                <span>X</span>
              )}
            </div>

            {/* Headline */}
            {leadTweet?.link ? (
              <a
                href={leadTweet.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-bold leading-snug tm-link"
                style={{ color: "var(--tm-headline)" }}
              >
                {headline}
              </a>
            ) : (
              <span
                className="text-sm font-bold leading-snug"
                style={{ color: "var(--tm-headline)" }}
              >
                {headline}
              </span>
            )}

            {/* Relative time */}
            <div
              className="text-xs mt-0.5"
              style={{ color: "var(--tm-text-muted)" }}
            >
              {formatRelativeTime(story.lastSeenAt)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
