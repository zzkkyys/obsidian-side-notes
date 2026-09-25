/** Bounded typo tolerance for context only, never for the selected quote itself. */
export function similarContext(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected.length < 8 || expected.length > 64 || actual.length > 64) return false;
  const limit = Math.floor(expected.length * .15);
  if (Math.abs(actual.length - expected.length) > limit) return false;
  let row = Array.from({ length: expected.length + 1 }, (_, i) => i);
  for (let i = 1; i <= actual.length; i++) {
    const next = [i];
    for (let j = 1; j <= expected.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (actual[i - 1] === expected[j - 1] ? 0 : 1));
    }
    if (Math.min(...next) > limit) return false;
    row = next;
  }
  return row[expected.length] <= limit;
}
