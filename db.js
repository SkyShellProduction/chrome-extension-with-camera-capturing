// Хранилище в IndexedDB. Хранилища (object stores):
//  segments — присутствие по камере: { id, s: 'present'|'phone'|'away', start, end, open }
//  activity — что было на экране браузера: { id, kind: 'tab'|'blur', tabRec, url, domain, title, start, end, open }
//             kind 'blur' = браузер свернут / не в фокусе
//  tablog   — жизнь вкладок: { id, tabId, openedAt, closedAt, end, url, title, domain, activeMs, pages, restored }
//             end = closedAt для закрытых и Infinity для открытых (нужно для индекса)
//  shots    — скриншоты: { id, ts, url, title, domain, blob, w, h, size }

const DB_NAME = 'desk-tracker';
const DB_VERSION = 2;
export const VALID_STATES = ['present', 'phone', 'away'];

const SCHEMA = {
  segments: ['start', 'end'],
  activity: ['start', 'end'],
  tablog: ['openedAt', 'end'],
  shots: ['ts']
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [name, indexes] of Object.entries(SCHEMA)) {
        if (db.objectStoreNames.contains(name)) continue;
        const st = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        for (const ix of indexes) st.createIndex(ix, ix);
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    r.onerror = () => { dbPromise = null; reject(r.error); };
  });
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then(v => { result = v; }, e => { try { t.abort(); } catch {} reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Транзакция отменена'));
  });
}

// ---------- универсальные операции ----------
export const put = (store, obj) => tx(store, 'readwrite', st => req(st.put(obj)));
export const get = (store, id) => tx(store, 'readonly', st => req(st.get(id)));
export const del = (store, id) => tx(store, 'readwrite', st => req(st.delete(id)));
export const countIn = (store) => tx(store, 'readonly', st => req(st.count()));
export const clearStore = (store) => tx(store, 'readwrite', st => req(st.clear()));

export async function getAllIn(store) {
  const list = await tx(store, 'readonly', st => req(st.getAll()));
  const key = store === 'tablog' ? 'openedAt' : store === 'shots' ? 'ts' : 'start';
  return list.sort((a, b) => a[key] - b[key]);
}

// Записи-интервалы, пересекающиеся с [from, to)
export async function overlapping(store, from, to) {
  const startKey = store === 'tablog' ? 'openedAt' : 'start';
  const list = await tx(store, 'readonly', st => req(st.index('end').getAll(IDBKeyRange.lowerBound(from, true))));
  return list.filter(x => x[startKey] < to).sort((a, b) => a[startKey] - b[startKey]);
}

// Записи с index в [from, to)
export function inRange(store, index, from, to) {
  return tx(store, 'readonly', st => req(st.index(index).getAll(IDBKeyRange.bound(from, to, false, true))));
}

// Удалить записи, у которых index < cutoff
export function deleteBefore(store, index, cutoff) {
  return tx(store, 'readwrite', st => new Promise((resolve, reject) => {
    let n = 0;
    const r = st.index(index).openCursor(IDBKeyRange.upperBound(cutoff, true));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve(n);
      c.delete(); n++; c.continue();
    };
    r.onerror = () => reject(r.error);
  }));
}

// Последняя по времени начала запись
export function lastIn(store) {
  return tx(store, 'readonly', st => req(st.index('start').openCursor(null, 'prev')).then(c => (c ? c.value : null)));
}

// Байты скриншотов (без загрузки самих картинок в память)
export function shotsStats() {
  return tx('shots', 'readonly', st => new Promise((resolve, reject) => {
    let n = 0, bytes = 0;
    const r = st.openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve({ n, bytes });
      n++; bytes += c.value.size || 0; c.continue();
    };
    r.onerror = () => reject(r.error);
  }));
}

// ---------- совместимость с версией 1.1 (присутствие) ----------
export const getLast = () => lastIn('segments');
export const putSegment = (seg) => put('segments', seg);
export const deleteSegment = (id) => del('segments', id);
export const getRange = (from, to) => overlapping('segments', from, to);
export const getAll = () => getAllIn('segments');
export const count = () => countIn('segments');
export const clearAll = async () => { for (const s of ['segments', 'activity', 'tablog']) await clearStore(s); };
export const deleteOlderThan = (cutoff) => deleteBefore('segments', 'end', cutoff);

// ---------- импорт ----------
const num = (x) => Number(x);
const okInterval = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end > start;

export function normalizeImported(data) {
  const raw = Array.isArray(data) ? data : data?.segments;
  if (!Array.isArray(raw)) throw new Error('В файле нет списка segments');
  const out = { segments: [], activity: [], tablog: [], bad: 0 };

  for (const s of raw) {
    const start = num(s?.start), end = num(s?.end);
    if (!VALID_STATES.includes(s?.s) || !okInterval(start, end)) { out.bad++; continue; }
    out.segments.push({ s: s.s, start, end, open: false });
  }
  for (const a of (Array.isArray(data?.activity) ? data.activity : [])) {
    const start = num(a?.start), end = num(a?.end);
    if (end === start) continue; // пустой интервал (только что начатый) — просто пропускаем
    if (!['tab', 'blur'].includes(a?.kind) || !okInterval(start, end)) { out.bad++; continue; }
    out.activity.push({ kind: a.kind, url: a.url || '', domain: a.domain || '', title: a.title || '', start, end, open: false });
  }
  for (const t of (Array.isArray(data?.tablog) ? data.tablog : [])) {
    const openedAt = num(t?.openedAt);
    const closedAt = t?.closedAt == null ? null : num(t.closedAt);
    if (!Number.isFinite(openedAt)) { out.bad++; continue; }
    // открытые в момент экспорта вкладки считаем закрытыми в момент экспорта
    const end = Number.isFinite(closedAt) ? closedAt : num(data?.exportedAtMs) || openedAt;
    out.tablog.push({
      tabId: t.tabId ?? null, openedAt, closedAt: end, end, url: t.url || '', title: t.title || '',
      domain: t.domain || '', activeMs: num(t.activeMs) || 0, pages: num(t.pages) || 1, restored: !!t.restored
    });
  }
  out.segments.sort((a, b) => a.start - b.start);
  out.activity.sort((a, b) => a.start - b.start);
  return out;
}

// Оставить только интервалы, не пересекающиеся с existing (оба списка отсортированы по start)
function nonOverlapping(list, existing) {
  const starts = existing.map(e => e.start);
  const overlaps = (seg) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < seg.end) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0 && i >= lo - 3; i--) if (existing[i].end > seg.start) return true;
    return false;
  };
  const keep = [];
  let lastEnd = -Infinity, skipped = 0;
  for (const seg of list) {
    if (overlaps(seg) || seg.start < lastEnd) { skipped++; continue; }
    keep.push(seg);
    lastEnd = seg.end;
  }
  return { keep, skipped };
}

async function writeAll(store, list, replace) {
  await tx(store, 'readwrite', async st => {
    if (replace) await req(st.clear());
    for (const x of list) st.put(x);
  });
}

// mode: 'merge' | 'replace'. Возвращает { added, skipped } по всем типам данных
export async function importAll(data, mode) {
  const replace = mode === 'replace';
  let added = 0, skipped = 0;

  for (const store of ['segments', 'activity']) {
    let list = data[store];
    if (!list.length && !(replace && store === 'segments')) continue;
    if (!replace && list.length) {
      const existing = await overlapping(store, list[0].start, list[list.length - 1].end);
      const r = nonOverlapping(list, existing);
      list = r.keep; skipped += r.skipped;
    }
    await writeAll(store, list, replace);
    added += list.length;
  }

  // В режиме "заменить" заменяются только те типы данных, что есть в файле
  if (data.tablog.length) {
    let list = data.tablog;
    if (!replace) {
      const key = (t) => `${t.openedAt}|${t.tabId}|${t.url}`;
      const have = new Set((await getAllIn('tablog')).map(key));
      const before = list.length;
      list = list.filter(t => !have.has(key(t)));
      skipped += before - list.length;
    }
    await writeAll('tablog', list, replace);
    added += list.length;
  }
  return { added, skipped };
}

// Совместимость: импорт только присутствия
export async function importSegments(segments, mode) {
  return importAll({ segments, activity: [], tablog: [] }, mode);
}
