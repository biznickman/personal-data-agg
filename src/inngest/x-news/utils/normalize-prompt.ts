export interface NormalizationUrlContext {
  url: string;
  content: string;
}

export interface NormalizationImageContext {
  index: number;
  category: string;
  summary: string;
}

export function buildNormalizationSystemPrompt(): string {
  return [
    "You are a financial news normalization engine.",
    "Turn noisy social posts into a concise canonical headline and factual bullet list.",
    "Rules:",
    "- Use only claims present in the input.",
    "- Do not add speculation, opinion, or outside knowledge.",
    "- Keep entity names, tickers, and numbers precise.",
    "- Facts must be atomic and independently understandable.",
    "- Ignore promotional fluff and engagement bait.",
    "- If there is no clear factual development, return an empty facts array and a short neutral headline.",
    "Return strict JSON with this schema:",
    '{"normalized_headline":"string","normalized_facts":["string"]}',
  ].join("\n");
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export function buildNormalizationUserPrompt(params: {
  tweetId: string;
  username: string | null;
  tweetText: string;
  quotedTweetText?: string | null;
  urlContexts: NormalizationUrlContext[];
  imageContexts?: NormalizationImageContext[];
}): string {
  const base = [
    `tweet_id: ${params.tweetId}`,
    `username: ${params.username ?? "unknown"}`,
    "",
    "<tweet_text>",
    clip(params.tweetText, 4000),
    "</tweet_text>",
  ];

  if (params.quotedTweetText) {
    base.push("", "<quoted_tweet>", clip(params.quotedTweetText, 2000), "</quoted_tweet>");
  }

  if (params.urlContexts.length > 0) {
    base.push("", "<linked_articles>");
    for (const [index, urlContext] of params.urlContexts.entries()) {
      base.push(`<article index="${index + 1}" url="${urlContext.url}">`);
      base.push(clip(urlContext.content, 2500));
      base.push("</article>");
    }
    base.push("</linked_articles>");
  }

  if (params.imageContexts && params.imageContexts.length > 0) {
    base.push("", "<image_analysis>");
    for (const img of params.imageContexts) {
      base.push(`<image index="${img.index}" category="${img.category}">`);
      base.push(clip(img.summary, 2000));
      base.push("</image>");
    }
    base.push("</image_analysis>");
  }

  base.push("", "Output JSON only.");
  return base.join("\n");
}
