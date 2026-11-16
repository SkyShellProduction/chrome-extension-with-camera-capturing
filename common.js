import { getRange } from './db.js';

export const DEFAULT_SETTINGS = {
  enabled: false,
  intervalMs: 1000,          // как часто анализировать кадр
  awayDelaySec: 10,          // сколько секунд без человека, чтобы засчитать "ушёл"
  phoneDelaySec: 8,          // сколько секунд с телефоном, чтобы засчитать "в телефоне"
  returnDelaySec: 3,         // сколько секунд нужно, чтобы засчитать возвращение
  minBreakSec: 120,          // отлучка короче этого не считается перерывом
  phoneThreshold: 0.35,      // уверенность детектора телефона
  eyeDownThreshold: 0.55,    // насколько сильно глаза смотрят вниз (0..1)
  baselineRatio: 0.56,       // положение носа на лице при взгляде в экран (задаётся калибровкой)
  pitchDelta: 0.05,          // насколько голова должна опуститься относительно калибровки
  lookDownCountsAsPhone: false, // считать долгий взгляд вниз телефоном, даже если телефон не виден
  keepDays: 365,
  // Вкладки и скриншоты
  trackTabs: true,
  screenshotsEnabled: true,
  screenshotIntervalMin: 10,
  screenshotSkipWhenAway: true,  // не снимать, когда камера видит, что вы отошли
  screenshotMaxWidth: 1280,
  screenshotQuality: 0.6,
  shotsKeepDays: 30,
  screenshotExclude: ''          // домены через пробел/запятую/перенос строки
};

export const STATE_LABELS = {
  present: 'За компьютером',
  phone: 'В телефоне',
  away: 'Отошёл',
  off: 'Выключено'
};

export const STATE_COLORS = {
  present: '#2f9e5b',
  phone: '#e8890c',
  away: '#9aa0a6',
  off: '#5f6368'
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// История лежит в IndexedDB (см. db.js). Возвращает интервалы, пересекающиеся с [from, to)
export function getSegments(from = 0, to = Infinity) {
  return getRange(from, to);
}

export function dayBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return [start, end];
}

// Обрезаем сегменты по границам дня
export function clipSegments(segments, from, to) {
  const out = [];
  for (const seg of segments) {
    const s = Math.max(seg.start, from);
    const e = Math.min(seg.end, to);
    if (e > s) out.push({ s: seg.s, start: s, end: e, open: seg.open });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Главный расчёт: сессии за компьютером, перерывы, телефон
export function computeStats(segments, from, to, minBreakSec) {
  const segs = clipSegments(segments, from, to);
  const totals = { present: 0, phone: 0, away: 0 };
  for (const seg of segs) totals[seg.s] = (totals[seg.s] || 0) + (seg.end - seg.start);

  const minBreak = minBreakSec * 1000;
  const sessions = [];
  let cur = null;
  for (const seg of segs) {
    if (seg.s === 'away') continue;
    const dur = seg.end - seg.start;
    if (cur && seg.start - cur.end < minBreak) {
      cur.end = seg.end;
    } else {
      if (cur) sessions.push(cur);
      cur = { start: seg.start, end: seg.end, present: 0, phone: 0, open: false };
    }
    cur[seg.s] += dur;
    cur.open = !!seg.open;
  }
  if (cur) sessions.push(cur);

  const breaks = [];
  for (let i = 1; i < sessions.length; i++) {
    breaks.push({ start: sessions[i - 1].end, end: sessions[i].start });
  }

  const durations = sessions.map(s => s.end - s.start);
  const atDesk = sessions.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    segments: segs,
    totals,
    sessions,
    breaks,
    atDesk,                                 // время сессий (с короткими отлучками внутри)
    focused: totals.present,                // смотрел в экран
    phone: totals.phone,                    // залипал в телефоне
    longest: durations.length ? Math.max(...durations) : 0,
    average: durations.length ? atDesk / durations.length : 0
  };
}

export function fmtDur(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return ms > 0 ? '<1 мин' : '0 мин';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
