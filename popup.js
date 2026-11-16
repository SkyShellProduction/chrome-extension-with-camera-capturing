import * as db from './db.js';
import { getSettings, getSegments, computeStats, dayBounds, fmtDur, fmtTime, STATE_LABELS, STATE_COLORS } from './common.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const settings = await getSettings();
  const { currentState, lastError } = await chrome.storage.local.get(['currentState', 'lastError']);
  const state = settings.enabled ? (currentState && currentState !== 'off' ? currentState : null) : 'off';

  $('statusText').textContent = state ? STATE_LABELS[state] : 'Starting…';
  $('statusDot').style.background = STATE_COLORS[state] || '#999';
  $('toggle').textContent = settings.enabled ? 'Turn off' : 'Turn on';
  $('toggle').className = settings.enabled ? '' : 'primary';
  $('calibrate').disabled = !settings.enabled;

  if (lastError) {
    const hint = lastError.kind === 'models'
      ? 'Model files not found. Run the setup-models script in the extension folder and reload the extension.'
      : 'No camera access. Open the setup page and grant permission.';
    $('error').style.display = '';
    $('error').innerHTML = `<b>${hint}</b><br><span class="muted"></span>
      <div style="margin-top:6px"><button id="openSetup">Open setup</button></div>`;
    $('error').querySelector('.muted').textContent = lastError.message;
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
    $('current').textContent = `Current session: ${fmtDur(last.end - last.start)} without a break (since ${fmtTime(last.start)})`;
  } else if (st.sessions.length) {
    $('current').textContent = `Last session ended at ${fmtTime(last.end)}`;
  } else {
    $('current').textContent = settings.enabled ? 'No data for today yet' : '';
  }

  const now = Date.now();
  const acts = (await db.overlapping('activity', from, to))
    .map(a => ({ ...a, start: Math.max(a.start, from), end: Math.min(a.open && now - a.end < 180000 ? now : a.end, to) }))
    .filter(a => a.kind === 'tab' && a.end > a.start);
  const bySite = new Map();
  for (const a of acts) bySite.set(a.domain, (bySite.get(a.domain) || 0) + a.end - a.start);
  const total = acts.reduce((x, a) => x + a.end - a.start, 0);
  const topSite = [...bySite.entries()].sort((a, b) => b[1] - a[1])[0];
  $('browserLine').textContent = total
    ? `In the browser today: ${fmtDur(total)}; most time on ${topSite[0]} (${fmtDur(topSite[1])})`
    : (settings.trackTabs ? 'No tab activity today yet' : '');

  const tbody = $('sessions').querySelector('tbody');
  tbody.innerHTML = st.sessions.length
    ? st.sessions.slice().reverse().map(s => `<tr>
        <td>${fmtTime(s.start)}–${s.open ? 'now' : fmtTime(s.end)}</td>
        <td>${fmtDur(s.end - s.start)}</td>
        <td class="muted">📱 ${fmtDur(s.phone)}</td></tr>`).join('')
    : '<tr><td class="muted">Nothing yet</td></tr>';
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
  const span = document.createElement('span');
  span.style.color = r?.ok ? 'var(--present)' : 'var(--err)';
  span.textContent = r?.ok ? `Screenshot saved (${Math.round(r.size / 1024)} KB)` : (r?.skipped || r?.error || 'Failed');
  $('shotResult').replaceChildren(span);
};

$('calibrate').onclick = () => {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'calibrate' });
  $('calibrate').textContent = 'Look at the screen…';
  $('calibrate').disabled = true;
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'raw') {
    const f = (x) => (x == null ? '—' : x.toFixed(2));
    $('signals').textContent =
      `raw state  : ${STATE_LABELS[msg.raw]}\n` +
      `face found : ${msg.faceFound ? 'yes' : 'no'}\n` +
      `head tilt  : ${f(msg.ratio)} ${msg.headDown ? '(down)' : ''}\n` +
      `eyes down  : ${f(msg.eyeDown)}\n` +
      `phone      : ${f(msg.phoneScore)}\n` +
      `person     : ${f(msg.personScore)}` +
      (msg.calibrating ? '\n\nCALIBRATING… look at the screen' : '');
  }
  if (msg.type === 'calibrated') {
    $('calibrate').textContent = 'Done ✓';
    setTimeout(() => { $('calibrate').textContent = 'Calibrate'; $('calibrate').disabled = false; }, 1500);
  }
  if (msg.type === 'calibrationFailed') {
    $('calibrate').textContent = 'No face found';
    setTimeout(() => { $('calibrate').textContent = 'Calibrate'; $('calibrate').disabled = false; }, 2000);
  }
});

chrome.storage.onChanged.addListener(render);
render();
setInterval(render, 15000);
