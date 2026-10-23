import { ReadingEngine, tokenizeChapters, splitAnchor } from './reader.mjs?v=20261023-mobile';
import { normalizePauses } from './rhythm.mjs';
import { START_SPEED, SPEED_STEP, MIN_SPEED, MAX_SPEED, VERIFY_WORDS, clampComfortSpeed, rampSpeed, candidateSpeed } from './comfort-model.mjs';

// Original story for this informal comfort exercise, independent of the user's book.
const PASSAGE = `В небольшом городе решили открыть мастерскую для соседей. Под неё отвели светлую комнату на первом этаже старого дома. Раньше там хранили ненужные стулья и коробки, а теперь поставили длинный стол, повесили полки и вымыли окна. Через стекло были видны липы, скамейка и узкая дорожка к реке. На двери появилась простая надпись: здесь можно сделать полезную вещь своими руками.

Первой в мастерскую пришла Оля. Она принесла деревянную кормушку, которую нашла на даче. Крыша держалась крепко, но дно совсем рассохлось. Оля хотела починить кормушку до холодов и повесить её у своего окна. За столом уже сидел сосед Михаил. Он раскладывал инструменты и подписывал небольшие ящики, чтобы каждый мог быстро найти отвёртку, карандаш или линейку. Они познакомились и вместе осмотрели старую доску.

Михаил предложил сначала нарисовать новую деталь на бумаге. Оля измерила ширину кормушки два раза и записала число на краю листа. Потом они выбрали подходящий кусок дерева. На нём были тёмные полоски и маленький сучок, похожий на глаз. Оля провела ладонью по поверхности и решила оставить рисунок дерева открытым. Краска могла подождать, ведь сейчас важнее было сделать прочное дно и сгладить острые края.

Пока они работали, в комнату заглянул мальчик с бабушкой. В руках у него был бумажный кораблик. После прогулки вдоль реки он захотел построить настоящий маленький плот. Бабушка принесла несколько сухих веточек и моток бечёвки. Ребёнок выложил ветки рядом и стал сравнивать их длину. Самая короткая всё время выпадала из ряда. Тогда он отложил её для мачты и довольно улыбнулся своему решению.

К полудню за большим столом собрались ещё несколько человек. Кто-то пришивал пуговицу к пальто, кто-то собирал подставку для цветов. На свободном краю лежал толстый блокнот. Каждый записывал туда, какие материалы ещё нужны и какие вещи удалось закончить. Рядом оставляли короткие советы. Одна запись напоминала, что ножницы нужно возвращать на верхнюю полку. Другая предлагала принести в следующий раз старые журналы для бумажных поделок.

Оля закончила кормушку и вынесла её во двор. На свежем воздухе дерево казалось светлее, чем в комнате. Михаил помог привязать верёвку, а бабушка показала ветку, до которой было удобно дотянуться. Кормушку повесили так, чтобы она не раскачивалась на ветру. Затем все отошли к скамейке. Птицы пока не появлялись, но никто не торопился. У каждого нашлась причина ещё немного постоять среди деревьев.

Мальчик тем временем проверял свой плот в широкой миске с водой. Сначала один край уходил под воду. Он снял тяжёлый камешек, которым хотел украсить палубу, и плот выровнялся. На маленькой мачте появился бумажный флаг. Мальчик несколько раз осторожно подул на него, наблюдая, как веточки двигаются по кругу. Бабушка предложила оставить испытания в миске: у реки течение было слишком быстрым для такой лёгкой постройки.

Во второй половине дня начался тихий дождь. Посетители придвинули стулья ближе к окнам, чтобы видеть капли на стекле. В мастерской закипел чайник. Разговор постепенно перешёл от инструментов к историям о городе. Михаил вспомнил, что когда-то рядом работала небольшая лодочная станция. Оля рассказала о тропинке за мостом, где весной особенно много цветов. Кто-то нарисовал эту дорогу в блокноте, добавив поворот возле большого камня.

Перед закрытием все вместе убрали стол. Оставшиеся кусочки дерева сложили в корзину, нитки свернули, а пол подмели мягкой щёткой. Блокнот положили у входа, чтобы новые посетители сразу его заметили. Оля предложила в следующий раз сделать указатель к мастерской. Для него уже нашлась ровная дощечка. Решили написать только название улицы и нарисовать стрелку: длинные объяснения прохожие всё равно не успели бы прочитать.

Когда дверь закрыли, дождь почти закончился. На дорожке блестели лужи, а над рекой медленно светлело небо. Оля прошла мимо кормушки и остановилась. На её краю сидела маленькая птица. Она быстро оглянулась и взяла семечко. Оля не стала подходить ближе. Ей понравилось, что обычный свободный день оставил после себя такую простую вещь: место, куда можно прийти, что-то попробовать и встретить соседей.`;

const CONFIRMATION_PASSAGE = 'Утром на площади открыли цветочный киоск. Продавец поставил у двери ведро с ромашками. Прохожая выбрала небольшой букет и понесла его домой по тихой улице.';

/** A subjective display-comfort exercise. It never changes the book or applies a speed on its own. */
export function setupComfortCalibration({ getAnchorMode = () => 'center', getSmart = () => true, getPauses = () => undefined, onApply = () => {}, pauseMain = () => {} } = {}) {
  const source = tokenizeChapters([{ title: 'Мастерская у реки', paragraphs: PASSAGE.split(/\n\s*\n/u) }]);
  const fallbackTrial = tokenizeChapters([{ title: 'Утренние цветы', paragraphs: [CONFIRMATION_PASSAGE] }]).tokens.slice(0, VERIFY_WORDS);
  const dialog = document.createElement('dialog');
  dialog.id = 'comfort-dialog';
  dialog.className = 'comfort-dialog';
  dialog.setAttribute('aria-labelledby', 'comfort-title');
  dialog.setAttribute('aria-describedby', 'comfort-disclaimer');
  dialog.innerHTML = `
    <header class="comfort-header"><h2 id="comfort-title">Комфортный темп</h2><button id="comfort-close" class="comfort-close" type="button" aria-label="Закрыть пробу и вернуться к книге">×</button></header>
    <div class="comfort-body">
      <section id="comfort-intro" class="comfort-intro">
        <p>Темп начнётся со 150 слов/мин и будет понемногу расти. Нажмите «Уже быстро», когда станет некомфортно.</p>
        <p class="comfort-note">Затем проверите выбранную скорость на коротком отрезке.</p>
      </section>
      <section id="comfort-reading" class="comfort-reading" hidden>
        <div class="comfort-reading-heading"><div class="comfort-speed"><strong id="comfort-speed-value">150</strong><span>слов/мин</span></div><p id="comfort-reading-note">Темп растёт понемногу</p></div>
        <div id="comfort-word-stage" class="comfort-word-stage"><span class="comfort-guide comfort-guide-top" aria-hidden="true"></span><div id="comfort-word-line" class="comfort-word-line" role="img" aria-live="off" aria-label="Слово для чтения"><span id="comfort-prefix" aria-hidden="true"></span><span id="comfort-anchor" aria-hidden="true"></span><span id="comfort-suffix" aria-hidden="true"></span></div><span class="comfort-guide comfort-guide-bottom" aria-hidden="true"></span></div>
        <p id="comfort-run-status" class="comfort-run-status" role="status" aria-live="polite"></p>
      </section>
      <section id="comfort-confirm" class="comfort-confirm" hidden>
        <h3>Ваш ориентир комфорта</h3><p class="comfort-note" id="comfort-candidate-note"></p>
        <div class="comfort-candidate" role="group" aria-label="Выберите темп для проверки"><button id="comfort-candidate-down" type="button" aria-label="Уменьшить темп на 25 слов в минуту">−</button><div><output id="comfort-candidate-value">150</output><span>слов/мин</span></div><button id="comfort-candidate-up" type="button" aria-label="Увеличить темп на 25 слов в минуту">+</button></div>
        <p class="comfort-note">Проверьте этот темп на 24 словах.</p>
      </section>
      <section id="comfort-result" class="comfort-result" hidden>
        <h3>Ваш ориентир комфорта</h3><p class="comfort-result-speed"><strong id="comfort-result-value">150</strong> <span>слов/мин</span></p><p class="comfort-note">Если читать было удобно, сохраните этот темп для книги.</p>
      </section>
    </div>
    <footer class="comfort-footer">
      <button id="comfort-start" class="comfort-primary" type="button">Начать со 150</button>
      <div id="comfort-reading-actions" class="comfort-reading-actions" hidden><button id="comfort-too-fast" class="comfort-primary" type="button">Уже быстро</button><button id="comfort-slower" class="comfort-primary" type="button" hidden>Медленнее</button><div class="comfort-secondary-actions"><button id="comfort-toggle" class="comfort-secondary" type="button" aria-pressed="false">Пауза</button><button id="comfort-dismiss" class="comfort-secondary" type="button">К книге</button></div></div>
      <button id="comfort-check" class="comfort-primary" type="button" hidden>Проверить этот темп</button>
      <div id="comfort-result-actions" class="comfort-result-actions" hidden><button id="comfort-apply" class="comfort-primary" type="button" disabled>Комфортно — сохранить</button><button id="comfort-adjust" class="comfort-secondary" type="button">Настроить ещё</button></div>
      <p id="comfort-disclaimer">Удобство показа, не проверка понимания.</p>
    </footer>`;
  document.body.append(dialog);

  const find = (name) => dialog.querySelector(`#comfort-${name}`);
  const measure = document.createElement('canvas').getContext('2d');
  let engine = null;
  let activeTokens = [];
  let phase = 'intro';
  let selectedSmart = true;
  let selectedPauses = normalizePauses();
  let selectedAnchorMode = 'center';
  let candidate = START_SPEED;
  let cursor = 0;
  let rampCompleted = 0;
  let hiddenPause = false;
  let repeatedTrial = false;
  let usedFallbackTrial = false;
  let opener = null;
  let fitFrame = null;

  function disposeEngine() {
    const previous = engine;
    engine = null;
    previous?.dispose();
    dialog.dataset.playing = 'false';
  }

  function showPhase(next, focusName) {
    phase = next;
    dialog.dataset.phase = next;
    const reading = next === 'ramp' || next === 'trial';
    for (const name of ['intro', 'confirm', 'result']) find(name).hidden = name !== next;
    find('reading').hidden = !reading;
    find('start').hidden = next !== 'intro';
    find('reading-actions').hidden = !reading;
    find('too-fast').hidden = next !== 'ramp';
    find('slower').hidden = next !== 'trial';
    find('check').hidden = next !== 'confirm';
    find('result-actions').hidden = next !== 'result';
    find('apply').disabled = next !== 'result';
    dialog.querySelector('.comfort-body').scrollTop = 0;
    if (dialog.open && focusName) find(focusName).focus({ preventScroll: true });
  }

  function fitWord() {
    if (!dialog.open || !engine || !measure || !['ramp', 'trial'].includes(phase)) return;
    const token = activeTokens[engine.index];
    if (!token) return;
    const parts = selectedAnchorMode === 'left' ? splitAnchor(token.text, 'left') : token;
    const line = find('word-line');
    const bounds = line.getBoundingClientRect();
    const stageHeight = find('word-stage').getBoundingClientRect().height;
    if (!bounds.width || !stageHeight) return;
    const base = Math.min(bounds.width < 360 ? 46 : 56, Math.max(12, (stageHeight - 24) / 1.5));
    measure.font = `${base}px Georgia, "Times New Roman", serif`;
    measure.fontKerning = 'none';
    const half = Math.max(measure.measureText(parts.prefix).width, measure.measureText(parts.suffix).width) + measure.measureText(parts.anchor).width / 2;
    line.style.fontSize = `${Math.min(base, base * Math.max(1, bounds.width / 2 - 3) / Math.max(1, half))}px`;
  }

  function requestFit() {
    if (!dialog.open || fitFrame !== null) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = null; fitWord(); });
  }

  function updateCandidate() {
    find('candidate-value').value = String(candidate);
    find('candidate-value').textContent = String(candidate);
    find('candidate-down').disabled = candidate <= MIN_SPEED;
    find('candidate-up').disabled = candidate >= MAX_SPEED;
  }

  function confirmSpeed(value, reason = 'adjust') {
    disposeEngine();
    candidate = clampComfortSpeed(value);
    hiddenPause = false;
    find('candidate-note').textContent = reason === 'fast'
      ? 'Попробуем на один шаг медленнее. Темп можно изменить.'
      : reason === 'cap' ? 'Дошли до верхней границы пробы. Выберите удобный темп.'
        : reason === 'end' ? 'Отрывок закончился. Выберите темп и проверьте его.'
          : 'Можно сделать ещё один шаг медленнее или быстрее.';
    updateCandidate();
    showPhase('confirm', 'check');
  }

  function showResult() {
    disposeEngine();
    find('result-value').textContent = String(candidate);
    find('apply').textContent = `Комфортно — сохранить ${candidate}`;
    find('apply').setAttribute('aria-label', `Комфортно — сохранить ${candidate} слов в минуту для книги`);
    showPhase('result', 'apply');
  }

  function updateReading({ index, playing, finished }) {
    if (!engine || !['ramp', 'trial'].includes(phase)) return;
    const currentEngine = engine;
    if (phase === 'ramp') {
      // A repeated emit (pause/resume or speed update) never counts as a new word.
      rampCompleted = Math.max(rampCompleted, index + Number(finished));
      cursor = Math.min(source.tokens.length, index + 1);
      const nextSpeed = rampSpeed(rampCompleted);
      if (nextSpeed >= MAX_SPEED) { cursor = index; confirmSpeed(MAX_SPEED, 'cap'); return; }
      if (finished) { confirmSpeed(currentEngine.wpm, 'end'); return; }
      if (currentEngine.wpm !== nextSpeed) { currentEngine.setSpeed(nextSpeed); return; }
    } else if (finished) {
      showResult();
      return;
    }
    const token = activeTokens[index];
    const parts = selectedAnchorMode === 'left' ? splitAnchor(token.text, 'left') : token;
    find('prefix').textContent = parts.prefix;
    find('anchor').textContent = parts.anchor;
    find('suffix').textContent = parts.suffix;
    find('word-line').setAttribute('aria-label', token.text);
    find('word-line').dataset.index = String(index);
    find('speed-value').textContent = String(currentEngine.wpm);
    find('reading-note').textContent = phase === 'ramp' ? 'Темп растёт понемногу' : `${repeatedTrial ? 'Повтор отрывка' : 'Проверка темпа'} · ${index + 1} из ${VERIFY_WORDS}`;
    dialog.dataset.playing = String(playing);
    find('toggle').textContent = playing ? 'Пауза' : 'Продолжить';
    find('toggle').setAttribute('aria-pressed', String(playing));
    find('toggle').setAttribute('aria-label', playing ? 'Приостановить пробу' : 'Продолжить с текущего слова');
    find('run-status').textContent = playing ? '' : hiddenPause ? 'Пауза: вкладка была скрыта. Продолжите, когда будете готовы.' : 'Пауза. Продолжите, когда будете готовы.';
    fitWord();
  }

  function beginReading(nextPhase, tokens, wpm) {
    disposeEngine();
    activeTokens = tokens;
    hiddenPause = false;
    showPhase(nextPhase, nextPhase === 'ramp' ? 'too-fast' : 'slower');
    engine = new ReadingEngine({ tokens, wpm, smart: selectedSmart, pauses: selectedPauses, onUpdate: updateReading });
    engine.play();
    requestFit();
  }

  function start() {
    if (!dialog.open || phase !== 'intro') return;
    rampCompleted = 0;
    cursor = 0;
    beginReading('ramp', source.tokens, START_SPEED);
  }

  function checkCandidate() {
    if (!dialog.open || phase !== 'confirm') return;
    // A separate original excerpt keeps the ramp story from looping at its end.
    const enoughRemaining = source.tokens.length - cursor >= VERIFY_WORDS;
    const tokens = enoughRemaining ? source.tokens.slice(cursor, cursor + VERIFY_WORDS) : fallbackTrial;
    repeatedTrial = !enoughRemaining && usedFallbackTrial;
    if (enoughRemaining) cursor += VERIFY_WORDS;
    else usedFallbackTrial = true;
    beginReading('trial', tokens, candidate);
  }

  function restoreFocus() {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function cleanup() {
    disposeEngine();
    if (fitFrame !== null) cancelAnimationFrame(fitFrame);
    fitFrame = null;
    restoreFocus();
  }

  function close() {
    if (dialog.open) dialog.close();
    cleanup();
  }

  function open() {
    if (dialog.open) { find('close').focus(); return; }
    opener = document.activeElement;
    pauseMain();
    disposeEngine();
    selectedAnchorMode = getAnchorMode() === 'left' ? 'left' : 'center';
    selectedSmart = getSmart() !== false;
    selectedPauses = normalizePauses(getPauses());
    candidate = START_SPEED;
    cursor = 0;
    rampCompleted = 0;
    hiddenPause = false;
    repeatedTrial = false;
    usedFallbackTrial = false;
    showPhase('intro');
    dialog.showModal();
    find('start').focus({ preventScroll: true });
  }

  find('start').addEventListener('click', start);
  find('close').addEventListener('click', close);
  find('dismiss').addEventListener('click', close);
  find('too-fast').addEventListener('click', () => {
    if (phase === 'ramp' && engine) confirmSpeed(candidateSpeed(engine.wpm), 'fast');
  });
  find('toggle').addEventListener('click', () => { hiddenPause = false; engine?.toggle(); });
  find('candidate-down').addEventListener('click', () => { if (phase === 'confirm') { candidate = clampComfortSpeed(candidate - SPEED_STEP); updateCandidate(); } });
  find('candidate-up').addEventListener('click', () => { if (phase === 'confirm') { candidate = clampComfortSpeed(candidate + SPEED_STEP); updateCandidate(); } });
  find('check').addEventListener('click', checkCandidate);
  find('slower').addEventListener('click', () => { if (phase === 'trial') confirmSpeed(candidateSpeed(candidate), 'fast'); });
  find('adjust').addEventListener('click', () => { if (phase === 'result') confirmSpeed(candidate); });
  find('apply').addEventListener('click', () => { if (dialog.open && phase === 'result') { onApply(candidate); close(); } });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  // A queued close event from an earlier opening must not stop a reopened trial.
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dialog.open && engine?.playing) { hiddenPause = true; engine.pause(); }
  });
  window.addEventListener('resize', requestFit);
  window.visualViewport?.addEventListener('resize', requestFit);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(requestFit) : null;
  observer?.observe(find('word-stage'));
  showPhase('intro');
  return { open, close };
}
