import {
  parseSubtitle, renderSubtitle, protectAssText, restoreAssText,
  charsPerSecond, cueDuration
} from './subtitles.js';

const els = Object.fromEntries([
  'fileInput','dropzone','fileMeta','editorCard','exportCard','cueList','translateBtn','resetBtn',
  'downloadBtn','copyBtn','sourceLang','styleMode','qualityMode','addressMode','glossary',
  'progressWrap','progressBar','progressText','progressCount','toast','qaSummary','apiStatus'
].map(id => [id, document.getElementById(id)]));

let state = { file: null, doc: null, filename: '', translating: false };
const BATCH_SIZE = 36;

function toast(message, error = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', error);
  els.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 4300);
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

async function readSubtitleFile(file) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const badUtf8 = (utf8.match(/�/g) || []).length;
  if (!badUtf8) return utf8;
  try {
    const gb = new TextDecoder('gb18030').decode(buffer);
    const badGb = (gb.match(/�/g) || []).length;
    if (badGb < badUtf8) return gb;
  } catch {}
  return utf8;
}

async function loadFile(file) {
  if (!file) return;
  if (!/\.(srt|ass)$/i.test(file.name)) return toast('Нужен файл .srt или .ass', true);
  if (file.size > 3_000_000) return toast('Файл слишком большой. Лимит интерфейса — 3 МБ.', true);
  const text = await readSubtitleFile(file);
  const doc = parseSubtitle(file.name, text);
  if (!doc.cues.length) return toast('Не удалось найти реплики в файле.', true);
  state = { file, doc, filename: file.name, translating: false };
  els.fileMeta.textContent = `${file.name} · ${doc.format.toUpperCase()} · ${doc.cues.length} реплик · ${(file.size / 1024).toFixed(1)} КБ`;
  els.fileMeta.classList.remove('hidden');
  els.editorCard.classList.remove('hidden');
  els.exportCard.classList.remove('hidden');
  renderEditor();
  updateQaSummary();
  toast('Файл загружен. Таймкоды и структура будут сохранены.');
}

function renderEditor() {
  els.cueList.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.doc.cues.forEach((cue, i) => {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.id = cue.id;
    const time = document.createElement('div');
    time.className = 'cue-time';
    time.innerHTML = `<strong>${i + 1}</strong><br>${formatTime(cue.startMs)} → ${formatTime(cue.endMs)}`;
    const original = document.createElement('div');
    original.className = 'cue-original';
    original.textContent = cue.original;
    const edit = document.createElement('textarea');
    edit.className = 'cue-edit';
    edit.value = cue.translated ?? cue.original;
    edit.dataset.id = cue.id;
    edit.addEventListener('input', () => {
      cue.translated = edit.value;
      updateCps(row, cue);
    });
    const cps = document.createElement('div');
    cps.className = 'cps';
    row.append(time, original, edit, cps);
    frag.append(row);
    updateCps(row, cue);
  });
  els.cueList.append(frag);
}

function updateCps(row, cue) {
  const cpsEl = row.querySelector('.cps');
  if (!cpsEl) return;
  const cps = charsPerSecond(cue);
  cpsEl.textContent = cueDuration(cue) ? `${cps.toFixed(1)} зн/с` : '—';
  cpsEl.classList.toggle('warn', cps > 17 && cps <= 21);
  cpsEl.classList.toggle('bad', cps > 21);
}

function makePayloadCue(cue) {
  const protectedInfo = protectAssText(cue.original);
  return {
    id: cue.id,
    text: protectedInfo.protectedText,
    durationMs: cueDuration(cue),
    tokens: protectedInfo.tokens.map(([token]) => token)
  };
}

async function translateBatch(batch) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceLang: els.sourceLang.value,
      styleMode: els.styleMode.value,
      qualityMode: els.qualityMode.value,
      addressMode: els.addressMode.value,
      glossary: els.glossary.value.trim(),
      cues: batch.map(makePayloadCue),
      context: state.doc.cues.slice(Math.max(0, batch[0].id - 6), batch[0].id).map(c => ({ id: c.id, source: protectAssText(c.original).protectedText, ru: protectAssText(c.translated ?? c.original).protectedText }))
    })
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Ошибка сервера ${res.status}`);
  if (!Array.isArray(data?.translations)) throw new Error('Сервер вернул некорректный ответ.');
  return data;
}

async function translateAll() {
  if (!state.doc || state.translating) return;
  state.translating = true;
  els.translateBtn.disabled = true;
  els.progressWrap.classList.remove('hidden');
  els.apiStatus.textContent = 'Перевод…';
  let completed = 0;
  let reviewed = 0;
  let warnings = [];
  try {
    for (let start = 0; start < state.doc.cues.length; start += BATCH_SIZE) {
      const batch = state.doc.cues.slice(start, start + BATCH_SIZE);
      els.progressText.textContent = els.qualityMode.value === 'quality' ? 'Перевод и редактура…' : 'Перевод…';
      els.progressCount.textContent = `${completed} / ${state.doc.cues.length}`;
      const data = await translateBatch(batch);
      const byId = new Map(data.translations.map(x => [Number(x.id), x]));
      for (const cue of batch) {
        const result = byId.get(cue.id);
        if (!result) continue;
        let text = String(result.ru ?? '');
        const info = protectAssText(cue.original);
        text = restoreAssText(text, info.tokens);
        cue.translated = text || cue.original;
      }
      reviewed += Number(data.reviewed || 0);
      warnings.push(...(data.warnings || []));
      completed += batch.length;
      const pct = Math.round((completed / state.doc.cues.length) * 100);
      els.progressBar.style.width = `${pct}%`;
      els.progressCount.textContent = `${completed} / ${state.doc.cues.length}`;
      renderEditor();
    }
    els.progressText.textContent = 'Готово';
    els.apiStatus.textContent = 'Перевод готов';
    updateQaSummary(reviewed, warnings);
    toast(els.qualityMode.value === 'quality' ? 'Перевод завершён и вычитан вторым AI-редактором.' : 'Перевод завершён.');
  } catch (error) {
    els.apiStatus.textContent = 'Ошибка перевода';
    toast(error.message || 'Не удалось выполнить перевод.', true);
  } finally {
    state.translating = false;
    els.translateBtn.disabled = false;
  }
}

function updateQaSummary(reviewed = 0, warnings = []) {
  if (!state.doc) return;
  const highCps = state.doc.cues.filter(c => charsPerSecond(c) > 21).length;
  const parts = [`${state.doc.cues.length} реплик`, 'таймкоды сохранены'];
  if (reviewed) parts.push(`${reviewed} проверено редактором`);
  if (highCps) parts.push(`${highCps} быстрых реплик`);
  if (warnings.length) parts.push(`${warnings.length} замечаний AI`);
  els.qaSummary.textContent = parts.join(' · ');
}

function resetTranslations() {
  if (!state.doc) return;
  state.doc.cues.forEach(c => c.translated = c.original);
  renderEditor();
  updateQaSummary();
}

function outputFilename() {
  const dot = state.filename.lastIndexOf('.');
  return dot >= 0 ? `${state.filename.slice(0, dot)}.ru${state.filename.slice(dot)}` : `${state.filename}.ru.srt`;
}

function download() {
  if (!state.doc) return;
  const content = renderSubtitle(state.doc);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outputFilename();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyAll() {
  if (!state.doc) return;
  await navigator.clipboard.writeText(state.doc.cues.map(c => c.translated ?? '').join('\n'));
  toast('Текст перевода скопирован.');
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') els.fileInput.click(); });
els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files?.[0]));
for (const type of ['dragenter','dragover']) els.dropzone.addEventListener(type, e => { e.preventDefault(); els.dropzone.classList.add('drag'); });
for (const type of ['dragleave','drop']) els.dropzone.addEventListener(type, e => { e.preventDefault(); els.dropzone.classList.remove('drag'); });
els.dropzone.addEventListener('drop', e => loadFile(e.dataTransfer?.files?.[0]));
els.translateBtn.addEventListener('click', translateAll);
els.resetBtn.addEventListener('click', resetTranslations);
els.downloadBtn.addEventListener('click', download);
els.copyBtn.addEventListener('click', copyAll);
