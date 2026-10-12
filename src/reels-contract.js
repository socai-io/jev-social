// Creator Lab vocabulary; see docs/creator-lab-license.txt.
export const REELS_SCHEMA_VERSION = 1;
export const MAX_REELS_BYTES = 10_000_000;
export const REVIEW_THRESHOLD = 0.65;
export const LABEL_VALUES = {
  topic: ["business", "money", "marketing", "mindset", "habits", "relationships", "health", "technology", "other", "unclear"],
  opening: ["question", "instruction", "claim", "story", "dialogue", "unclear"],
  mechanism: ["contradiction", "curiosity", "result", "mistake", "recognition", "story", "direct", "unclear"],
  structure: ["story", "steps", "problem_solution", "explanation", "comparison", "opinion", "qa", "unclear"],
  evidence: ["example", "personal", "numbers", "source", "reasoning", "none", "unclear"],
  emotion: ["aspiration", "concern", "relief", "surprise", "amusement", "neutral", "unclear"],
  specificity: ["none", "principle", "action", "sequence", "unclear"],
  cta: ["none", "follow", "engage", "comment", "visit", "buy", "multiple", "unclear"],
};
export const SCRIPT_ROLES = ["hook", "setup", "problem", "example", "advice", "payoff", "cta", "other", "unclear"];
export const SOURCE_STATES = ["complete", "partial", "paused", "interrupted", "failed", "ready", "running", "scraping", "unknown"];
export const knownMetric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function filterReels(posts, { topic = "all", mechanism = "all", structure = "all", review = "all", minConfidence = 0, dimension = "mechanism" } = {}) {
  if (!knownMetric(minConfidence) || minConfidence > 1 || !Object.hasOwn(LABEL_VALUES, dimension)) throw new Error("Invalid classification filter.");
  if (!["all", "review", "classified", "unclassified", "excluded", "error"].includes(review)) throw new Error("Invalid review filter.");
  const selected = { topic, mechanism, structure };
  for (const [key, value] of Object.entries(selected)) {
    if (value !== "all" && !LABEL_VALUES[key].includes(value)) throw new Error("Invalid classification filter.");
  }
  const dimensions = new Set([dimension, ...Object.keys(selected).filter((key) => selected[key] !== "all")]);
  return posts.filter((post) => {
    if (review === "review" && !post.needsReview) return false;
    if (review !== "all" && review !== "review" && post.status !== review) return false;
    if (Object.entries(selected).some(([key, value]) => value !== "all" && post.analysis?.labels[key]?.value !== value)) return false;
    return !minConfidence || [...dimensions].every((key) => post.analysis?.labels[key]?.confidence >= minConfidence);
  });
}
