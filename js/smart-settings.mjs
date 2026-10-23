import { DEFAULT_PAUSES, RHYTHM_PRESETS, normalizePauses, profileForPauses } from './rhythm.mjs';

const PAUSE_FIELDS = [
  { key: 'longWord', label: 'Длинные слова', note: 'Больше восьми букв' },
  { key: 'punctuation', label: 'Запятая, двоеточие, точка с запятой', note: 'Небольшая остановка внутри мысли' },
  { key: 'sentence', label: 'Конец предложения', note: 'Точка, вопрос, восклицание или многоточие' },
  { key: 'paragraph', label: 'Конец абзаца', note: 'Время связать прочитанное' },
];
const presetNotes = ['Короткие задержки, более ровный ход.', 'Умеренные задержки на словах и границах мысли.', 'Больше времени на слова и завершённые мысли.'];

function formattedFactor(value) {
  const factor = Number(value);
  return `×${factor.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} · +${Math.round((factor - 1) * 100)}%`;
}

/** Settings are applied immediately through onChange; opening and closing never starts playback. */
export function setupSmartSettings({ getSettings = () => ({}), onChange = () => {}, onOpen = () => {}, onCalibration = () => {} } = {}) {
  const dialog = document.getElementById('rhythm-dialog');
  if (!dialog) throw new Error('Не найдено окно настроек ритма.');
  const $ = (id) => document.getElementById(id);
  let opener = null;

  const advanced = $('rhythm-advanced');
  const advancedContent = advanced.querySelector('.rhythm-details-content');
  const advancedIcon = advanced.querySelector('summary > span');
  advanced.querySelector('summary').replaceChildren(document.createTextNode('Точная настройка '), advancedIcon);
  advancedContent.querySelector('.rhythm-field-note')?.classList.add('rhythm-pauses-note');
  const anchorField = document.createElement('fieldset');
  anchorField.className = 'rhythm-field rhythm-anchor-field';
  anchorField.innerHTML = '<legend>Якорь в слове</legend><div class="rhythm-anchor-options" role="group" aria-label="Положение якоря в слове" aria-describedby="rhythm-anchor-note"><button type="button" data-anchor-mode="center" aria-pressed="true">Середина</button><button type="button" data-anchor-mode="left" aria-pressed="false">Немного левее</button></div><div class="rhythm-anchor-example" id="rhythm-anchor-example" role="img" aria-label="Слово «внимание», выделена буква «м»"><span aria-hidden="true">вни</span><span aria-hidden="true">м</span><span aria-hidden="true">ание</span></div><p class="rhythm-field-note" id="rhythm-anchor-note">В словах от пяти букв — на одну букву левее. Точка на экране остаётся неподвижной.</p><a class="rhythm-anchor-link" href="./research.html#anchor-position" target="_blank" rel="noopener">Почему так <span aria-hidden="true">↗</span><span class="sr-only"> (откроется в новой вкладке)</span></a>';
  advancedContent.prepend(anchorField);

  // Keep the persistent bottom action clear; restoring defaults belongs with fine tuning.
  const resetGroup = document.createElement('div');
  resetGroup.className = 'rhythm-reset-group';
  const resetNote = document.createElement('p');
  resetNote.id = 'rhythm-reset-note';
  resetNote.className = 'rhythm-field-note';
  resetNote.textContent = 'Вернёт обычные паузы, старт без задержки и чтение без автоостановок. Скорость, место в книге и положение якоря сохранятся.';
  $('rhythm-reset').setAttribute('aria-describedby', resetNote.id);
  resetGroup.append($('rhythm-reset'), resetNote);
  advancedContent.append(resetGroup);
  $('rhythm-smart-description').textContent = 'Для длинных слов и знаков препинания';
  $('rhythm-stop').closest('.rhythm-field').querySelector('.rhythm-field-note').textContent = 'Продолжите чтение вручную.';
  dialog.querySelector('.rhythm-footer p').textContent = 'Сохраняется сразу. Чтение остаётся на паузе.';

  function settingsSnapshot() {
    const settings = getSettings() || {};
    return {
      smart: settings.smart !== false,
      pauseOptions: normalizePauses(settings.pauseOptions),
      startDelay: [0, 1000, 2000].includes(settings.startDelay) ? settings.startDelay : 0,
      pauseAfterParagraph: Boolean(settings.pauseAfterParagraph),
      pauseAfterChapter: Boolean(settings.pauseAfterChapter),
      wpm: Number(settings.wpm) || 300,
      anchorMode: settings.anchorMode === 'left' ? 'left' : 'center',
    };
  }

  function apply(patch, announcement = '') {
    onChange(patch);
    sync();
    $('rhythm-status').textContent = announcement;
  }

  $('rhythm-presets').replaceChildren(...RHYTHM_PRESETS.map((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.rhythmPreset = preset.id;
    button.textContent = preset.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => apply({ pauseOptions: { ...preset.pauses } }, `Профиль «${preset.label}» выбран.`));
    return button;
  }));

  $('rhythm-ranges').replaceChildren(...PAUSE_FIELDS.map(({ key, label, note }) => {
    const row = document.createElement('div');
    row.className = 'rhythm-range-row';
    const heading = document.createElement('div');
    heading.className = 'rhythm-range-heading';
    const caption = document.createElement('label');
    caption.htmlFor = `rhythm-pause-${key}`;
    caption.textContent = label;
    const output = document.createElement('output');
    output.id = `rhythm-value-${key}`;
    output.setAttribute('for', `rhythm-pause-${key}`);
    const range = document.createElement('input');
    range.id = `rhythm-pause-${key}`;
    range.type = 'range';
    range.min = '1';
    range.max = '4';
    range.step = '0.05';
    range.dataset.pauseKind = key;
    range.setAttribute('aria-describedby', `rhythm-note-${key}`);
    const hint = document.createElement('p');
    hint.className = 'rhythm-field-note';
    hint.id = `rhythm-note-${key}`;
    hint.textContent = note;
    const updateValue = () => {
      output.textContent = formattedFactor(range.value);
      range.setAttribute('aria-valuetext', `${range.value.replace('.', ',')} обычной длительности слова`);
    };
    range.addEventListener('input', updateValue);
    // Rebuilding remaining-time weights for a long novel happens only on release.
    range.addEventListener('change', () => {
      const pauseOptions = { ...settingsSnapshot().pauseOptions, [key]: Number(range.value) };
      apply({ pauseOptions }, 'Длительность пауз обновлена.');
    });
    heading.append(caption, output);
    row.append(heading, hint, range);
    return row;
  }));

  function sync() {
    const settings = settingsSnapshot();
    const profileId = profileForPauses(settings.pauseOptions);
    const presetIndex = RHYTHM_PRESETS.findIndex((preset) => preset.id === profileId);
    const preset = RHYTHM_PRESETS[presetIndex];
    const profileLabel = preset?.label || 'Свой ритм';
    $('rhythm-smart').checked = settings.smart;
    if ($('smart')) $('smart').checked = settings.smart;
    const summary = [settings.smart ? profileLabel : 'Ровный темп'];
    if (settings.startDelay) summary.push(`старт ${settings.startDelay / 1000} с`);
    if (settings.pauseAfterChapter) summary.push('до конца главы');
    else if (settings.pauseAfterParagraph) summary.push('до конца абзаца');
    $('rhythm-summary').textContent = summary.join(' · ');
    $('rhythm-profile-note').textContent = !settings.smart
      ? 'Паузы выключены. Выбранный профиль сохранится для следующего включения.'
      : preset ? presetNotes[presetIndex] || 'Ваш профиль умных пауз.' : 'Свой ритм — значения выбраны в точной настройке.';
    dialog.querySelectorAll('[data-rhythm-preset]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rhythmPreset === profileId)));
    dialog.querySelectorAll('[data-start-delay]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.startDelay) === settings.startDelay)));
    dialog.querySelectorAll('[data-anchor-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.anchorMode === settings.anchorMode)));
    const example = $('rhythm-anchor-example');
    const exampleParts = settings.anchorMode === 'left' ? ['вн', 'и', 'мание'] : ['вни', 'м', 'ание'];
    Array.from(example.children).forEach((part, index) => { part.textContent = exampleParts[index]; });
    example.setAttribute('aria-label', `Слово «внимание», выделена буква «${exampleParts[1]}»`);
    $('rhythm-stop').value = settings.pauseAfterChapter ? 'chapter' : settings.pauseAfterParagraph ? 'paragraph' : 'none';
    for (const { key } of PAUSE_FIELDS) {
      const range = $(`rhythm-pause-${key}`);
      range.value = String(settings.pauseOptions[key]);
      range.disabled = !settings.smart;
      range.setAttribute('aria-valuetext', `${String(settings.pauseOptions[key]).replace('.', ',')} обычной длительности слова`);
      $(`rhythm-value-${key}`).textContent = formattedFactor(settings.pauseOptions[key]);
    }
    dialog.querySelectorAll('[data-speed]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === settings.wpm)));
  }

  function restoreFocus() {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function close() {
    if (dialog.open) dialog.close();
    restoreFocus();
  }

  function open() {
    if (dialog.open) { $('rhythm-close').focus(); return; }
    opener = document.activeElement;
    onOpen();
    sync();
    $('rhythm-status').textContent = '';
    dialog.querySelectorAll('details').forEach((details) => { details.open = false; });
    dialog.showModal();
    $('rhythm-close').focus();
    dialog.querySelector('.rhythm-body').scrollTop = 0;
  }

  $('smart-settings-button').addEventListener('click', open);
  $('rhythm-close').addEventListener('click', close);
  $('rhythm-done').addEventListener('click', close);
  $('rhythm-smart').addEventListener('change', () => apply({ smart: $('rhythm-smart').checked }));
  dialog.querySelectorAll('[data-start-delay]').forEach((button) => button.addEventListener('click', () => apply({ startDelay: Number(button.dataset.startDelay) })));
  dialog.querySelectorAll('[data-anchor-mode]').forEach((button) => button.addEventListener('click', () => apply({ anchorMode: button.dataset.anchorMode }, button.dataset.anchorMode === 'left' ? 'В длинных словах якорь немного левее середины.' : 'Якорь в середине слова.')));
  $('rhythm-stop').addEventListener('change', () => apply({ pauseAfterParagraph: $('rhythm-stop').value === 'paragraph', pauseAfterChapter: $('rhythm-stop').value === 'chapter' }));
  dialog.querySelectorAll('[data-speed]').forEach((button) => button.addEventListener('click', () => apply({ wpm: Number(button.dataset.speed) })));
  $('calibration-button').addEventListener('click', () => onCalibration());
  dialog.querySelectorAll('details').forEach((details) => details.addEventListener('toggle', () => {
    if (!details.open || !dialog.open || window.innerWidth > 600) return;
    const body = dialog.querySelector('.rhythm-body');
    const heading = details.querySelector('summary');
    // Bring the section the reader just opened above the fixed bottom action.
    body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }));
  $('rhythm-reset').addEventListener('click', () => apply({ smart: true, pauseOptions: { ...DEFAULT_PAUSES }, startDelay: 0, pauseAfterParagraph: false, pauseAfterChapter: false }, 'Ритм сброшен. Скорость, место в книге и положение якоря сохранены.'));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', restoreFocus);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  sync();
  return { open, close, sync };
}
