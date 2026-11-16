import { getSettings, saveSettings, getSegments, computeStats, clipSegments, dayBounds, fmtDur, fmtTime, STATE_COLORS } from './common.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
let selected = new Date();
let activeTab = 'presence';

// Заголовки страниц приходят с сайтов — экранируем перед вставкой в HTML
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Стабильный цвет для домена
function domainColor(domain) {
  let h = 0;
  for (const ch of domain || '?') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 52%)`;
}

const PRESENCE_FIELDS = [
  ['awayDelaySec', 'Через сколько секунд без вас считать «отошёл»', 1, 110, 1],
  ['phoneDelaySec', 'Через сколько секунд с телефоном считать «в телефоне»', 1, 110, 1],
  ['returnDelaySec', 'Через сколько секунд засчитать возвращение', 1, 60, 1],
  ['minBreakSec', 'Минимальный перерыв, сек (короче — не прерывает сессию)', 10, 3600, 10],
  ['phoneThreshold', 'Порог уверенности «телефон в кадре» (0–1)', 0.1, 0.9, 0.05],
  ['eyeDownThreshold', 'Порог «глаза смотрят вниз» (0–1)', 0.2, 0.95, 0.05],
  ['pitchDelta', 'Чувствительность к наклону головы (меньше — чувствительнее)', 0.01, 0.2, 0.01],
  ['intervalMs', 'Интервал анализа кадров, мс', 300, 5000, 100],
  ['keepDays', 'Хранить историю (присутствие и вкладки), дней', 7, 3650, 1]
];
const PRESENCE_CHECKS = [['lookDownCountsAsPhone', 'Считать долгий взгляд вниз телефоном, даже если телефон не виден в кадре']];

const TAB_FIELDS = [
  ['screenshotIntervalMin', 'Скриншот каждые, мин', 1, 240, 1],
  ['shotsKeepDays', 'Хранить скриншоты, дней', 1, 3650, 1],
  ['screenshotMaxWidth', 'Ширина скриншота, px', 640, 3840, 10],
  ['screenshotQuality', 'Качество JPEG (0.3–0.95)', 0.3, 0.95, 0.05]
];
const TAB_CHECKS = [
  ['trackTabs', 'Записывать вкладки и время в браузере'],
  ['screenshotsEnabled', 'Делать скриншоты активной вкладки'],
  ['screenshotSkipWhenAway', 'Не делать скриншоты, когда камера видит, что вы отошли']
];

function toInputDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timelineHtml(items, from, to, colorOf, titleOf) {
  const day = to - from;
  return items.map(s => {
    const left = (s.start - from) / day * 100;
    const width = Math.max((s.end - s.start) / day * 100, 0.08);
    return `<div style="left:${left}%;width:${width}%;background:${colorOf(s)}" title="${esc(titleOf(s))}"></div>`;
  }).join('');
}

// ======================= ПРИСУТСТВИЕ =======================
async function renderPresence() {
  const settings = await getSettings();
  const [from, to] = dayBounds(selected);
  const twoWeeksAgo = dayBounds(new Date(Date.now() - 13 * 86400000))[0];
  const segments = await getSegments(Math.min(from, twoWeeksAgo), Math.max(to, Date.now() + 86400000));
  const st = computeStats(segments, from, to, settings.minBreakSec);

  $('tAtDesk').textContent = fmtDur(st.atDesk);
  $('tFocused').textContent = fmtDur(st.focused);
  $('tPhone').textContent = st.atDesk ? `${fmtDur(st.phone)} · ${Math.round(st.phone / st.atDesk * 100)}%` : '—';
  $('tLongest').textContent = fmtDur(st.longest);
  $('tAvg').textContent = fmtDur(st.average);

  $('timeline').innerHTML = timelineHtml(st.segments, from, to, s => STATE_COLORS[s.s],
    s => `${fmtTime(s.start)}–${fmtTime(s.end)} · ${fmtDur(s.end - s.start)}`);

  const tbody = $('sessions').querySelector('tbody');
  tbody.innerHTML = st.sessions.length ? st.sessions.map((s, i) => {
    const br = st.breaks[i];
    const pct = s.end > s.start ? Math.round(s.phone / (s.end - s.start) * 100) : 0;
    return `<tr><td>${fmtTime(s.start)}–${s.open ? 'сейчас' : fmtTime(s.end)}</td>
      <td><b>${fmtDur(s.end - s.start)}</b></td>
      <td>${fmtDur(s.phone)} <span class="muted">(${pct}%)</span></td>
      <td class="muted">${br ? fmtDur(br.end - br.start) : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Нет данных за этот день</td></tr>';

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const [f, t] = dayBounds(d);
    const s = computeStats(segments, f, t, settings.minBreakSec);
    days.push({ d, atDesk: s.atDesk, phone: s.phone });
  }
  const max = Math.max(...days.map(d => d.atDesk), 3600000);
  $('bars').innerHTML = days.map((x, i) => {
    const h = x.atDesk / max * 130;
    const ph = x.atDesk ? x.phone / x.atDesk * h : 0;
    const sel = toInputDate(x.d) === toInputDate(selected) ? 'sel' : '';
    return `<div class="bar ${sel}" data-i="${i}" title="${fmtDur(x.atDesk)} за компьютером, ${fmtDur(x.phone)} в телефоне">
      <div class="stack"><div style="height:${h - ph}px;background:${STATE_COLORS.present}"></div>
      <div style="height:${ph}px;background:${STATE_COLORS.phone}"></div></div>
      <div class="lbl">${x.d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' })}</div></div>`;
  }).join('');
  document.querySelectorAll('.bar').forEach(el => el.onclick = () => { selected = days[+el.dataset.i].d; renderAll(); });
}

// ======================= ВКЛАДКИ =======================
async function renderTabs() {
  const settings = await getSettings();
  $('tabsOff').style.display = settings.trackTabs ? 'none' : '';
  const [from, to] = dayBounds(selected);
  const now = Date.now();

  // Открытый интервал обновляется раз в минуту — дотягиваем его до "сейчас" для отображения
  const raw = (await db.overlapping('activity', from, Math.max(to, now + 60000)))
    .map(a => (a.open && now - a.end < 180000 ? { ...a, end: now } : a));
  const acts = raw.map(a => ({ ...a, start: Math.max(a.start, from), end: Math.min(a.end, to) })).filter(a => a.end > a.start);

  const tabActs = acts.filter(a => a.kind === 'tab');
  const activeMs = tabActs.reduce((x, a) => x + a.end - a.start, 0);
  const blurMs = acts.filter(a => a.kind === 'blur').reduce((x, a) => x + a.end - a.start, 0);

  const bySite = new Map();
  const byTabRec = new Map();
  for (const a of tabActs) {
    const d = a.domain || '(без адреса)';
    bySite.set(d, (bySite.get(d) || 0) + a.end - a.start);
    if (a.tabRec) byTabRec.set(a.tabRec, (byTabRec.get(a.tabRec) || 0) + a.end - a.start);
  }

  const tabs = await db.overlapping('tablog', from, to);
  const opened = tabs.filter(t => t.openedAt >= from && !t.restored).length;
  const closed = tabs.filter(t => t.closedAt && t.closedAt >= from && t.closedAt < to).length;

  $('bActive').textContent = fmtDur(activeMs);
  $('bBlur').textContent = fmtDur(blurMs);
  $('bSites').textContent = bySite.size;
  $('bOpened').textContent = opened;
  $('bClosed').textContent = closed;

  $('bTimeline').innerHTML = timelineHtml(acts, from, to,
    a => (a.kind === 'blur' ? 'var(--line)' : domainColor(a.domain)),
    a => `${fmtTime(a.start)}–${fmtTime(a.end)} · ${fmtDur(a.end - a.start)}\n` +
      (a.kind === 'blur' ? 'Браузер свёрнут / в другом окне' : `${a.domain}\n${a.title}`));

  const sites = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const top = sites[0]?.[1] || 1;
  $('sites').innerHTML = sites.length ? sites.map(([d, ms]) => `<div class="site">
      <span class="ellipsis" title="${esc(d)}">${esc(d)}</span>
      <div class="track"><div class="fill" style="width:${ms / top * 100}%;background:${domainColor(d)}"></div></div>
      <span>${fmtDur(ms)} <span class="muted">${activeMs ? Math.round(ms / activeMs * 100) : 0}%</span></span></div>`).join('')
    : '<div class="muted">Нет данных за этот день</div>';

  const q = $('tabFilter').value.trim().toLowerCase();
  const rows = tabs
    .filter(t => !q || (t.title || '').toLowerCase().includes(q) || (t.domain || '').toLowerCase().includes(q))
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 500);
  const sameDay = (ts) => ts >= from && ts < to;
  const when = (ts) => sameDay(ts) ? fmtTime(ts) : new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  $('tablog').querySelector('tbody').innerHTML = rows.length ? rows.map(t => {
    const isOpen = t.end === Infinity;
    const life = (isOpen ? now : t.closedAt) - t.openedAt;
    const act = byTabRec.get(t.id) || 0;
    return `<tr>
      <td>${t.restored ? '<span class="muted" title="Вкладка уже была открыта при запуске браузера/расширения">≤ </span>' : ''}${when(t.openedAt)}</td>
      <td>${isOpen ? '<span style="color:var(--present)">открыта</span>' : when(t.closedAt)}</td>
      <td>${fmtDur(life)}</td>
      <td><b>${act ? fmtDur(act) : '—'}</b></td>
      <td class="title ellipsis"><i class="dot" style="background:${domainColor(t.domain)}"></i>
        <span title="${esc(t.url)}">${esc(t.title || t.url || '(без названия)')}</span>
        <span class="muted small">${esc(t.domain)}${t.pages > 1 ? ` · ${t.pages} стр.` : ''}</span></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">Нет вкладок за этот день</td></tr>';
}

// ======================= СКРИНШОТЫ =======================
let shotList = [];
let objectUrls = [];
let lbIndex = -1;

async function renderShots() {
  objectUrls.forEach(u => URL.revokeObjectURL(u));
  objectUrls = [];
  const settings = await getSettings();
  const [from, to] = dayBounds(selected);
  shotList = (await db.inRange('shots', 'ts', from, to)).sort((a, b) => a.ts - b.ts);
  const total = await db.shotsStats();

  $('shotsInfo').textContent =
    `За день: ${shotList.length}. Всего: ${total.n} (${(total.bytes / 1048576).toFixed(1)} МБ). ` +
    (settings.screenshotsEnabled ? `Автоматически каждые ${settings.screenshotIntervalMin} мин, хранятся ${settings.shotsKeepDays} дн.` : 'Автоматические скриншоты выключены.');

  const { lastShot } = await chrome.storage.local.get('lastShot');
  $('lastShot').innerHTML = lastShot
    ? `<span class="muted">Последняя попытка в ${fmtTime(lastShot.ts)}: </span>` +
      (lastShot.ok ? '<span style="color:var(--present)">снято</span>'
        : lastShot.skipped ? `пропущено — ${esc(lastShot.skipped)}`
        : `<span style="color:var(--err)">ошибка — ${esc(lastShot.error)}</span>`)
    : '';

  $('shotGrid').innerHTML = shotList.length ? shotList.map((s, i) => {
    const u = URL.createObjectURL(s.blob); objectUrls.push(u); s._url = u;
    return `<div class="shot" data-i="${i}"><img loading="lazy" src="${u}" alt="">
      <div class="meta"><b>${fmtTime(s.ts)}</b> <span class="muted">${esc(s.domain)}</span>
      <div class="ellipsis muted" title="${esc(s.title)}">${esc(s.title)}</div></div></div>`;
  }).join('') : '<div class="muted">Скриншотов за этот день нет</div>';
  document.querySelectorAll('.shot').forEach(el => el.onclick = () => openLightbox(+el.dataset.i));
}

function openLightbox(i) {
  if (!shotList.length) return closeLightbox();
  lbIndex = (i + shotList.length) % shotList.length;
  const s = shotList[lbIndex];
  $('lbImg').src = s._url;
  $('lbMeta').innerHTML = `${new Date(s.ts).toLocaleString('ru-RU')} · <a href="${esc(s.url)}" target="_blank">${esc(s.title || s.url)}</a> · ${(s.size / 1024).toFixed(0)} КБ`;
  $('lbDownload').href = s._url;
  $('lbDownload').download = `screenshot-${toInputDate(new Date(s.ts))}-${fmtTime(s.ts).replace(':', '-')}.jpg`;
  $('lightbox').classList.add('open');
}
function closeLightbox() { $('lightbox').classList.remove('open'); lbIndex = -1; }

$('lbPrev').onclick = () => openLightbox(lbIndex - 1);
$('lbNext').onclick = () => openLightbox(lbIndex + 1);
$('lbClose').onclick = closeLightbox;
$('lightbox').onclick = (e) => { if (e.target === $('lightbox')) closeLightbox(); };
$('lbDelete').onclick = async () => {
  const s = shotList[lbIndex];
  if (!s || !confirm('Удалить этот скриншот?')) return;
  await db.del('shots', s.id);
  const keep = lbIndex;
  await renderShots();
  shotList.length ? openLightbox(Math.min(keep, shotList.length - 1)) : closeLightbox();
};
document.addEventListener('keydown', (e) => {
  if (lbIndex < 0) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') openLightbox(lbIndex - 1);
  if (e.key === 'ArrowRight') openLightbox(lbIndex + 1);
});

// ======================= НАСТРОЙКИ =======================
function fieldsHtml(fields, checks, s) {
  return checks.map(([k, label]) =>
    `<label class="field"><span>${label}</span><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}></label>`).join('') +
    fields.map(([k, label, min, max, step]) =>
    `<label class="field"><span>${label}</span><input type="number" name="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"></label>`).join('');
}

async function renderSettings() {
  const s = await getSettings();
  $('settingsPresence').innerHTML = fieldsHtml(PRESENCE_FIELDS, PRESENCE_CHECKS, s);
  $('settingsTabs').innerHTML = fieldsHtml(TAB_FIELDS, TAB_CHECKS, s);
  $('screenshotExclude').value = s.screenshotExclude || '';
  renderUsage();
}

function readForm(form, fields, checks, patch) {
  const fd = new FormData(form);
  for (const [k, , min, max] of fields) {
    const v = Number(fd.get(k));
    if (fd.get(k) !== '' && !Number.isNaN(v)) patch[k] = Math.min(max, Math.max(min, v));
  }
  for (const [k] of checks) patch[k] = fd.get(k) === 'on';
}

$('save').onclick = async () => {
  const patch = {};
  readForm($('settingsPresence'), PRESENCE_FIELDS, PRESENCE_CHECKS, patch);
  readForm($('settingsTabs'), TAB_FIELDS, TAB_CHECKS, patch);
  patch.screenshotExclude = $('screenshotExclude').value.trim();
  await saveSettings(patch);
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
  $('save').textContent = 'Сохранено ✓';
  setTimeout(() => ($('save').textContent = 'Сохранить настройки'), 1500);
  renderSettings();
};

$('setup').onclick = () => chrome.tabs.create({ url: 'setup.html' });

const strip = ({ id, tabRec, tabId, ...rest }) => rest;

$('export').onclick = async () => {
  const now = Date.now();
  const data = {
    app: 'desk-time-tracker', version: 3, exportedAt: new Date(now).toISOString(), exportedAtMs: now,
    segments: (await db.getAllIn('segments')).map(({ id, ...r }) => r),
    activity: (await db.getAllIn('activity')).map(strip),
    tablog: (await db.getAllIn('tablog')).map(({ id, ...r }) => ({ ...r, end: r.end === Infinity ? null : r.end })),
    settings: await getSettings()
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `desk-time-${toInputDate(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('import').onclick = () => $('importFile').click();

$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  const out = $('importResult');
  try {
    const data = JSON.parse(await file.text());
    const norm = db.normalizeImported(data);
    const mode = $('importMode').value;
    const total = norm.segments.length + norm.activity.length + norm.tablog.length;
    if (mode === 'replace' && !confirm(`История будет заменена данными из файла (${total} записей). Продолжить?`)) return;

    const { added, skipped } = await db.importAll(norm, mode);
    let msg = `Импортировано записей: ${added}.`;
    if (skipped) msg += ` Пропущено (уже есть): ${skipped}.`;
    if (norm.bad) msg += ` Отброшено некорректных: ${norm.bad}.`;

    if ($('importSettings').checked && data.settings && typeof data.settings === 'object') {
      const { enabled, ...rest } = data.settings; // вкл/выкл трекера не переносим
      await saveSettings(rest);
      chrome.runtime.sendMessage({ type: 'settingsChanged' });
      msg += ' Настройки применены.';
    }
    await chrome.storage.local.set({ lastWrite: Date.now() });
    out.innerHTML = `<span style="color:var(--present)">✓ ${esc(msg)}</span>`;
    renderSettings();
  } catch (e) {
    out.innerHTML = `<span style="color:var(--err)">Не удалось импортировать: ${esc(e.message)}</span>`;
  }
};

$('clear').onclick = async () => {
  if (!confirm('Удалить всю историю присутствия и вкладок? Сначала можно сделать экспорт.')) return;
  await db.clearAll();
  await chrome.storage.local.set({ lastWrite: Date.now() });
  renderSettings();
};

$('clearShots').onclick = async () => {
  if (!confirm('Удалить все скриншоты?')) return;
  await db.clearStore('shots');
  renderSettings();
};

async function renderUsage() {
  const [seg, act, tabs, shots] = await Promise.all([db.countIn('segments'), db.countIn('activity'), db.countIn('tablog'), db.shotsStats()]);
  let size = '';
  try { size = ` Всего занято ~${((await navigator.storage.estimate()).usage / 1048576).toFixed(1)} МБ.`; } catch {}
  $('usage').textContent = `Присутствие: ${seg} интервалов · вкладки: ${act} интервалов, ${tabs} в журнале · скриншоты: ${shots.n} (${(shots.bytes / 1048576).toFixed(1)} МБ).${size} Хранилище: IndexedDB, без лимита.`;
}

// ======================= НАВИГАЦИЯ =======================
function renderActive() {
  return { presence: renderPresence, tabs: renderTabs, shots: renderShots, settings: renderSettings }[activeTab]();
}

function renderAll() {
  $('day').value = toInputDate(selected);
  $('dayTitle').textContent = selected.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return renderActive();
}

function showTab(name) {
  if (!['presence', 'tabs', 'shots', 'settings'].includes(name)) name = 'presence';
  activeTab = name;
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  document.querySelectorAll('section').forEach(s => s.classList.toggle('active', s.id === name));
  renderAll();
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
$('prev').onclick = () => { selected = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - 1); renderAll(); };
$('next').onclick = () => { selected = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 1); renderAll(); };
$('today').onclick = () => { selected = new Date(); renderAll(); };
$('day').onchange = () => { const [y, m, d] = $('day').value.split('-').map(Number); selected = new Date(y, m - 1, d); renderAll(); };
$('tabFilter').oninput = () => renderTabs();

// Живое обновление (не чаще раза в 2 с). Галерею перерисовываем только при новом скриншоте.
let pending = null;
chrome.storage.onChanged.addListener((ch) => {
  if (activeTab === 'shots') { if (ch.lastShot && lbIndex < 0) renderShots(); return; }
  if (activeTab === 'settings') return;
  if (!ch.lastWrite || pending) return;
  pending = setTimeout(() => { pending = null; renderActive(); }, 2000);
});

showTab(location.hash.slice(1));
