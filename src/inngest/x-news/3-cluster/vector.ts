function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function parseVector(value: unknown): number[] | null {
  if (!value) return null;

  const coerceArray = (input: unknown): number[] | null => {
    if (!Array.isArray(input)) return null;
    const parsed = input
      .map((item) => toFiniteNumber(item))
      .filter((item): item is number => item !== null);
    return parsed.length > 0 ? parsed : null;
  };

  const fromArray = coerceArray(value);
  if (fromArray) return fromArray;

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const fromJson = coerceArray(parsed);
    if (fromJson) return fromJson;
  } catch {
    // Fall through and try bracket parsing.
  }

  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return null;

  const values = inner
    .split(",")
    .map((part) => Number.parseFloat(part.trim()))
    .filter((part) => Number.isFinite(part));

  return values.length > 0 ? values : null;
}

export function stringifyVector(vector: number[] | null): string | null {
  if (!vector || vector.length === 0) return null;
  return JSON.stringify(vector);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function weightedAverageVector(params: {
  base: number[] | null;
  baseWeight: number;
  incoming: number[] | null;
  incomingWeight: number;
}): number[] | null {
  const { base, baseWeight, incoming, incomingWeight } = params;
  if (!incoming || incoming.length === 0) return base;
  if (!base || base.length === 0) return incoming;
  if (base.length !== incoming.length) return incoming;

  const safeBaseWeight = Number.isFinite(baseWeight) && baseWeight > 0 ? baseWeight : 0;
  const safeIncomingWeight =
    Number.isFinite(incomingWeight) && incomingWeight > 0 ? incomingWeight : 0;
  const denominator = safeBaseWeight + safeIncomingWeight;
  if (denominator <= 0) return incoming;

  const averaged = new Array<number>(base.length);
  for (let i = 0; i < base.length; i += 1) {
    averaged[i] =
      (base[i] * safeBaseWeight + incoming[i] * safeIncomingWeight) / denominator;
  }
  return averaged;
}
