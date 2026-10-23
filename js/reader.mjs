/** Text segmentation and the single-timer RSVP reading engine. */
import { DEFAULT_PAUSES, normalizePauses } from './rhythm.mjs';

const graphemeSegmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const meaningfulCharacter = /[\p{L}\p{N}]/u;
const letterCharacter = /\p{L}/u;
const openingPunctuation = /^[\p{Ps}\p{Pi}«‹“„‘"']+$/u;
const closingPunctuation = /[\p{Pe}\p{Pf}»›”’"']+$/u;

function speedValue(value, fallback = 300) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1200, Math.max(100, numeric)) : fallback;
}

function startDelayValue(value, fallback = 0) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return [0, 1000, 2000].includes(numeric) ? numeric : fallback;
}

function position(value, length) {
  const numeric = Number(value);
  return length ? Math.min(length - 1, Math.max(0, Number.isFinite(numeric) ? Math.floor(numeric) : 0)) : 0;
}

/**
 * Center uses the left middle alphanumeric grapheme for an even count.
 * Optional 'left' is a display heuristic: one meaningful grapheme earlier when
 * the token contains at least five letters. Other mode values retain center.
 */
export function splitAnchor(text, mode = 'center') {
  const graphemes = Array.from(graphemeSegmenter.segment(String(text)), ({ segment }) => segment);
  const meaningful = [];
  let letters = 0;
  graphemes.forEach((grapheme, index) => {
    if (meaningfulCharacter.test(grapheme)) meaningful.push(index);
    if (letterCharacter.test(grapheme)) letters += 1;
  });
  const middle = Math.floor((meaningful.length - 1) / 2);
  const anchorPosition = middle - (mode === 'left' && letters >= 5 ? 1 : 0);
  const selected = meaningful.length
    ? meaningful[anchorPosition]
    : Math.max(0, Math.floor((graphemes.length - 1) / 2));
  return {
    prefix: graphemes.slice(0, selected).join(''),
    anchor: graphemes[selected] || '',
    suffix: graphemes.slice(selected + 1).join(''),
    letterCount: meaningful.length,
  };
}

function paragraphWords(text) {
  const parts = String(text).trim().split(/\s+/u).filter(Boolean);
  let lastMeaningfulIndex = parts.length - 1;
  while (lastMeaningfulIndex >= 0 && !meaningfulCharacter.test(parts[lastMeaningfulIndex])) {
    lastMeaningfulIndex -= 1;
  }
  const words = [];
  let prefix = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (meaningfulCharacter.test(part)) {
      words.push(prefix + part);
      prefix = '';
    } else if (openingPunctuation.test(part) && index < lastMeaningfulIndex) {
      prefix += part;
    } else if (words.length) {
      words[words.length - 1] += /^[—–-]$/u.test(part) ? ` ${part}` : part;
    } else {
      prefix += part;
    }
  }
  if (prefix && words.length) words[words.length - 1] += prefix;
  return words;
}

function pauseKinds(text, letterCount, paragraphEnd) {
  const unquoted = text.replace(closingPunctuation, '');
  const kinds = [];
  if (letterCount > 8) kinds.push('longWord');
  if (/[,;:]$/u.test(unquoted)) kinds.push('punctuation');
  if (/[.!?…]$/u.test(unquoted)) kinds.push('sentence');
  if (paragraphEnd) kinds.push('paragraph');
  return kinds;
}

function applyTokenPauses(tokens, pauses) {
  for (const token of tokens) {
    // Legacy callers may supply pre-calculated factors without tokenizer metadata.
    if (!Array.isArray(token.pauseKinds)) continue;
    token.factor = token.pauseKinds.reduce((factor, kind) => Math.max(factor, pauses[kind] || 1), 1);
  }
}

/** Recalculate timing in place without re-segmenting or replacing document tokens. */
export function applyPauseOptions(doc, input) {
  applyTokenPauses(doc.tokens, normalizePauses(input));
  const suffixUnits = new Array(doc.tokens.length + 1).fill(0);
  for (let index = doc.tokens.length - 1; index >= 0; index -= 1) {
    suffixUnits[index] = suffixUnits[index + 1] + doc.tokens[index].factor;
  }
  doc.suffixUnits = suffixUnits;
  return doc;
}

/** All ranges are half-open; suffixUnits includes a terminal zero at tokens.length. */
export function tokenizeChapters(sourceChapters = []) {
  const tokens = [];
  const paragraphs = [];
  const chapters = [];
  for (const sourceChapter of sourceChapters) {
    const chapterStart = tokens.length;
    const chapterIndex = chapters.length;
    for (const sourceParagraph of sourceChapter.paragraphs || []) {
      const text = String(sourceParagraph).trim().replace(/\s+/gu, ' ');
      const words = paragraphWords(text);
      if (!words.length) continue;
      const start = tokens.length;
      const paragraphIndex = paragraphs.length;
      words.forEach((word, wordIndex) => {
        const anchor = splitAnchor(word);
        tokens.push({
          text: word,
          ...anchor,
          paragraphIndex,
          chapterIndex,
          pauseKinds: pauseKinds(word, anchor.letterCount, wordIndex === words.length - 1),
          factor: 1,
        });
      });
      paragraphs.push({ text, start, end: tokens.length });
    }
    if (tokens.length > chapterStart) {
      chapters.push({ title: String(sourceChapter.title || `Глава ${chapterIndex + 1}`), start: chapterStart, end: tokens.length });
    }
  }
  return applyPauseOptions({ tokens, paragraphs, chapters, suffixUnits: [], totalWords: tokens.length }, DEFAULT_PAUSES);
}

/** Includes the current word; passing tokens.length returns zero. */
export function remainingMs(doc, index = 0, wpm = 300, smart = true) {
  const numeric = Number(index);
  const start = Math.min(doc.tokens.length, Math.max(0, Number.isFinite(numeric) ? Math.floor(numeric) : 0));
  const units = smart ? doc.suffixUnits[start] : doc.tokens.length - start;
  return units * 60000 / speedValue(wpm);
}

export class ReadingEngine {
  constructor({ tokens = [], wpm = 300, smart = true, pauses = DEFAULT_PAUSES, startDelay = 0, onUpdate = () => {},
    clock = performance.now.bind(performance),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = (handle) => globalThis.clearTimeout(handle) } = {}) {
    this.tokens = tokens;
    this.wpm = speedValue(wpm);
    this.smart = Boolean(smart);
    this.pauses = normalizePauses(pauses);
    applyTokenPauses(this.tokens, this.pauses);
    this.startDelay = startDelayValue(startDelay);
    this.index = 0;
    this.playing = false;
    this.preparing = false;
    this.finished = tokens.length === 0;
    this.onUpdate = onUpdate;
    this._clock = clock;
    this._schedule = schedule;
    this._cancel = cancel;
    this._timer = null;
    this._generation = 0;
    this._remainingFraction = 1;
    this._deadline = 0;
    this._fullDuration = 0;
    this._disposed = false;
  }

  _emit() {
    this.onUpdate({ index: this.index, playing: this.playing, finished: this.finished, preparing: this.preparing });
  }

  _clearTimer() {
    this._generation += 1;
    if (this._timer !== null) this._cancel(this._timer);
    this._timer = null;
  }

  _captureRemaining() {
    if (this.playing && !this.preparing && this._timer !== null && this._fullDuration > 0) {
      this._remainingFraction = Math.max(0, Math.min(1, (this._deadline - this._clock()) / this._fullDuration));
    }
  }

  _queue() {
    this._clearTimer();
    if (!this.playing || !this.tokens.length || this._disposed) return;
    const factor = this.smart ? this.tokens[this.index].factor || 1 : 1;
    this._fullDuration = 60000 / this.wpm * factor;
    const delay = this._fullDuration * this._remainingFraction;
    this._deadline = this._clock() + delay;
    const generation = this._generation;
    this._timer = this._schedule(() => {
      if (generation !== this._generation || !this.playing || this._disposed) return;
      this._timer = null;
      this._remainingFraction = 1;
      if (this.index >= this.tokens.length - 1) {
        this.playing = false;
        this.finished = true;
      } else {
        this.index += 1;
        // A delayed browser callback advances one word, never catches up by skipping.
        this._queue();
      }
      this._emit();
    }, Math.max(0, delay));
  }

  _queuePreparation() {
    this._clearTimer();
    this.preparing = true;
    this._remainingFraction = 1;
    this._fullDuration = 0;
    this._deadline = this._clock() + this.startDelay;
    const generation = this._generation;
    this._timer = this._schedule(() => {
      if (generation !== this._generation || !this.playing || this._disposed) return;
      this._timer = null;
      this.preparing = false;
      // Preparation does not consume any of the current word's display duration.
      this._queue();
      this._emit();
    }, this.startDelay);
  }

  replaceTokens(tokens, index = 0) {
    this._clearTimer();
    this.tokens = tokens || [];
    applyTokenPauses(this.tokens, this.pauses);
    this.index = position(index, this.tokens.length);
    this.playing = false;
    this.preparing = false;
    this.finished = this.tokens.length === 0;
    this._remainingFraction = 1;
    this._emit();
  }

  setSpeed(wpm) {
    const next = speedValue(wpm, this.wpm);
    if (next === this.wpm) return;
    this._captureRemaining();
    this.wpm = next;
    if (this.playing && !this.preparing) this._queue();
    this._emit();
  }

  setSmart(smart) {
    const next = Boolean(smart);
    if (next === this.smart) return;
    this._captureRemaining();
    this.smart = next;
    if (this.playing && !this.preparing) this._queue();
    this._emit();
  }

  setPauseOptions(pauses) {
    this._captureRemaining();
    this.pauses = normalizePauses(pauses);
    applyTokenPauses(this.tokens, this.pauses);
    if (this.playing && !this.preparing) this._queue();
    this._emit();
  }

  /** An in-flight preparation keeps its deadline; the new setting applies on play. */
  setStartDelay(milliseconds) {
    const next = startDelayValue(milliseconds, this.startDelay);
    if (next === this.startDelay) return;
    this.startDelay = next;
    this._emit();
  }

  play() {
    if (this._disposed || this.playing || !this.tokens.length) return;
    if (this.finished) {
      this.index = 0;
      this.finished = false;
      this._remainingFraction = 1;
    }
    this.playing = true;
    if (this.startDelay > 0) this._queuePreparation();
    else this._queue();
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    this._captureRemaining();
    this._clearTimer();
    this.playing = false;
    this.preparing = false;
    this._emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(index) {
    this._clearTimer();
    this.preparing = false;
    this.index = position(index, this.tokens.length);
    this.finished = this.tokens.length === 0;
    this._remainingFraction = 1;
    if (this.playing) this._queue();
    this._emit();
  }

  dispose() {
    this.pause();
    this._clearTimer();
    this._disposed = true;
    this.onUpdate = () => {};
  }
}
