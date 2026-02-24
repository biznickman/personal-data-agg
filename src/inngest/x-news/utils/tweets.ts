import type { Tweet } from "../services/twitterapi-io";

export function dedupeTweetsById(tweets: Tweet[]): Tweet[] {
  const map = new Map<string, Tweet>();
  for (const tweet of tweets) {
    if (tweet.id) {
      map.set(tweet.id, tweet);
    }
  }
  return [...map.values()];
}

