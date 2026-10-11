export const DIFFICULTIES = ["trivial", "easy", "moderate", "hard", "extreme"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const OUTCOMES = ["success", "success_at_cost", "failure", "failure_with_complication"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const DC: Record<Difficulty, number> = { trivial: 0, easy: 6, moderate: 10, hard: 14, extreme: 18 };

export interface Resolution {
  outcome: Outcome;
  roll: number;
  total: number;
  dc: number;
}

/**
 * d20 + 2 × (capability tier − opposition tier) against the difficulty's DC.
 * Opposition defaults to an ordinary person (tier 3).
 */
export function resolveCheck(
  difficulty: Difficulty,
  tier: number,
  opposition = 3,
  rng: () => number = Math.random,
): Resolution {
  const roll = 1 + Math.floor(rng() * 20);
  const dc = DC[difficulty];
  const total = roll + 2 * (tier - opposition);
  if (difficulty === "trivial") return { outcome: "success", roll, total, dc };
  const margin = total - dc;
  const outcome: Outcome =
    roll === 20 || margin >= 4 ? "success" : margin >= 0 ? "success_at_cost" : margin >= -5 && roll !== 1 ? "failure" : "failure_with_complication";
  return { outcome, roll, total, dc };
}
