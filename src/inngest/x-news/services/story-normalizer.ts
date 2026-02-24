import {
  buildNormalizationSystemPrompt,
  buildNormalizationUserPrompt,
  type NormalizationUrlContext,
} from "../utils/normalize-prompt";

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

interface NormalizationPayload {
  normalized_headline?: unknown;
  normalized_facts?: unknown;
}

export interface NormalizedStory {
  normalizedHeadline: string;
  normalizedFacts: string[];
  provider: NormalizerProvider;
  model: string;
}

const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-haiku";
const DEFAULT_PORTKEY_MODEL = "anthropic/claude-3-5-haiku-latest";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

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

function parseNormalizationPayload(rawContent: string): {
  normalizedHeadline: string;
  normalizedFacts: string[];
} {
  const parsed = extractJsonObject(rawContent) as NormalizationPayload;

  const headlineRaw =
    typeof parsed.normalized_headline === "string"
      ? compactWhitespace(parsed.normalized_headline)
      : "";

  const factsRaw = Array.isArray(parsed.normalized_facts)
    ? parsed.normalized_facts
    : [];

  const normalizedFacts = Array.from(
    new Set(
      factsRaw
        .filter((fact): fact is string => typeof fact === "string")
        .map((fact) => compactWhitespace(fact))
        .filter((fact) => fact.length > 0)
    )
  ).slice(0, 12);

  const normalizedHeadline =
    headlineRaw ||
    normalizedFacts[0] ||
    "No clear factual development in source content";

  return {
    normalizedHeadline: normalizedHeadline.slice(0, 240),
    normalizedFacts,
  };
}

async function callOpenRouter(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
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
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
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

async function callPortkey(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
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
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
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

export async function normalizeStory(params: {
  tweetId: string;
  username: string | null;
  tweetText: string;
  urlContexts: NormalizationUrlContext[];
}): Promise<NormalizedStory> {
  const config = getNormalizerConfig();
  const systemPrompt = buildNormalizationSystemPrompt();
  const userPrompt = buildNormalizationUserPrompt(params);

  const rawContent =
    config.provider === "openrouter"
      ? await callOpenRouter({
          model: config.model,
          systemPrompt,
          userPrompt,
        })
      : await callPortkey({
          model: config.model,
          systemPrompt,
          userPrompt,
        });

  const parsed = parseNormalizationPayload(rawContent);
  return {
    ...parsed,
    provider: config.provider,
    model: config.model,
  };
}
