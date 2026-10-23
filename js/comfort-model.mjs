/** A subjective tempo trial, not a validated measure of reading ability. */
export const START_SPEED = 150;
export const SPEED_STEP = 25;
export const WORDS_PER_STEP = 12;
export const MIN_SPEED = 100;
export const MAX_SPEED = 1200;
export const VERIFY_WORDS = 24;

/** UI callers pass numbers; malformed values start from the introductory pace. */
export function clampComfortSpeed(value) {
  return Number.isFinite(value) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) : START_SPEED;
}

/** Count completed new words only. Re-emitting or pausing a word adds no progress. */
export function rampSpeed(completedWords) {
  const completed = Number.isFinite(completedWords) ? Math.max(0, Math.floor(completedWords)) : 0;
  return Math.min(MAX_SPEED, START_SPEED + Math.floor(completed / WORDS_PER_STEP) * SPEED_STEP);
}

/** User feedback chooses one step below the current ramp pace, never below 100. */
export function candidateSpeed(current) {
  return Math.max(MIN_SPEED, clampComfortSpeed(current) - SPEED_STEP);
}
