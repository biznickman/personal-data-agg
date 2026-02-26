type NormalizerProvider = "openrouter" | "portkey";

interface NormalizerConfig {
  provider: NormalizerProvider;
  model: string;
}

interface ChatChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
}

const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-haiku";
const DEFAULT_PORTKEY_MODEL = "anthropic/claude-3-5-haiku-latest";

function getNormalizerConfig(): NormalizerConfig {
  const provider = (
    process.env.X_NEWS_NORMALIZER_PROVIDER ?? "openrouter"
  ).toLowerCase();

  if (provider !== "openrouter" && provider !== "portkey") {
    throw new Error(
      `Unsupported X_NEWS_NORMALIZER_PROVIDER: ${provider}. Use "openrouter" or "portkey".`
    );
  }

  const model =
    process.env.X_NEWS_NORMALIZER_MODEL ??
    (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_PORTKEY_MODEL);

  return { provider, model };
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean);
    return parts.join("\n").trim();
  }
  throw new Error("LLM response did not include message content");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Could not find JSON object in LLM response");
}

type VisionMessage = {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail: "low" | "high" } }
      >;
};

async function callVisionOpenRouter(params: {
  model: string;
  messages: VisionMessage[];
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "ingestion-engine",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: params.maxTokens ?? 500,
      response_format: { type: "json_object" },
      messages: params.messages,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  return extractMessageContent(payload);
}

async function callVisionPortkey(params: {
  model: string;
  messages: VisionMessage[];
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.PORTKEY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing PORTKEY_API_KEY");
  }

  const baseUrl = (process.env.PORTKEY_BASE_URL ?? "https://api.portkey.ai/v1").replace(
    /\/$/,
    ""
  );
  const config = process.env.PORTKEY_CONFIG;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-portkey-api-key": apiKey,
  };
  if (config) headers["x-portkey-config"] = config;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: params.maxTokens ?? 500,
      response_format: { type: "json_object" },
      messages: params.messages,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Portkey ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  return extractMessageContent(payload);
}

async function callVision(params: {
  messages: VisionMessage[];
  maxTokens?: number;
}): Promise<string> {
  const config = getNormalizerConfig();
  const callFn = config.provider === "openrouter" ? callVisionOpenRouter : callVisionPortkey;
  return callFn({
    model: config.model,
    messages: params.messages,
    maxTokens: params.maxTokens,
  });
}

// --- Classification ---

export interface ImageClassification {
  image_category: string;
  warrants_financial_analysis: boolean;
  brief_description: string;
  reason: string;
}

const CLASSIFY_SYSTEM_PROMPT = [
  "You are an image classification engine for a financial news pipeline.",
  "Categorize the image and decide whether it warrants deeper financial analysis.",
  "Categories: logo, person, place, news_headline, chart, table, tweet, document, article, other",
  "Images that warrant financial analysis: chart, table, news_headline, document, article, tweet (if financial content).",
  "Return strict JSON with this schema:",
  '{"image_category":"string","warrants_financial_analysis":boolean,"brief_description":"string","reason":"string"}',
].join("\n");

export async function classifyImage(imageUrl: string): Promise<ImageClassification> {
  const messages: VisionMessage[] = [
    { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: imageUrl, detail: "low" },
        },
        {
          type: "text",
          text: "Classify this image. Output JSON only.",
        },
      ],
    },
  ];

  const rawContent = await callVision({ messages, maxTokens: 300 });
  const parsed = extractJsonObject(rawContent) as Record<string, unknown>;

  return {
    image_category:
      typeof parsed.image_category === "string" ? parsed.image_category : "other",
    warrants_financial_analysis: parsed.warrants_financial_analysis === true,
    brief_description:
      typeof parsed.brief_description === "string" ? parsed.brief_description : "",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

// --- Summarization ---

export interface ImageSummary {
  summary: string;
}

const SUMMARIZE_SYSTEM_PROMPT = [
  "You are a financial image analysis engine.",
  "Produce a concise 1-3 sentence summary of the financial content in the image.",
  "Use the tweet text for additional context. Focus on data, numbers, entities, and claims visible in the image.",
  "Return strict JSON with this schema:",
  '{"summary":"string"}',
].join("\n");

export async function summarizeImage(
  imageUrl: string,
  tweetText: string
): Promise<ImageSummary> {
  const messages: VisionMessage[] = [
    { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: imageUrl, detail: "high" },
        },
        {
          type: "text",
          text: `Tweet text: ${tweetText}\n\nSummarize the financial content in this image. Output JSON only.`,
        },
      ],
    },
  ];

  const rawContent = await callVision({ messages, maxTokens: 500 });
  const parsed = extractJsonObject(rawContent) as Record<string, unknown>;

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}
