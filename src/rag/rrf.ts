/**
 * Reciprocal Rank Fusion: score(d) = Σ_lists 1 / (k + rank_list(d)), rank starting at 1.
 * k = 60 is the value from the original paper (Cormack et al., 2009) and works well untuned.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return; // count each id once per list, at its best rank
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
