import * as db from './db.js';
import { getSettings, getSegments, computeStats, dayBounds, fmtDur, fmtTime, STATE_LABELS, STATE_COLORS } from './common.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const settings = await getSettings();
  const { currentState, lastError } = await chrome.storage.local.get(['currentState', 'lastError']);
  const state = settings.enabled ? (currentState && currentState !== 'off' ? currentState : null) : 'off';

  $('statusText').textContent = state ? STATE_LABELS[state] : 'Запуск…';
  $('statusDot').style.background = STATE_COLORS[state] || '#999';
  $('toggle').textContent = settings.enabled ? 'Выключить' : 'Включить';
  $('toggle').className = settings.enabled ? '' : 'primary';
  $('calibrate').disabled = !settings.enabled;

  if (lastError) {
    const hint = lastError.kind === 'models'
      ? 'Не найдены файлы моделей. Запустите скрипт setup-models из папки расширения и перезагрузите расширение.'
      : 'Нет доступа к камере. Откройте страницу настройки и выдайте разрешение.';
    $('error').style.display = '';
    $('error').innerHTML = `<b>${hint}</b><br><span class="muted">${lastError.message}</span>
      <div style="margin-top:6px"><button id="openSetup">Открыть настройку</button></div>`;
    $('openSetup').onclick = () => chrome.tabs.create({ url: 'setup.html' });
  } else {
    $('error').style.display = 'none';
  }

  const [from, to] = dayBounds();
  const st = computeStats(await getSegments(from, to), from, to, settings.minBreakSec);
  $('atDesk').textContent = fmtDur(st.atDesk);
  $('phone').textContent = st.atDesk ? `${fmtDur(st.phone)} · ${Math.round(st.phone / st.atDesk * 100)}%` : '—';
  $('breaks').textContent = st.breaks.length;
  $('longest').textContent = fmtDur(st.longest);

  const last = st.sessions[st.sessions.length - 1];
  if (last && last.open && state !== 'away') {
    $('current').textContent = `Текущая сессия: ${fmtDur(last.end - last.start)} без перерыва (с ${fmtTime(last.start)})`;
  } else if (st.breaks.length || st.sessions.length) {
    $('current').textContent = last ? `Последняя сессия закончилась в ${fmtTime(last.end)}` : '';
  } else {
    $('current').textContent = settings.enabled ? 'Сегодня данных пока нет' : '';
  }

  // Браузер сегодня: время во вкладках и топ-сайт
  const now = Date.now();
  const acts = (await db.overlapping('activity', from, to))
    .map(a => ({ ...a, start: Math.max(a.start, from), end: Math.min(a.open && now - a.end < 180000 ? now : a.end, to) }))
    .filter(a => a.kind === 'tab' && a.end > a.start);
  const bySite = new Map();
  for (const a of acts) bySite.set(a.domain, (bySite.get(a.domain) || 0) + a.end - a.start);
  const total = acts.reduce((x, a) => x + a.end - a.start, 0);
  const topSite = [...bySite.entries()].sort((a, b) => b[1] - a[1])[0];
  $('browserLine').textContent = total
    ? `В браузере сегодня ${fmtDur(total)}; больше всего — ${topSite[0]} (${fmtDur(topSite[1])})`
    : (settings.trackTabs ? 'Активности во вкладках сегодня пока нет' : '');

  const tbody = $('sessions').querySelector('tbody');
  tbody.innerHTML = st.sessions.length
    ? st.sessions.slice().reverse().map(s => `<tr>
        <td>${fmtTime(s.start)}–${s.open ? 'сейчас' : fmtTime(s.end)}</td>
        <td>${fmtDur(s.end - s.start)}</td>
        <td class="muted">📱 ${fmtDur(s.phone)}</td></tr>`).join('')
    : '<tr><td class="muted">Пока пусто</td></tr>';
}

$('toggle').onclick = async () => {
  const { enabled } = await getSettings();
  $('toggle').disabled = true;
  await chrome.runtime.sendMessage({ type: enabled ? 'stop' : 'start' });
  $('toggle').disabled = false;
  render();
};

$('stats').onclick = () => chrome.tabs.create({ url: 'stats.html' });

$('shot').onclick = async () => {
  $('shot').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'shotNow' });
  $('shot').disabled = false;
  $('shotResult').innerHTML = r?.ok ? `<span style="color:var(--present)">Скриншот сохранён (${Math.round(r.size / 1024)} КБ)</span>`
    : `<span style="color:var(--err)"></span>`;
  if (!r?.ok) $('shotResult').firstChild.textContent = r?.skipped || r?.error || 'Не получилось';
};

$('calibrate').onclick = () => {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'calibrate' });
  $('calibrate').textContent = 'Смотрите в экран…';
  $('calibrate').disabled = true;
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'raw') {
    const f = (x) => (x == null ? '—' : x.toFixed(2));
    $('signals').textContent =
      `сырое состояние : ${STATE_LABELS[msg.raw]}\n` +
      `лицо в кадре    : ${msg.faceFound ? 'да' : 'нет'}\n` +
      `наклон головы   : ${f(msg.ratio)} ${msg.headDown ? '(вниз)' : ''}\n` +
      `глаза вниз      : ${f(msg.eyeDown)}\n` +
      `телефон         : ${f(msg.phoneScore)}\n` +
      `человек         : ${f(msg.personScore)}` +
      (msg.calibrating ? '\n\nКАЛИБРОВКА… смотрите в экран' : '');
  }
  if (msg.type === 'calibrated') {
    $('calibrate').textContent = 'Готово ✓';
    setTimeout(() => { $('calibrate').textContent = 'Калибровка'; $('calibrate').disabled = false; }, 1500);
  }
  if (msg.type === 'calibrationFailed') {
    $('calibrate').textContent = 'Лицо не найдено';
    setTimeout(() => { $('calibrate').textContent = 'Калибровка'; $('calibrate').disabled = false; }, 2000);
  }
});

chrome.storage.onChanged.addListener(render);
render();
setInterval(render, 15000);
