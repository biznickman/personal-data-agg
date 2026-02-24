import {
  searchTweets,
  searchTweetsPaginated,
  type Tweet,
} from "../services/twitterapi-io";

interface FetchTweetsForSourcesParams {
  apiKey: string;
  sources: string[];
  batchSize?: number;
  delayMs?: number;
}

interface FetchTweetsForKeywordQueryParams {
  apiKey: string;
  query: string;
  pages?: number;
}

export interface FetchTweetsForSourcesResult {
  allTweets: Tweet[];
  batches: number;
  failedBatches: number;
}

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_DELAY_MS = 5_500;

function chunk<T>(input: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    output.push(input.slice(i, i + size));
  }
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTweetsForSources(
  params: FetchTweetsForSourcesParams
): Promise<FetchTweetsForSourcesResult> {
  const batchSize = params.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = params.delayMs ?? DEFAULT_DELAY_MS;
  const batches = chunk(params.sources, batchSize);

  const allTweets: Tweet[] = [];
  let failedBatches = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const query = batch.map((handle) => `from:${handle}`).join(" OR ");

    try {
      const result = await searchTweets(params.apiKey, query);
      allTweets.push(...result.tweets);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      failedBatches += 1;
      console.error(
        `Error fetching X batch [${batch.slice(0, 3).join(", ")}...]: ${message}`
      );
    }

    if (i < batches.length - 1) {
      await sleep(delayMs);
    }
  }

  return {
    allTweets,
    batches: batches.length,
    failedBatches,
  };
}

export async function fetchTweetsForKeywordQuery(
  params: FetchTweetsForKeywordQueryParams
): Promise<Tweet[]> {
  return searchTweetsPaginated(params.apiKey, params.query, params.pages ?? 2);
}
