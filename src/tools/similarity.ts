/** Title similarity for duplicate detection (ADR 0010). Deliberately simple: normalized token Jaccard. */

const STOPWORDS = new Set(["a", "an", "the", "to", "of", "and", "for", "in", "on", "at"]);

export function normalize(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

export function similarity(a: string, b: string): number {
  const ta = new Set(normalize(a));
  const tb = new Set(normalize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
