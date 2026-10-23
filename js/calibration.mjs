import { ReadingEngine, tokenizeChapters } from './reader.mjs?v=20261023-rhythm';
import { normalizePauses } from './rhythm.mjs';

// Original passage written for this short, informal in-app trial.
const PASSAGE = `В субботу утром Лена пришла в районную библиотеку помочь с обменом семенами. Обычно встречи проходили во дворе, но после ночного дождя столы перенесли в светлый зал на первом этаже. На каждом столе лежали бумажные пакеты, карандаши и небольшие карточки.

Лене поручили поставить синюю коробку возле окна. В неё посетители складывали карточки с советами по уходу за растениями. Семена оставались в отдельных пакетах, чтобы их было удобно рассматривать и выбирать. Первым пришёл пожилой сосед с семенами укропа. Он рассказал, что собирает их каждый август и хранит в сухом шкафу.

К полудню свободных карточек почти не осталось. Лена принесла новую пачку, а библиотекарь предложила повторить встречу через месяц. Перед уходом участники вместе убрали столы и оставили на подоконнике горшок с мятой. Теперь он будет напоминать читателям о маленьком саде, который начался в библиотеке.`;

const QUESTIONS = [
  {
    question: 'Почему столы перенесли со двора в зал?',
    options: ['Во дворе начался ремонт', 'Ночью прошёл дождь', 'Пришло слишком много гостей'],
    correct: 1,
  },
  {
    question: 'Что посетители складывали в синюю коробку?',
    options: ['Пакеты с семенами', 'Карандаши и чистую бумагу', 'Карточки с советами по уходу за растениями'],
    correct: 2,
  },
  {
    question: 'Какое растение оставили на подоконнике?',
    options: ['Мяту', 'Укроп', 'Базилик'],
    correct: 0,
  },
];

const STYLE_ID = 'anchor-calibration-style';
let instanceCount = 0;

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .calibration-dialog{width:min(560px,calc(100% - 24px));max-height:calc(100dvh - 24px);padding:24px;background:var(--surface,#fffefb);color:var(--text,#2d332f);border:1px solid var(--line,#e4e3db);border-radius:16px;overflow:auto}
    .calibration-dialog [hidden]{display:none!important}
    .calibration-dialog .calibration-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}
    .calibration-dialog h2{font:400 28px/1.2 Georgia,serif;margin:0 0 8px}
    .calibration-dialog h3{font:400 24px/1.35 Georgia,serif;margin:0 0 12px}
    .calibration-dialog .calibration-kicker{color:var(--accent,#c74632);font-size:11px;letter-spacing:.06em;margin:0 0 9px}
    .calibration-dialog .calibration-copy{font-size:14px;line-height:1.65;margin:0 0 16px}
    .calibration-dialog .calibration-note{color:var(--muted,#7a7e76);font-size:12px;line-height:1.65;margin:12px 0}
    .calibration-dialog .calibration-disclaimer{border-top:1px solid var(--line,#e4e3db);padding-top:15px;margin-bottom:0}
    .calibration-dialog .calibration-button{min-height:44px;border:1px solid var(--line,#e4e3db);border-radius:9px;background:transparent;color:inherit;padding:10px 15px;line-height:1.4;font-size:14px;cursor:pointer}
    .calibration-dialog .calibration-button:hover{background:var(--tint,#f2ede5)}
    .calibration-dialog .calibration-button[data-emphasis=primary]{background:var(--text,#2d332f);color:var(--surface,#fffefb);border-color:var(--text,#2d332f)}
    .calibration-dialog .calibration-button[data-emphasis=primary]:hover{opacity:.9}
    .calibration-dialog .calibration-close{flex-shrink:0;font-size:12px;padding:9px 11px}
    .calibration-dialog .calibration-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
    .calibration-dialog .calibration-actions>.calibration-button{flex:1}
    .calibration-dialog fieldset{min-width:0;border:0;margin:0 0 18px;padding:0}
    .calibration-dialog legend{padding:0;margin-bottom:10px;font-size:14px;font-weight:600;line-height:1.6}
    .calibration-dialog .calibration-speeds{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .calibration-dialog .calibration-speed{display:flex;align-items:center;gap:8px;min-height:48px;padding:10px;border:1px solid var(--line,#e4e3db);border-radius:8px;font-size:14px;cursor:pointer}
    .calibration-dialog input[type=radio]{width:18px;height:18px;flex-shrink:0;margin:0;accent-color:var(--accent,#c74632)}
    .calibration-dialog .calibration-speed:has(input:checked),.calibration-dialog .calibration-answer:has(input:checked){border-color:var(--accent,#c74632);background:var(--soft-accent,#fae9e3)}
    .calibration-dialog .calibration-stage{position:relative;display:flex;align-items:center;min-height:190px;padding:0 6px;background:var(--bg,#f7f5f0);border:1px solid var(--line,#e4e3db);border-radius:12px;overflow:hidden}
    .calibration-dialog .word-line{display:grid;grid-template-columns:minmax(0,1fr) max-content minmax(0,1fr);width:100%;font-family:Georgia,"Times New Roman",serif;font-size:48px;line-height:1.5;font-kerning:none;font-variant-ligatures:none;white-space:pre;user-select:none}
    .calibration-dialog .word-line>span:first-child{text-align:right;justify-self:end}
    .calibration-dialog .word-line>span:last-child{text-align:left;justify-self:start}
    .calibration-dialog .calibration-anchor{color:var(--accent,#c74632)}
    .calibration-dialog .calibration-guide{position:absolute;left:50%;width:1px;height:17px;background:var(--accent,#c74632);opacity:.5;transform:translateX(-.5px)}
    .calibration-dialog .calibration-guide:first-child{top:20px}
    .calibration-dialog .calibration-guide:last-child{bottom:20px}
    .calibration-dialog .calibration-progress-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;margin-top:14px}
    .calibration-dialog progress{display:block;width:100%;height:6px;accent-color:var(--accent,#c74632);margin:12px 0 0;border:0;border-radius:10px;overflow:hidden}
    .calibration-dialog progress::-webkit-progress-bar{background:var(--line,#e4e3db)}
    .calibration-dialog progress::-webkit-progress-value{background:var(--accent,#c74632)}
    .calibration-dialog .calibration-answer{display:flex;gap:11px;align-items:center;min-height:48px;border:1px solid var(--line,#e4e3db);border-radius:8px;padding:11px 12px;margin-bottom:8px;font-size:14px;line-height:1.5;cursor:pointer}
    .calibration-dialog .calibration-score{font:400 42px/1.2 Georgia,serif;color:var(--accent,#c74632);margin:0 0 12px}
    .calibration-dialog .calibration-result-metrics{padding:16px;background:var(--bg,#f7f5f0);border-radius:10px;margin-bottom:16px}
    .calibration-dialog .calibration-result-metrics p{margin:0;font-size:14px;line-height:1.6}
    .calibration-dialog .calibration-result-metrics p+p{margin-top:6px}
    .calibration-dialog .calibration-feedback{padding-left:20px;margin:16px 0;font-size:13px;line-height:1.6}
    .calibration-dialog .calibration-feedback li{padding-left:3px;margin-bottom:9px}
    .calibration-dialog .calibration-repeat-note{border-left:2px solid var(--accent,#c74632);padding-left:12px}
    @media(max-width:440px){.calibration-dialog{padding:18px}.calibration-dialog h2{font-size:25px}.calibration-dialog .calibration-speeds{grid-template-columns:repeat(2,minmax(0,1fr))}.calibration-dialog .calibration-actions{flex-direction:column}.calibration-dialog .calibration-actions>.calibration-button{width:100%}.calibration-dialog .calibration-progress-row{font-size:11px}}
  `;
  document.head.append(style);
}

function safeSpeed(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1200, Math.max(100, Math.round(numeric))) : 300;
}

/** An informal passage trial. Its engine and elapsed time are separate from the book. */
export function setupCalibration({ getWpm = () => 300, getSmart = () => true, getPauses = () => undefined, onApply = () => {}, pauseMain = () => {} } = {}) {
  installStyles();
  const id = `anchor-calibration-${++instanceCount}`;
  const doc = tokenizeChapters([{ title: 'Маленький сад', paragraphs: PASSAGE.split(/\n\s*\n/u) }]);
  const dialog = document.createElement('dialog');
  dialog.id = `${id}-dialog`;
  dialog.className = 'calibration-dialog';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-disclaimer`);
  dialog.innerHTML = `
    <div class="calibration-top">
      <div><p class="calibration-kicker">ТЕМП И ПОНИМАНИЕ</p><h2 id="${id}-title">Примерьте темп</h2></div>
      <button class="calibration-button calibration-close" type="button" data-calibration="close" aria-label="Закрыть пробу и вернуться к книге">Закрыть</button>
    </div>
    <section data-calibration="setup">
      <p class="calibration-copy">Прочитайте короткую историю по одному слову, затем ответьте на три вопроса по её содержанию. Подберите темп до начала чтения.</p>
      <fieldset><legend>Скорость пробы, слов/мин</legend><div class="calibration-speeds" data-calibration="speeds"></div></fieldset>
      <p class="calibration-note" data-calibration="setup-details"></p>
      <p class="calibration-note calibration-repeat-note" data-calibration="practice-note" hidden>Это тот же текст. Знакомство с историей может улучшить результат повторной пробы.</p>
      <div class="calibration-actions"><button class="calibration-button" data-emphasis="primary" type="button" data-calibration="start">Начать пробу</button></div>
    </section>
    <section data-calibration="reading" hidden>
      <div class="calibration-stage">
        <span class="calibration-guide" aria-hidden="true"></span>
        <div class="word-line" id="${id}-word-line" data-calibration="word-line" aria-live="off" role="img" aria-label="Слово для чтения"><span data-calibration="prefix"></span><span class="calibration-anchor" id="${id}-anchor" data-calibration="anchor"></span><span data-calibration="suffix"></span></div>
        <span class="calibration-guide" aria-hidden="true"></span>
      </div>
      <div class="calibration-progress-row"><span data-calibration="progress-label"></span><span data-calibration="run-speed"></span></div>
      <progress data-calibration="progress" max="${doc.totalWords}" value="0" aria-label="Прогресс чтения пробы"></progress>
      <p class="calibration-note" data-calibration="run-status" aria-live="polite"></p>
      <div class="calibration-actions"><button class="calibration-button" data-emphasis="primary" type="button" data-calibration="toggle">Пауза</button><button class="calibration-button" type="button" data-calibration="abort">Прервать пробу</button></div>
    </section>
    <section data-calibration="questions" hidden>
      <h3 tabindex="-1" data-calibration="questions-heading">Что осталось в памяти?</h3>
      <p class="calibration-copy">Выберите по одному ответу. К тексту сейчас возвращаться не нужно.</p>
      <form data-calibration="question-form"><div data-calibration="question-fields"></div><div class="calibration-actions"><button class="calibration-button" data-emphasis="primary" type="submit">Посмотреть результат</button></div></form>
    </section>
    <section data-calibration="results" hidden>
      <h3 tabindex="-1" data-calibration="results-heading">Результат этой пробы</h3>
      <p class="calibration-score" data-calibration="score"></p>
      <div class="calibration-result-metrics"><p data-calibration="selected-metric"></p><p data-calibration="effective-metric"></p></div>
      <p class="calibration-copy" data-calibration="result-message"></p>
      <ul class="calibration-feedback" data-calibration="feedback"></ul>
      <p class="calibration-note calibration-repeat-note">Повтор будет с тем же текстом. Знакомство с историей может улучшить результат.</p>
      <div class="calibration-actions"><button class="calibration-button" data-emphasis="primary" type="button" data-calibration="apply"></button><button class="calibration-button" type="button" data-calibration="retry"></button></div>
    </section>
    <p class="calibration-note calibration-disclaimer" id="${id}-disclaimer">Короткая проба на этом тексте, не оценка навыка чтения. Результат нельзя переносить на другие книги и задачи.</p>
  `;
  document.body.append(dialog);

  const find = (name) => dialog.querySelector(`[data-calibration="${name}"]`);
  const sections = ['setup', 'reading', 'questions', 'results'];
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  let engine = null;
  let selectedWpm = 300;
  let selectedSmart = true;
  let selectedPauses = normalizePauses();
  let stage = 'setup';
  let opener = null;
  let attempts = 0;
  let elapsedActive = 0;
  let activeSince = null;
  let effectiveWpm = 0;
  let recommendedWpm = 300;

  function stopTiming() {
    if (activeSince !== null) elapsedActive += performance.now() - activeSince;
    activeSince = null;
  }

  function disposeEngine() {
    const previous = engine;
    engine = null;
    stopTiming();
    previous?.dispose();
  }

  function showStage(next) {
    stage = next;
    sections.forEach((name) => { find(name).hidden = name !== next; });
    dialog.scrollTop = 0;
  }

  function setupStage(wpm) {
    disposeEngine();
    selectedWpm = safeSpeed(wpm);
    const speeds = [...new Set([200, 300, 450, selectedWpm])].sort((left, right) => left - right);
    find('speeds').replaceChildren(...speeds.map((speed) => {
      const label = document.createElement('label');
      label.className = 'calibration-speed';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `${id}-speed`;
      radio.value = String(speed);
      radio.checked = speed === selectedWpm;
      radio.addEventListener('change', () => { if (stage === 'setup') selectedWpm = speed; });
      const text = document.createElement('span');
      text.textContent = `${speed}`;
      label.append(radio, text);
      return label;
    }));
    find('setup-details').textContent = `${doc.totalWords} слов · Умные паузы ${selectedSmart ? 'включены' : 'выключены'}, как в вашей читалке. Начало — только по нажатию кнопки.`;
    find('practice-note').hidden = attempts === 0;
    showStage('setup');
  }

  function fitWord() {
    if (stage !== 'reading' || !engine || !measure) return;
    const token = doc.tokens[engine.index];
    const line = find('word-line');
    const width = line.getBoundingClientRect().width;
    if (!width) return;
    const base = width < 360 ? 42 : 48;
    measure.font = `${base}px Georgia, "Times New Roman", serif`;
    measure.fontKerning = 'none';
    const half = Math.max(measure.measureText(token.prefix).width, measure.measureText(token.suffix).width) + measure.measureText(token.anchor).width / 2;
    line.style.fontSize = `${Math.min(base, base * Math.max(1, width / 2 - 4) / Math.max(1, half))}px`;
  }

  function showQuestions() {
    find('question-fields').replaceChildren(...QUESTIONS.map(({ question, options }, index) => {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = `${index + 1}. ${question}`;
      fieldset.append(legend);
      options.forEach((option, optionIndex) => {
        const label = document.createElement('label');
        label.className = 'calibration-answer';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `${id}-question-${index}`;
        radio.value = String(optionIndex);
        radio.required = true;
        const text = document.createElement('span');
        text.textContent = option;
        label.append(radio, text);
        fieldset.append(label);
      });
      return fieldset;
    }));
    showStage('questions');
    find('questions-heading').focus();
  }

  function updateReading({ index, playing, finished }) {
    if (!engine) return;
    if (playing && activeSince === null) activeSince = performance.now();
    else if (!playing) stopTiming();
    const token = doc.tokens[index];
    find('prefix').textContent = token.prefix;
    find('anchor').textContent = token.anchor;
    find('suffix').textContent = token.suffix;
    find('word-line').setAttribute('aria-label', token.text);
    find('progress').value = finished ? doc.totalWords : index;
    find('progress-label').textContent = `Слово ${index + 1} из ${doc.totalWords}`;
    find('toggle').textContent = playing ? 'Пауза' : 'Продолжить';
    find('toggle').setAttribute('aria-label', playing ? 'Приостановить пробу' : 'Продолжить пробу с текущего слова');
    find('run-status').textContent = playing ? 'Держите взгляд рядом с красной буквой.' : 'Пауза. Можно продолжить с этого слова или прервать пробу.';
    fitWord();
    if (finished) {
      effectiveWpm = Math.round(doc.totalWords * 60000 / Math.max(1, elapsedActive));
      disposeEngine();
      showQuestions();
    }
  }

  function start() {
    if (stage !== 'setup' || !dialog.open) return;
    elapsedActive = 0;
    activeSince = null;
    attempts += 1;
    showStage('reading');
    find('run-speed').textContent = `${selectedWpm} слов/мин`;
    engine = new ReadingEngine({ tokens: doc.tokens, wpm: selectedWpm, smart: selectedSmart, pauses: selectedPauses, onUpdate: updateReading });
    find('toggle').focus();
    engine.play();
  }

  function showResults(event) {
    event.preventDefault();
    if (stage !== 'questions' || !find('question-form').reportValidity()) return;
    const answers = QUESTIONS.map((_, index) => Number(dialog.querySelector(`input[name="${id}-question-${index}"]:checked`).value));
    const correct = QUESTIONS.filter((question, index) => answers[index] === question.correct).length;
    recommendedWpm = correct < QUESTIONS.length ? Math.max(100, selectedWpm - 50) : selectedWpm;
    find('score').textContent = `${correct} / ${QUESTIONS.length} верных ответов`;
    find('selected-metric').textContent = `Выбранный темп: ${selectedWpm} слов/мин`;
    find('effective-metric').textContent = `Фактически: ${effectiveWpm} слов/мин — с учётом задержек между словами, без времени на паузе.`;
    find('result-message').textContent = correct === QUESTIONS.length
      ? 'Вы верно ответили на все три вопроса об этой истории. На более сложном тексте удобный темп может быть другим.'
      : selectedWpm > 100
        ? 'Некоторые детали не сохранились в памяти. Попробуйте на 50 слов/мин медленнее и сравните ощущения.'
        : 'Некоторые детали не сохранились в памяти. Можно повторить в минимальном темпе или читать обычным способом, с возвратами к тексту.';
    find('feedback').replaceChildren(...QUESTIONS.map((question, index) => {
      const item = document.createElement('li');
      item.textContent = `${answers[index] === question.correct ? 'Верно' : 'Правильный ответ'}: ${question.options[question.correct]}.`;
      return item;
    }));
    find('apply').textContent = `Оставить ${selectedWpm} слов/мин`;
    find('retry').textContent = `Повторить на ${recommendedWpm} слов/мин`;
    showStage('results');
    find('results-heading').focus();
  }

  function restoreFocus() {
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    opener = null;
  }

  function close() {
    disposeEngine();
    if (dialog.open) dialog.close();
    restoreFocus();
  }

  function open() {
    if (dialog.open) { find('close').focus(); return; }
    opener = document.activeElement;
    pauseMain();
    selectedSmart = Boolean(getSmart());
    selectedPauses = normalizePauses(getPauses());
    setupStage(getWpm());
    dialog.showModal();
    find('close').focus();
  }

  find('close').addEventListener('click', close);
  find('abort').addEventListener('click', close);
  find('start').addEventListener('click', start);
  find('toggle').addEventListener('click', () => engine?.toggle());
  find('question-form').addEventListener('submit', showResults);
  find('apply').addEventListener('click', () => { onApply(selectedWpm); close(); });
  find('retry').addEventListener('click', () => { setupStage(recommendedWpm); find('start').focus(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { disposeEngine(); restoreFocus(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && stage === 'reading' && !event.target.closest('button,input,textarea,select') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      engine?.toggle();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dialog.open && engine?.playing) {
      engine.pause();
      find('run-status').textContent = 'Проба приостановлена: вкладка была скрыта. Нажмите «Продолжить», когда будете готовы.';
    }
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitWord).observe(find('word-line'));
  else window.addEventListener('resize', fitWord);
  return { open, close };
}
