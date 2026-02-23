import { GoogleGenAI } from "@google/genai";

export type ClusterSimilarityMode = "lexical" | "embedding";

const DEFAULT_EMBED_MODEL = "gemini-embedding-001";
const DEFAULT_EMBED_TASK_TYPE = "CLUSTERING";
const DEFAULT_EMBED_DIMENSIONS = 1536;

let cachedGeminiClient: GoogleGenAI | null = null;

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY for embedding mode");
  }

  if (!cachedGeminiClient) {
    cachedGeminiClient = new GoogleGenAI({ apiKey });
  }

  return cachedGeminiClient;
}

export function getClusterSimilarityMode(input: string | undefined): ClusterSimilarityMode {
  return input === "embedding" ? "embedding" : "lexical";
}

export function getEmbeddingModel(): string {
  const model = process.env.X_NEWS_EMBED_MODEL?.trim();
  return model || DEFAULT_EMBED_MODEL;
}

export function getEmbeddingTaskType(): string {
  const taskType = process.env.X_NEWS_EMBED_TASK_TYPE?.trim();
  return taskType || DEFAULT_EMBED_TASK_TYPE;
}

export function getEmbeddingDimensions(): number {
  return parsePositiveInt(process.env.X_NEWS_EMBED_DIMENSIONS, DEFAULT_EMBED_DIMENSIONS);
}

export async function embedTextForClustering(text: string): Promise<number[]> {
  const cleaned = text.trim();
  if (!cleaned) {
    throw new Error("Cannot embed empty text");
  }

  const client = getGeminiClient();
  const model = getEmbeddingModel();
  const taskType = getEmbeddingTaskType();
  const outputDimensionality = getEmbeddingDimensions();

  const response = await client.models.embedContent({
    model,
    contents: cleaned,
    config: {
      taskType,
      outputDimensionality,
    },
  });

  const values = response.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Embedding response missing vector values");
  }

  return values;
}
