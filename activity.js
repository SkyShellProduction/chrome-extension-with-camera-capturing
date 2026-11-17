// Tab tracking, browser focus and periodic screenshots. Runs in the service worker;
// state that must survive worker unloads lives in chrome.storage.session and IndexedDB.
import * as db from './db.js';
import { getSettings } from './common.js';

const GAP_MS = 3 * 60000; // no update for 3 min means sleep or unload: split the interval
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn).catch(e => console.error('[activity]', e)));

const sget = async (k) => (await chrome.storage.session.get(k))[k];
const sset = (o) => chrome.storage.session.set(o);
const notify = () => chrome.storage.local.set({ lastWrite: Date.now() });

export function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id) return 'Desk Time Tracker';
    return u.hostname || u.protocol.replace(':', '');
  } catch { return ''; }
}
const tabUrl = (t) => t.url || t.pendingUrl || '';

async function isLocked() {
  try { return (await chrome.idle.queryState(60)) === 'locked'; } catch { return false; }
}

// Paused when tracking is off, the screen is locked or the camera says you're away
async function isPaused(s) {
  if (!s.trackTabs) return true;
  if (await isLocked()) return true;
  const { currentState } = await chrome.storage.local.get('currentState');
  return s.enabled && currentState === 'away';
}

async function tabMap() { return (await sget('tabMap')) || {}; }

async function openTabRecord(tab, restored = false) {
  const map = await tabMap();
  if (map[tab.id]) return map[tab.id];
  const url = tabUrl(tab);
  const id = await db.put('tablog', {
    tabId: tab.id, openedAt: Date.now(), closedAt: null, end: Infinity,
    url, title: tab.title || '', domain: domainOf(url), activeMs: 0, pages: 1, restored
  });
  map[tab.id] = id;
  await sset({ tabMap: map });
  return id;
}

async function updateTabRecord(tab) {
  const id = (await tabMap())[tab.id] || await openTabRecord(tab);
  const rec = await db.get('tablog', id);
  if (!rec) return;
  const url = tabUrl(tab);
  if (url && url !== rec.url) { rec.url = url; rec.domain = domainOf(url); rec.pages = (rec.pages || 1) + 1; }
  if (tab.title) rec.title = tab.title;
  await db.put('tablog', rec);
}

async function closeTabRecord(tabId) {
  const map = await tabMap();
  const id = map[tabId];
  if (!id) return;
  const rec = await db.get('tablog', id);
  if (rec) { rec.closedAt = rec.end = Date.now(); await db.put('tablog', rec); }
  delete map[tabId];
  await sset({ tabMap: map });
}

async function finish(rec, at) {
  rec.end = Math.max(rec.start, at);
  rec.open = false;
  await db.put('activity', rec);
  if (rec.kind === 'tab' && rec.tabRec) {
    const t = await db.get('tablog', rec.tabRec);
    if (t) { t.activeMs = (t.activeMs || 0) + (rec.end - rec.start); await db.put('tablog', t); }
  }
  await sset({ cur: null });
}

async function whatIsOnScreen() {
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup'] }); } catch {}
  if (!win || !win.focused || win.state === 'minimized') return { kind: 'blur' };
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab ? { kind: 'tab', tab } : { kind: 'blur' };
}

async function refreshInner() {
  const s = await getSettings();
  const now = Date.now();
  const cur = await sget('cur');
  let rec = cur ? await db.get('activity', cur.id) : null;
  if (rec && !rec.open) rec = null;
  if (rec && now - rec.end > GAP_MS) { await finish(rec, rec.end); rec = null; }

  if (await isPaused(s)) { if (rec) await finish(rec, now); await notify(); return; }

  const target = await whatIsOnScreen();
  const same = rec && rec.kind === target.kind &&
    (target.kind === 'blur' || (rec.tabId === target.tab.id && rec.url === tabUrl(target.tab)));

  if (same) {
    rec.end = now;
    if (target.tab?.title) rec.title = target.tab.title;
    await db.put('activity', rec);
    return;
  }
  if (rec) await finish(rec, now);

  const next = { kind: target.kind, start: now, end: now, open: true, url: '', domain: '', title: '' };
  if (target.kind === 'tab') {
    const t = target.tab;
    next.tabRec = await openTabRecord(t);
    next.tabId = t.id;
    next.url = tabUrl(t);
    next.domain = domainOf(next.url);
    next.title = t.title || '';
  }
  const id = await db.put('activity', next);
  await sset({ cur: { id } });
  await notify();
}

// Runs once per browser session (or after the extension is reloaded)
async function initInner() {
  if (await sget('inited')) return;
  const now = Date.now();
  const { lastAlive = now } = await chrome.storage.local.get('lastAlive');
  const recentlyAlive = now - lastAlive < GAP_MS; // extension reloaded, browser kept running

  const last = await db.lastIn('activity');
  if (last && last.open) await finish(last, last.end);

  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  const openRecs = (await db.overlapping('tablog', now - 1, Infinity)).filter(r => r.end === Infinity);
  const map = {};
  for (const r of openRecs) {
    const t = byId.get(r.tabId);
    if (recentlyAlive && t && tabUrl(t) === r.url) { map[t.id] = r.id; continue; }
    r.closedAt = r.end = Math.max(r.openedAt, Math.min(lastAlive, now));
    await db.put('tablog', r);
  }
  await sset({ tabMap: map, cur: null, inited: true });
  for (const t of tabs) if (!map[t.id]) await openTabRecord(t, true);
}

const run = (fn) => serial(async () => { await initInner(); await fn(); });

// Screenshots
function excluded(domain, list) {
  return String(list || '').split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
    .some(d => domain === d || domain.endsWith('.' + d));
}

// Host permissions only cover http(s) sites; browser pages, the Web Store and (by default) local files are off-limits
async function captureBlockReason(url) {
  let u;
  try { u = new URL(url); } catch { return 'page has no address yet'; }
  if (u.protocol === 'file:') {
    let allowed = false;
    try { allowed = await chrome.extension.isAllowedFileSchemeAccess(); } catch {}
    return allowed ? null : 'local file: enable "Allow access to file URLs" in the extension details to capture these';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `browser page (${url.split(/[?#]/)[0]}) can't be captured`;
  }
  if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) {
    return "the Chrome Web Store can't be captured";
  }
  return null;
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function captureShot({ manual = false } = {}) {
  const s = await getSettings();
  const result = async (r) => { await chrome.storage.local.set({ lastShot: { ts: Date.now(), ...r } }); return r; };

  if (!manual) {
    if (!s.screenshotsEnabled) return result({ skipped: 'disabled' });
    if (await isLocked()) return result({ skipped: 'screen locked' });
    const { currentState } = await chrome.storage.local.get('currentState');
    if (s.screenshotSkipWhenAway && s.enabled && currentState === 'away') return result({ skipped: 'you are away' });
  }

  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch {}
  if (!win || win.state === 'minimized') return result({ skipped: 'browser minimized' });
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab) return result({ skipped: 'no active tab' });
  const url = tabUrl(tab);
  const domain = domainOf(url);
  if (excluded(domain, s.screenshotExclude)) return result({ skipped: `excluded site (${domain})` });
  if (url.startsWith(chrome.runtime.getURL(''))) return result({ skipped: 'extension page is open' });
  const blocked = await captureBlockReason(url);
  if (blocked) return result({ skipped: blocked });

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 90 });
  } catch (e) {
    // Chrome reports any page it won't let extensions capture as an 'activeTab' error
    if (/activeTab|Cannot access|cannot be scripted|permission/i.test(e.message)) {
      return result({ skipped: `this page can't be captured (${domain || url || 'unknown'})` });
    }
    return result({ error: e.message });
  }

  // Downscale and recompress to roughly 100 KB
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scale = Math.min(1, s.screenshotMaxWidth / bmp.width);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: s.screenshotQuality });

  const ts = Date.now();
  const id = await db.put('shots', { ts, url, title: tab.title || '', domain, blob, w, h, size: blob.size, manual });
  await notify();
  return result({ ok: true, id, size: blob.size });
}

export async function scheduleShots() {
  const s = await getSettings();
  const existing = await chrome.alarms.get('shot');
  if (!s.screenshotsEnabled) { if (existing) await chrome.alarms.clear('shot'); return; }
  if (!existing || existing.periodInMinutes !== s.screenshotIntervalMin) {
    await chrome.alarms.create('shot', { delayInMinutes: s.screenshotIntervalMin, periodInMinutes: s.screenshotIntervalMin });
  }
}

export async function prune() {
  const s = await getSettings();
  const now = Date.now();
  await db.deleteBefore('activity', 'end', now - s.keepDays * 86400000);
  await db.deleteBefore('tablog', 'end', now - s.keepDays * 86400000);
  await db.deleteBefore('shots', 'ts', now - s.shotsKeepDays * 86400000);
}

export const refresh = () => run(refreshInner);

// Written after init: initInner uses it to tell a browser restart from an extension reload
const alive = () => chrome.storage.local.set({ lastAlive: Date.now() });

export function tick() {
  return refresh().then(alive);
}

let focusTimer = null;
export function register() {
  chrome.tabs.onCreated.addListener((tab) => run(() => openTabRecord(tab)));
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!change.url && !change.title) return;
    run(async () => { await updateTabRecord(tab); if (tab.active) await refreshInner(); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => run(async () => { await closeTabRecord(tabId); await refreshInner(); }));
  chrome.tabs.onActivated.addListener(() => refresh());
  chrome.tabs.onReplaced.addListener((added, removed) => run(async () => {
    const map = await tabMap();
    if (map[removed]) { map[added] = map[removed]; delete map[removed]; await sset({ tabMap: map }); }
  }));
  // Switching Chrome windows first reports "no focus"; debounce to avoid flicker
  chrome.windows.onFocusChanged.addListener(() => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => refresh(), 600);
  });
}

export function boot() {
  scheduleShots();
  return refresh().then(alive);
}
