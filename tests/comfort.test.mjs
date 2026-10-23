import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_SPEED, SPEED_STEP, WORDS_PER_STEP, MIN_SPEED, MAX_SPEED, VERIFY_WORDS,
  clampComfortSpeed, rampSpeed, candidateSpeed,
} from '../js/comfort-model.mjs';

test('comfort trial uses the agreed introductory pace, step and verification length', () => {
  assert.deepEqual([START_SPEED, SPEED_STEP, WORDS_PER_STEP, MIN_SPEED, MAX_SPEED, VERIFY_WORDS], [150, 25, 12, 100, 1200, 24]);
});

test('the pace changes only after each complete group of twelve new words', () => {
  for (const [completed, expected] of [[0, 150], [1, 150], [11, 150], [11.99, 150], [12, 175], [13, 175], [23, 175], [24, 200]]) {
    assert.equal(rampSpeed(completed), expected, `${completed} completed words`);
  }
});

test('the ramp reaches its cap without overflow and rejects invalid completion counts', () => {
  assert.equal(rampSpeed(503), 1175);
  assert.equal(rampSpeed(504), 1200);
  assert.equal(rampSpeed(1000000), 1200);
  assert.equal(rampSpeed(Number.MAX_VALUE), 1200);
  for (const value of [-20, -0.5, undefined, null, NaN, Infinity, -Infinity, '', '12', false, {}, []]) {
    assert.equal(rampSpeed(value), START_SPEED);
  }
});

test('candidate feedback steps back once and candidate adjustments remain within bounds', () => {
  assert.equal(candidateSpeed(150), 125);
  assert.equal(candidateSpeed(175), 150);
  assert.equal(candidateSpeed(1200), 1175);
  assert.equal(candidateSpeed(100), 100);
  assert.equal(candidateSpeed(50), 100);
  assert.equal(candidateSpeed(1500), 1175);
  assert.equal(clampComfortSpeed(100 - SPEED_STEP), 100);
  assert.equal(clampComfortSpeed(1200 + SPEED_STEP), 1200);
  assert.equal(clampComfortSpeed(400 - SPEED_STEP), 375);
  assert.equal(clampComfortSpeed(400 + SPEED_STEP), 425);
});

test('candidate normalization preserves valid numeric choices and defaults malformed input', () => {
  for (const value of [100, 125, 150, 450, 1200]) assert.equal(clampComfortSpeed(value), value);
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '', '150', false, true, {}, []]) {
    assert.equal(clampComfortSpeed(value), START_SPEED);
    assert.equal(candidateSpeed(value), START_SPEED - SPEED_STEP);
  }
  // Reaching the ramp cap or finishing the passage uses the current pace directly.
  assert.equal(clampComfortSpeed(rampSpeed(504)), MAX_SPEED);
  assert.equal(clampComfortSpeed(rampSpeed(36)), 225);
});
