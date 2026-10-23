/** Word-duration multipliers shared by the reader and its settings. */
export const DEFAULT_PAUSES = Object.freeze({
  longWord: 1.25,
  punctuation: 1.5,
  sentence: 2,
  paragraph: 2.5,
});

export const RHYTHM_PRESETS = Object.freeze([
  Object.freeze({ id: 'light', label: 'Лёгкий', pauses: Object.freeze({ longWord: 1.1, punctuation: 1.25, sentence: 1.5, paragraph: 1.75 }) }),
  Object.freeze({ id: 'balanced', label: 'Баланс', pauses: DEFAULT_PAUSES }),
  Object.freeze({ id: 'calm', label: 'Спокойный', pauses: Object.freeze({ longWord: 1.5, punctuation: 1.75, sentence: 2.5, paragraph: 3.5 }) }),
]);

/** Return independent, finite multipliers; invalid or omitted fields use defaults. */
export function normalizePauses(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(Object.entries(DEFAULT_PAUSES).map(([key, fallback]) => {
    const value = source[key];
    const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return [key, Number.isFinite(numeric) ? Math.min(4, Math.max(1, numeric)) : fallback];
  }));
}

/** Return a preset id, or 'custom' when the normalized multipliers differ. */
export function profileForPauses(input) {
  const pauses = normalizePauses(input);
  return RHYTHM_PRESETS.find((preset) => Object.keys(DEFAULT_PAUSES).every((key) => preset.pauses[key] === pauses[key]))?.id || 'custom';
}
