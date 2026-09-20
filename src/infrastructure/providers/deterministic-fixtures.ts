/**
 * Deterministic string hash + PRNG used by dev-mock provider adapters
 * (Prompt 2 §2.15 — a fully mocked/local environment must still produce
 * *stable, reasonable* synthetic data, not pure randomness that makes tests
 * flaky or demos meaningless).
 */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG seeded from a hash — deterministic, fast, good enough for synthetic fixtures. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
