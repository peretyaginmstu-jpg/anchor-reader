import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAUSES, RHYTHM_PRESETS, normalizePauses, profileForPauses } from '../js/rhythm.mjs';

test('rhythm presets expose the agreed multipliers and identify their own profile', () => {
  assert.deepEqual(DEFAULT_PAUSES, { longWord: 1.25, punctuation: 1.5, sentence: 2, paragraph: 2.5 });
  assert.deepEqual(RHYTHM_PRESETS.map(({ id, label }) => [id, label]),
    [['light', 'Лёгкий'], ['balanced', 'Баланс'], ['calm', 'Спокойный']]);
  for (const preset of RHYTHM_PRESETS) assert.equal(profileForPauses(preset.pauses), preset.id);
  assert.equal(profileForPauses({ paragraph: 3 }), 'custom');
  assert.equal(profileForPauses(undefined), 'balanced');
});

test('pause normalization clamps finite numbers and accepts numeric input strings', () => {
  assert.deepEqual(normalizePauses({ longWord: -10, punctuation: 100, sentence: '2.75', paragraph: 1 }),
    { longWord: 1, punctuation: 4, sentence: 2.75, paragraph: 1 });
});

test('pause normalization falls back per field for malformed or missing values', () => {
  for (const value of [undefined, null, [], 'invalid', 2]) assert.deepEqual(normalizePauses(value), DEFAULT_PAUSES);
  for (const value of [undefined, null, '', ' ', 'abc', false, true, Infinity, -Infinity, NaN, {}, []]) {
    assert.deepEqual(normalizePauses({ longWord: value, punctuation: value, sentence: value, paragraph: value }), DEFAULT_PAUSES);
  }
  assert.deepEqual(normalizePauses({ sentence: 3, ignored: 4 }), { ...DEFAULT_PAUSES, sentence: 3 });
});

test('normalization returns independent settings and cannot modify preset constants', () => {
  const normalized = normalizePauses(DEFAULT_PAUSES);
  normalized.paragraph = 4;
  assert.equal(DEFAULT_PAUSES.paragraph, 2.5);
  assert.equal(RHYTHM_PRESETS[1].pauses.paragraph, 2.5);
  assert.notEqual(normalizePauses(normalized), normalized);
});
