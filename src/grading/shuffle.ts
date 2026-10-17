import { createHash } from 'node:crypto';

/** Deterministic PRNG (mulberry32) seeded from a string. */
function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable per-attempt shuffle: the same attempt always sees the same order
 * (so refreshing does not reorder questions), different attempts differ.
 */
export function seededShuffle<T>(list: readonly T[], seed: string): T[] {
  const result = [...list];
  const random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Shuffle that avoids returning the original order when possible (for ordering questions). */
export function seededDerange<T>(list: readonly T[], seed: string): T[] {
  if (list.length < 2) return [...list];
  for (let i = 0; i < 5; i++) {
    const shuffled = seededShuffle(list, `${seed}:${i}`);
    if (shuffled.some((item, idx) => item !== list[idx])) return shuffled;
  }
  return [...list.slice(1), list[0]!];
}
