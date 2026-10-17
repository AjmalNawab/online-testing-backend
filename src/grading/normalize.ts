/**
 * Normalisation for short typed answers (fill in the blank).
 *
 * Ignored: letter case (unless case-sensitive), extra whitespace, typographic
 * quotes/apostrophes/dashes, one pair of wrapping quotes, trailing sentence
 * punctuation. Everything else — spelling, internal punctuation, word order,
 * digits — still counts, so genuinely different answers are not equivalent.
 */
export function normalizeAnswerText(value: string, options: { caseSensitive?: boolean } = {}): string {
  let text = value
    .normalize('NFKC')
    .replace(/[‘’‛ʼ′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const wrapped = /^(["'])(.*)\1$/.exec(text);
  if (wrapped) text = wrapped[2]!.trim();

  text = text.replace(/[.!?,;:۔؟]+$/u, '').trim();

  return options.caseSensitive ? text : text.toLocaleLowerCase();
}

export function textAnswerMatches(answer: string, accepted: readonly string[], caseSensitive = false): boolean {
  const normalized = normalizeAnswerText(answer, { caseSensitive });
  if (!normalized) return false;
  return accepted.some((a) => normalizeAnswerText(a, { caseSensitive }) === normalized);
}
