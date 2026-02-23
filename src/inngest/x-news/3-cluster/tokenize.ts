const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

export type ClusterTextMode = "headline_only" | "headline_and_facts";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function getClusterTextMode(input: string | undefined): ClusterTextMode {
  return input === "headline_and_facts" ? "headline_and_facts" : "headline_only";
}

export function parseNormalizedFacts(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [input]
      : input && typeof input === "object" && Array.isArray((input as { facts?: unknown }).facts)
        ? (input as { facts: unknown[] }).facts
        : [];

  const deduped = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const fact = compactWhitespace(value);
    if (!fact) continue;
    deduped.add(fact);
  }

  return [...deduped].slice(0, 20);
}

export function buildCanonicalText(
  headline: string | null | undefined,
  facts: string[],
  mode: ClusterTextMode = "headline_only"
): string {
  const cleanedHeadline = compactWhitespace(headline ?? "");
  if (mode === "headline_only") {
    return cleanedHeadline;
  }

  const parts = [cleanedHeadline, ...facts]
    .map((part) => compactWhitespace(part))
    .filter(Boolean);
  return parts.join("\n");
}

function isNumericToken(token: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(token);
}

export function tokenizeCanonicalText(text: string, maxTokens = 240): string[] {
  if (!text.trim()) return [];

  const matches = text.toLowerCase().match(/[a-z0-9$][a-z0-9$._-]*/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const token of matches) {
    const cleaned = token.replace(/^[._-]+|[._-]+$/g, "");
    if (!cleaned) continue;

    const isTicker = cleaned.startsWith("$") && cleaned.length > 1;
    const numeric = isNumericToken(cleaned);
    if (!isTicker && !numeric && cleaned.length < 3) continue;
    if (!isTicker && STOPWORDS.has(cleaned)) continue;
    if (seen.has(cleaned)) continue;

    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= maxTokens) break;
  }

  return out;
}

export function parseTokenSet(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((token): token is string => typeof token === "string");
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((token): token is string => typeof token === "string");
      }
    } catch {
      return [];
    }
  }

  return [];
}

export function mergeTokenSets(a: string[], b: string[], maxTokens = 260): string[] {
  const merged = new Set<string>();
  for (const token of a) {
    if (merged.size >= maxTokens) break;
    merged.add(token);
  }
  for (const token of b) {
    if (merged.size >= maxTokens) break;
    merged.add(token);
  }
  return [...merged];
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}
