import { v, type Infer } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────
// Scorecards (W2 — multi-round review). A round carries its own ordered list
// of criteria; a review stores one answer per criterion in `answers`, keyed
// by the criterion id. Three kinds cover the evaluation vocabulary:
//   numeric  — integer rating on [min, max], optionally weighted
//   dropdown — one of `options`
//   text     — free text (never aggregated)
// The shape lives in shared/ because the web builder, the reviewer UI and the
// backend all validate against the same definition (like formDef).
// ─────────────────────────────────────────────────────────────────────────

export const vScorecardField = v.object({
  id: v.string(),
  label: v.string(),
  kind: v.union(v.literal("numeric"), v.literal("dropdown"), v.literal("text")),
  required: v.optional(v.boolean()),
  /** numeric only; defaults 1..5. */
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  /** numeric only; relative weight in the aggregate. Defaults to 1. */
  weight: v.optional(v.number()),
  /** dropdown only. */
  options: v.optional(v.array(v.string())),
});
export type ScorecardField = Infer<typeof vScorecardField>;

export const vScorecard = v.array(vScorecardField);

export const vReviewAnswers = v.record(
  v.string(),
  v.union(v.number(), v.string()),
);
export type ReviewAnswers = Infer<typeof vReviewAnswers>;

export const MAX_SCORECARD_FIELDS = 20;
export const MAX_TEXT_ANSWER = 5000;

export function numericRange(field: ScorecardField): { min: number; max: number } {
  return { min: field.min ?? 1, max: field.max ?? 5 };
}

export function fieldWeight(field: ScorecardField): number {
  const weight = field.weight ?? 1;
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/** Validation error text for one answer against its criterion; null = ok. */
export function answerProblem(
  field: ScorecardField,
  value: number | string | undefined,
): string | null {
  if (value === undefined || value === "") {
    return field.required === true ? `"${field.label}" is required.` : null;
  }
  if (field.kind === "numeric") {
    const { min, max } = numericRange(field);
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      return `"${field.label}" must be a whole number from ${min} to ${max}.`;
    }
    return null;
  }
  if (field.kind === "dropdown") {
    if (typeof value !== "string" || !(field.options ?? []).includes(value)) {
      return `"${field.label}" must be one of its listed options.`;
    }
    return null;
  }
  if (typeof value !== "string" || value.length > MAX_TEXT_ANSWER) {
    return `"${field.label}" must be text of at most ${MAX_TEXT_ANSWER} characters.`;
  }
  return null;
}

/** Weighted mean over the numeric criteria answered in a single review;
 * null when nothing numeric was answered. */
export function reviewWeightedScore(
  scorecard: ScorecardField[],
  answers: ReviewAnswers,
): number | null {
  let sum = 0;
  let weights = 0;
  for (const field of scorecard) {
    if (field.kind !== "numeric") continue;
    const value = answers[field.id];
    if (typeof value !== "number") continue;
    const w = fieldWeight(field);
    sum += value * w;
    weights += w;
  }
  return weights === 0 ? null : sum / weights;
}

/** Map a dropdown answer to the decision vocabulary when the round uses a
 * recommendation-style dropdown (Accept/Maybe/Reject or similar). */
export function recommendationFromAnswers(
  scorecard: ScorecardField[],
  answers: ReviewAnswers,
): "accept" | "decline" | "neutral" | undefined {
  for (const field of scorecard) {
    if (field.kind !== "dropdown") continue;
    const value = answers[field.id];
    if (typeof value !== "string") continue;
    const lower = value.trim().toLowerCase();
    if (/^(accept|yes|strong accept)/.test(lower)) return "accept";
    if (/^(reject|decline|no)/.test(lower)) return "decline";
    if (/^(maybe|neutral|borderline|weak)/.test(lower)) return "neutral";
  }
  return undefined;
}

/** The scorecard the pre-W2 fixed review UI was hard-coding, used both as
 * the default for new events' first round and as the lens legacy reviews
 * (score/recommendation/comments columns) are read through. */
export function legacyScorecard(): ScorecardField[] {
  return [
    {
      id: "score",
      label: "Score",
      kind: "numeric",
      min: 1,
      max: 5,
      weight: 1,
      required: true,
    },
    {
      id: "recommendation",
      label: "Recommendation",
      kind: "dropdown",
      options: ["Accept", "Maybe", "Reject"],
      required: true,
    },
    { id: "comments", label: "Comments", kind: "text" },
  ];
}

const LEGACY_RECOMMENDATION_LABEL = {
  accept: "Accept",
  neutral: "Maybe",
  decline: "Reject",
} as const;

/** Answers view of a review row that predates scorecards. */
export function legacyAnswers(review: {
  score?: number;
  recommendation?: "accept" | "decline" | "neutral";
  comments?: string;
}): ReviewAnswers {
  const answers: ReviewAnswers = {};
  if (typeof review.score === "number") answers.score = review.score;
  if (review.recommendation !== undefined) {
    answers.recommendation = LEGACY_RECOMMENDATION_LABEL[review.recommendation];
  }
  if (review.comments !== undefined) answers.comments = review.comments;
  return answers;
}
