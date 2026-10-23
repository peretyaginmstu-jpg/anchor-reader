import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAnchor, tokenizeChapters, applyPauseOptions, remainingMs, ReadingEngine } from '../js/reader.mjs';

function timerHarness() {
  let time = 0;
  let nextId = 0;
  const jobs = new Map();
  const earliest = () => [...jobs.entries()].sort((left, right) => left[1].due - right[1].due)[0];
  return {
    clock: () => time,
    schedule: (callback, delay) => {
      const id = nextId++;
      jobs.set(id, { callback, due: time + delay });
      return id;
    },
    cancel: (id) => jobs.delete(id),
    advance: (milliseconds) => {
      const target = time + milliseconds;
      let job = earliest();
      while (job && job[1].due <= target) {
        time = job[1].due;
        jobs.delete(job[0]);
        job[1].callback();
        job = earliest();
      }
      time = target;
    },
    delayBrowser: (milliseconds) => { time += milliseconds; },
    fireOverdue: () => {
      for (const [id, job] of [...jobs.entries()]) {
        if (job.due <= time && jobs.has(id)) {
          jobs.delete(id);
          job.callback();
        }
      }
    },
    get pending() { return jobs.size; },
  };
}

const plainTokens = (count) => Array.from({ length: count }, (_, index) => ({ text: String(index), factor: 1 }));

test('anchors use the left middle alphanumeric grapheme without losing punctuation', () => {
  for (const [word, prefix, anchor, suffix, letterCount] of [
    ['книга', 'кн', 'и', 'га', 5],
    ['мама', 'м', 'а', 'ма', 4],
    ['«книга!»', '«кн', 'и', 'га!»', 5],
    ['read', 'r', 'e', 'ad', 4],
    ['12,345', '12,', '3', '45', 5],
    ['кто-то', 'кт', 'о', '-то', 5],
    ['сло́во', 'сл', 'о́', 'во', 5],
    ['🙂мама', '🙂м', 'а', 'ма', 4],
    ['я', '', 'я', '', 1],
    ['', '', '', '', 0],
  ]) {
    assert.deepEqual(splitAnchor(word), { prefix, anchor, suffix, letterCount }, word);
  }
});

test('tokenization preserves order and half-open ranges, omitting empty chapters', () => {
  const doc = tokenizeChapters([
    { title: 'Пустая', paragraphs: ['… —'] },
    { title: 'Первая', paragraphs: [' « Привет , мир ! » ', 'Ещё один абзац.'] },
    { title: 'Вторая', paragraphs: ['Последнее слово'] },
  ]);
  assert.deepEqual(doc.tokens.map(({ text }) => text), ['«Привет,', 'мир!»', 'Ещё', 'один', 'абзац.', 'Последнее', 'слово']);
  assert.deepEqual(doc.chapters, [{ title: 'Первая', start: 0, end: 5 }, { title: 'Вторая', start: 5, end: 7 }]);
  assert.deepEqual(doc.paragraphs.map(({ start, end }) => [start, end]), [[0, 2], [2, 5], [5, 7]]);
  assert.deepEqual(doc.tokens.map(({ paragraphIndex, chapterIndex }) => [paragraphIndex, chapterIndex]),
    [[0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [2, 1], [2, 1]]);
  assert.equal(doc.totalWords, 7);
});

test('smart pauses choose the maximum and recognize punctuation inside closing quotes', () => {
  const doc = tokenizeChapters([{ title: 'Тест', paragraphs: ['коротко длинноеслово ещё, «хватит!» точка. конец'] }]);
  assert.deepEqual(doc.tokens.map(({ factor }) => factor), [1, 1.25, 1.5, 2, 2, 2.5]);
  assert.deepEqual(doc.suffixUnits, [10.25, 9.25, 8, 6.5, 4.5, 2.5, 0]);
  assert.equal(remainingMs(doc, 0, 300, true), 2050);
  assert.equal(remainingMs(doc, 2, 600, true), 800);
  assert.equal(remainingMs(doc, 2, 300, false), 800);
  assert.equal(remainingMs(doc, 6, 300, true), 0);
  assert.equal(remainingMs(doc, 100, 300, false), 0);
});

test('standalone dashes keep a separating space without moving the anchor', () => {
  const original = splitAnchor('Внимание');
  for (const dash of ['—', '–', '-']) {
    const doc = tokenizeChapters([{ title: 'Тире', paragraphs: [`Внимание ${dash} это`] }]);
    assert.deepEqual(doc.tokens.map(({ text }) => text), [`Внимание ${dash}`, 'это']);
    assert.deepEqual(splitAnchor(doc.tokens[0].text), {
      ...original,
      suffix: `${original.suffix} ${dash}`,
    });
  }
});

test('a large paragraph with many standalone quotation marks retains every word in order', () => {
  const wordCount = 10000;
  const text = Array.from({ length: wordCount }, (_, index) => `« слово${index} »`).join(' ');
  const doc = tokenizeChapters([{ title: 'Длинный абзац', paragraphs: [text] }]);
  assert.equal(doc.totalWords, wordCount);
  assert.equal(doc.tokens[0].text, '«слово0»');
  assert.equal(doc.tokens[wordCount - 1].text, `«слово${wordCount - 1}»`);
  assert.ok(doc.tokens.every((token, index) => token.text === `«слово${index}»`));
});

test('empty documents and punctuation-only paragraphs have no words', () => {
  assert.deepEqual(tokenizeChapters([{ title: 'Empty', paragraphs: ['', '  ', '… — !'] }]),
    { tokens: [], paragraphs: [], chapters: [], suffixUnits: [0], totalWords: 0 });
});

test('engine displays every word for its duration and finishes only after the last word', () => {
  const timer = timerHarness();
  const updates = [];
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), onUpdate: (state) => updates.push(state) });
  engine.play();
  engine.play();
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  timer.advance(200);
  assert.equal(engine.index, 2);
  assert.equal(engine.finished, false);
  timer.advance(200);
  assert.deepEqual(updates.at(-1), { index: 2, playing: false, finished: true, preparing: false });
  assert.equal(timer.pending, 0);
  engine.play();
  assert.equal(engine.index, 0);
  assert.equal(engine.finished, false);
  engine.dispose();
  assert.equal(timer.pending, 0);
});

test('default timers retain the global receiver required by browser host functions', () => {
  const timer = timerHarness();
  const originalSchedule = globalThis.setTimeout;
  const originalCancel = globalThis.clearTimeout;
  let scheduled = 0;
  let cancelled = 0;
  globalThis.setTimeout = function (callback, delay) {
    assert.equal(this, globalThis, 'setTimeout must be called on the global object');
    scheduled += 1;
    return timer.schedule(callback, delay);
  };
  globalThis.clearTimeout = function (handle) {
    assert.equal(this, globalThis, 'clearTimeout must be called on the global object');
    cancelled += 1;
    return timer.cancel(handle);
  };
  try {
    const engine = new ReadingEngine({ tokens: plainTokens(3), clock: timer.clock });
    engine.play();
    assert.equal(timer.pending, 1);
    timer.advance(200);
    assert.equal(engine.index, 1);
    engine.pause();
    assert.equal(timer.pending, 0);
    assert.equal(scheduled, 2);
    assert.equal(cancelled, 1);
    engine.dispose();
  } finally {
    globalThis.setTimeout = originalSchedule;
    globalThis.clearTimeout = originalCancel;
  }
});

test('pause retains the remaining fraction and does not advance in the background', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3) });
  engine.play();
  timer.advance(75);
  engine.pause();
  assert.equal(timer.pending, 0);
  timer.advance(10000);
  assert.equal(engine.index, 0);
  engine.play();
  timer.advance(124);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
});

test('changing speed preserves elapsed proportion, including while paused', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3) });
  engine.play();
  timer.advance(50);
  engine.setSpeed(600);
  assert.equal(timer.pending, 1);
  timer.advance(74);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  timer.advance(50);
  engine.pause();
  engine.setSpeed(300);
  engine.play();
  timer.advance(99);
  assert.equal(engine.index, 1);
  timer.advance(1);
  assert.equal(engine.index, 2);
});

test('smart pause toggles preserve elapsed proportion and apply at the next words', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: [{ factor: 2 }, { factor: 2.5 }] });
  engine.play();
  timer.advance(100);
  engine.setSmart(false);
  assert.equal(timer.pending, 1);
  timer.advance(149);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  timer.advance(200);
  assert.equal(engine.finished, true);
});

test('a late callback advances one word, without skipping or burst catch-up', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(10) });
  engine.play();
  timer.delayBrowser(5000);
  timer.fireOverdue();
  assert.equal(engine.index, 1);
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 1);
  timer.advance(1);
  assert.equal(engine.index, 2);
});

test('seeking and replacing cancel old timers and start from a whole word duration', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(5) });
  engine.play();
  timer.advance(150);
  engine.seek(3);
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 3);
  timer.advance(1);
  assert.equal(engine.index, 4);
  engine.replaceTokens(plainTokens(2), 100);
  assert.equal(engine.index, 1);
  assert.equal(engine.playing, false);
  assert.equal(timer.pending, 0);
  engine.seek(-100);
  assert.equal(engine.index, 0);
  engine.play();
  engine.replaceTokens([]);
  assert.equal(engine.finished, true);
  assert.equal(engine.playing, false);
  assert.equal(timer.pending, 0);
  engine.play();
  assert.equal(timer.pending, 0);
});

test('listener mutations cannot leave duplicate scheduled callbacks', () => {
  const timer = timerHarness();
  let engine;
  engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), onUpdate: ({ index, playing }) => {
    if (index === 1 && playing) engine.pause();
  } });
  engine.play();
  timer.advance(200);
  assert.equal(engine.index, 1);
  assert.equal(engine.playing, false);
  assert.equal(timer.pending, 0);
});

test('pause options recalculate factors and suffix units without replacing document content', () => {
  const doc = tokenizeChapters([{ title: 'Ритм', paragraphs: ['коротко длинноеслово ещё, «хватит!» точка. конец'] }]);
  const tokens = doc.tokens;
  const paragraphs = doc.paragraphs;
  const firstToken = tokens[0];
  assert.deepEqual(tokens.map(({ pauseKinds }) => pauseKinds),
    [[], ['longWord'], ['punctuation'], ['sentence'], ['sentence'], ['paragraph']]);
  assert.equal(applyPauseOptions(doc, { longWord: 4, punctuation: 3, sentence: 1, paragraph: 2 }), doc);
  assert.equal(doc.tokens, tokens);
  assert.equal(doc.paragraphs, paragraphs);
  assert.equal(doc.tokens[0], firstToken);
  assert.deepEqual(doc.tokens.map(({ factor }) => factor), [1, 4, 3, 1, 1, 2]);
  assert.deepEqual(doc.suffixUnits, [12, 11, 7, 4, 3, 2, 0]);
  assert.equal(remainingMs(doc, 1, 600), 1100);
  assert.equal(remainingMs(doc, 1, 600, false), 500);
  const overlapping = tokenizeChapters([{ paragraphs: ['длинноеслово!'] }]);
  applyPauseOptions(overlapping, { longWord: 4, sentence: 3, paragraph: 2 });
  assert.deepEqual(overlapping.tokens[0].pauseKinds, ['longWord', 'sentence', 'paragraph']);
  assert.equal(overlapping.tokens[0].factor, 4, 'overlapping pauses use the maximum, never the product');
});

test('changing pause multipliers preserves the elapsed fraction after shared document updates', () => {
  const timer = timerHarness();
  const doc = tokenizeChapters([{ paragraphs: ['первое, второе конец'] }]);
  const engine = new ReadingEngine({ ...timer, tokens: doc.tokens });
  engine.play();
  timer.advance(150); // Half of the original 300 ms comma word.
  const pauses = { punctuation: 3 };
  applyPauseOptions(doc, pauses); // The application updates the shared token array first.
  engine.setPauseOptions(pauses);
  assert.equal(timer.pending, 1);
  assert.equal(engine.index, 0);
  timer.advance(299);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.dispose();
});

test('pause multipliers work while paused, while smart timing is disabled, and after token replacement', () => {
  const timer = timerHarness();
  const doc = tokenizeChapters([{ paragraphs: ['первое, второе'] }]);
  const engine = new ReadingEngine({ ...timer, tokens: doc.tokens, pauses: { punctuation: 2 } });
  engine.play();
  timer.advance(100); // Three quarters remain.
  engine.pause();
  engine.setPauseOptions({ punctuation: 4 });
  engine.play();
  timer.advance(599);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.replaceTokens(tokenizeChapters([{ paragraphs: ['новое, слово'] }]).tokens);
  assert.equal(engine.tokens[0].factor, 4);
  engine.setSmart(false);
  engine.play();
  timer.advance(50);
  engine.setPauseOptions({ punctuation: 2 });
  timer.advance(149);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1, 'disabled smart timing always uses the base duration');
  engine.dispose();
});

test('preparation keeps the current word, emits its state, and then starts a full duration', () => {
  const timer = timerHarness();
  const updates = [];
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), startDelay: 1000, onUpdate: (state) => updates.push(state) });
  engine.play();
  engine.play();
  assert.deepEqual(updates.at(-1), { index: 0, playing: true, finished: false, preparing: true });
  assert.equal(timer.pending, 1);
  timer.advance(999);
  assert.equal(engine.index, 0);
  assert.equal(engine.preparing, true);
  timer.advance(1);
  assert.equal(engine.index, 0);
  assert.equal(engine.preparing, false);
  assert.equal(updates.at(-1).preparing, false);
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.dispose();
});

test('pausing cancels preparation and the next play starts a fresh complete preparation', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), startDelay: 1000 });
  engine.play();
  timer.advance(700);
  engine.pause();
  assert.equal(engine.preparing, false);
  assert.equal(engine.playing, false);
  assert.equal(timer.pending, 0);
  timer.advance(10000);
  engine.play();
  timer.advance(999);
  assert.equal(engine.preparing, true);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.preparing, false);
  timer.advance(50);
  engine.pause();
  engine.play();
  timer.advance(1199);
  assert.equal(engine.index, 0, 'a prepared resume gives the current word a new full duration');
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.dispose();
});

test('speed and rhythm changes during preparation preserve its deadline and use the final timing', () => {
  const timer = timerHarness();
  const tokens = tokenizeChapters([{ paragraphs: ['первое, второе'] }]).tokens;
  const engine = new ReadingEngine({ ...timer, tokens, startDelay: 1000 });
  engine.play();
  timer.advance(400);
  engine.setSpeed(600);
  engine.setSmart(false);
  engine.setPauseOptions({ punctuation: 3 });
  engine.setSmart(true);
  assert.equal(timer.pending, 1);
  timer.advance(599);
  assert.equal(engine.preparing, true);
  timer.advance(1);
  assert.equal(engine.preparing, false);
  assert.equal(engine.index, 0);
  timer.advance(299);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.dispose();
});

test('seeking cancels preparation and immediately gives the selected word a full reading duration', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(5), startDelay: 2000 });
  engine.play();
  timer.advance(100);
  engine.seek(3);
  assert.equal(engine.preparing, false);
  assert.equal(engine.playing, true);
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 3);
  timer.advance(1);
  assert.equal(engine.index, 4);
  engine.dispose();
  assert.equal(timer.pending, 0);
});

test('replacing tokens and disposal cancel preparation without leaving a callback', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), startDelay: 1000 });
  engine.play();
  timer.advance(500);
  engine.replaceTokens(plainTokens(4), 2);
  assert.equal(engine.preparing, false);
  assert.equal(engine.playing, false);
  assert.equal(engine.index, 2);
  assert.equal(timer.pending, 0);
  timer.advance(2000);
  assert.equal(engine.index, 2);
  engine.play();
  assert.equal(engine.preparing, true);
  engine.dispose();
  assert.equal(engine.preparing, false);
  assert.equal(timer.pending, 0);
});

test('a delayed preparation callback starts a whole word and never catches up', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(5), startDelay: 1000 });
  engine.play();
  timer.delayBrowser(5000);
  timer.fireOverdue();
  assert.equal(engine.preparing, false);
  assert.equal(engine.index, 0);
  assert.equal(timer.pending, 1);
  timer.advance(199);
  assert.equal(engine.index, 0);
  timer.advance(1);
  assert.equal(engine.index, 1);
  engine.dispose();
});

test('start-delay settings accept only supported values and apply to the next preparation', () => {
  const timer = timerHarness();
  const engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), startDelay: 3000 });
  assert.equal(engine.startDelay, 0);
  engine.setStartDelay('1000');
  for (const value of [500, -1, NaN, Infinity, 'bad', '', null, true]) engine.setStartDelay(value);
  assert.equal(engine.startDelay, 1000);
  engine.play();
  timer.advance(400);
  engine.setStartDelay(2000);
  timer.advance(600);
  assert.equal(engine.preparing, false, 'changing the preference does not restart active preparation');
  engine.pause();
  engine.play();
  timer.advance(1999);
  assert.equal(engine.preparing, true);
  timer.advance(1);
  assert.equal(engine.preparing, false);
  engine.dispose();
});

test('a preparation-state listener can pause or seek without leaving duplicate callbacks', () => {
  const timer = timerHarness();
  let engine;
  engine = new ReadingEngine({ ...timer, tokens: plainTokens(3), startDelay: 1000, onUpdate: ({ preparing }) => {
    if (preparing) engine.pause();
  } });
  engine.play();
  assert.equal(engine.playing, false);
  assert.equal(timer.pending, 0);
  engine.onUpdate = ({ preparing }) => { if (preparing) engine.seek(1); };
  engine.play();
  assert.equal(engine.preparing, false);
  assert.equal(engine.index, 1);
  assert.equal(timer.pending, 1);
  timer.advance(200);
  assert.equal(engine.index, 2);
  engine.dispose();
});
