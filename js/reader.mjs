/** Text segmentation and the single-timer RSVP reading engine. */
const graphemeSegmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const meaningfulCharacter = /[\p{L}\p{N}]/u;
const openingPunctuation = /^[\p{Ps}\p{Pi}«‹“„‘"']+$/u;
const closingPunctuation = /[\p{Pe}\p{Pf}»›”’"']+$/u;

function speedValue(value, fallback = 300) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1200, Math.max(100, numeric)) : fallback;
}

function position(value, length) {
  const numeric = Number(value);
  return length ? Math.min(length - 1, Math.max(0, Number.isFinite(numeric) ? Math.floor(numeric) : 0)) : 0;
}

/** The middle alphanumeric grapheme, choosing the left middle for an even count. */
export function splitAnchor(text) {
  const graphemes = Array.from(graphemeSegmenter.segment(String(text)), ({ segment }) => segment);
  const meaningful = [];
  graphemes.forEach((grapheme, index) => {
    if (meaningfulCharacter.test(grapheme)) meaningful.push(index);
  });
  const selected = meaningful.length
    ? meaningful[Math.floor((meaningful.length - 1) / 2)]
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

function pauseFactor(text, letterCount, paragraphEnd) {
  const unquoted = text.replace(closingPunctuation, '');
  return Math.max(
    letterCount > 8 ? 1.25 : 1,
    /[,;:]$/u.test(unquoted) ? 1.5 : 1,
    /[.!?…]$/u.test(unquoted) ? 2 : 1,
    paragraphEnd ? 2.5 : 1,
  );
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
          factor: pauseFactor(word, anchor.letterCount, wordIndex === words.length - 1),
        });
      });
      paragraphs.push({ text, start, end: tokens.length });
    }
    if (tokens.length > chapterStart) {
      chapters.push({ title: String(sourceChapter.title || `Глава ${chapterIndex + 1}`), start: chapterStart, end: tokens.length });
    }
  }
  const suffixUnits = new Array(tokens.length + 1).fill(0);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    suffixUnits[index] = suffixUnits[index + 1] + tokens[index].factor;
  }
  return { tokens, paragraphs, chapters, suffixUnits, totalWords: tokens.length };
}

/** Includes the current word; passing tokens.length returns zero. */
export function remainingMs(doc, index = 0, wpm = 300, smart = true) {
  const numeric = Number(index);
  const start = Math.min(doc.tokens.length, Math.max(0, Number.isFinite(numeric) ? Math.floor(numeric) : 0));
  const units = smart ? doc.suffixUnits[start] : doc.tokens.length - start;
  return units * 60000 / speedValue(wpm);
}

export class ReadingEngine {
  constructor({ tokens = [], wpm = 300, smart = true, onUpdate = () => {},
    clock = performance.now.bind(performance),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = (handle) => globalThis.clearTimeout(handle) } = {}) {
    this.tokens = tokens;
    this.wpm = speedValue(wpm);
    this.smart = Boolean(smart);
    this.index = 0;
    this.playing = false;
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
    this.onUpdate({ index: this.index, playing: this.playing, finished: this.finished });
  }

  _clearTimer() {
    this._generation += 1;
    if (this._timer !== null) this._cancel(this._timer);
    this._timer = null;
  }

  _captureRemaining() {
    if (this.playing && this._timer !== null && this._fullDuration > 0) {
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

  replaceTokens(tokens, index = 0) {
    this._clearTimer();
    this.tokens = tokens || [];
    this.index = position(index, this.tokens.length);
    this.playing = false;
    this.finished = this.tokens.length === 0;
    this._remainingFraction = 1;
    this._emit();
  }

  setSpeed(wpm) {
    const next = speedValue(wpm, this.wpm);
    if (next === this.wpm) return;
    this._captureRemaining();
    this.wpm = next;
    if (this.playing) this._queue();
    this._emit();
  }

  setSmart(smart) {
    const next = Boolean(smart);
    if (next === this.smart) return;
    this._captureRemaining();
    this.smart = next;
    if (this.playing) this._queue();
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
    this._queue();
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    this._captureRemaining();
    this._clearTimer();
    this.playing = false;
    this._emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(index) {
    this._clearTimer();
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
