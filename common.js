import { getRange } from './db.js';

export const DEFAULT_SETTINGS = {
  enabled: false,
  intervalMs: 1000,
  awayDelaySec: 10,
  phoneDelaySec: 8,
  returnDelaySec: 3,
  minBreakSec: 120,
  phoneThreshold: 0.35,
  eyeDownThreshold: 0.55,
  baselineRatio: 0.56,   // nose position on the face when looking at the screen (set by calibration)
  pitchDelta: 0.05,
  lookDownCountsAsPhone: false,
  keepDays: 365,
  trackTabs: true,
  screenshotsEnabled: true,
  screenshotIntervalMin: 10,
  screenshotSkipWhenAway: true,
  screenshotMaxWidth: 1280,
  screenshotQuality: 0.6,
  shotsKeepDays: 30,
  screenshotExclude: ''
};

export const STATE_LABELS = {
  present: 'At the computer',
  phone: 'On the phone',
  away: 'Away',
  off: 'Off'
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
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function getSegments(from = 0, to = Infinity) {
  return getRange(from, to);
}

export function dayBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return [start, end];
}

export function clipSegments(segments, from, to) {
  const out = [];
  for (const seg of segments) {
    const s = Math.max(seg.start, from);
    const e = Math.min(seg.end, to);
    if (e > s) out.push({ s: seg.s, start: s, end: e, open: seg.open });
  }
  return out.sort((a, b) => a.start - b.start);
}

// A session is continuous time at the desk; absences shorter than minBreakSec don't break it.
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
    atDesk,
    focused: totals.present,
    phone: totals.phone,
    longest: durations.length ? Math.max(...durations) : 0,
    average: durations.length ? atDesk / durations.length : 0
  };
}

export const LOCALE = 'en-US';

export function fmtDur(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return ms > 0 ? '<1 min' : '0 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
}
