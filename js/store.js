// Data access. Both backends share one interface:
//   list() -> Promise<Entry[]> (newest first)
//   add(entry) -> Promise<Entry>
//   update(id, patch) -> Promise<void>
//   remove(id) -> Promise<void>
//   subscribe(onChange) -> unsubscribe()   onChange fires when another device/tab changed data
//
// Entry: { id, space_id, type: 'feed'|'diaper', kind, amount_ml, note, created_by, occurred_at, created_at }
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { safeGet, safeSet } from './space.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.45.4';
const LIMIT = 300;

export const isShared = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export async function openStore(spaceId) {
  return isShared ? openSupabaseStore(spaceId) : openLocalStore(spaceId);
}

function sortNewestFirst(list) {
  return list.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

// ---------- this-device-only store (localStorage) ----------
function openLocalStore(spaceId) {
  const key = `babylog.entries.${spaceId}`;
  const read = () => {
    try { return JSON.parse(safeGet(key) || '[]'); } catch { return []; }
  };
  const write = list => safeSet(key, JSON.stringify(sortNewestFirst(list).slice(0, 2000)));

  return {
    async list() { return sortNewestFirst(read()).slice(0, LIMIT); },
    async add(entry) {
      const row = {
        id: crypto.randomUUID(),
        space_id: spaceId,
        amount_ml: null, note: null, created_by: null,
        occurred_at: new Date().toISOString(),
        ...entry,
        created_at: new Date().toISOString(),
      };
      write([row, ...read()]);
      return row;
    },
    async update(id, patch) {
      write(read().map(e => (e.id === id ? { ...e, ...patch } : e)));
    },
    async remove(id) {
      write(read().filter(e => e.id !== id));
    },
    subscribe(onChange) {
      const handler = ev => { if (ev.key === key) onChange(); };
      addEventListener('storage', handler);
      return () => removeEventListener('storage', handler);
    },
  };
}

// ---------- shared store (Supabase) ----------
async function openSupabaseStore(spaceId) {
  const { createClient } = await import(SUPABASE_JS);
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { 'x-space-id': spaceId } },
  });

  // Live updates: a broadcast channel per space. Whoever changes data pings it,
  // everyone else refetches. (RLS on the table still guards the data itself.)
  const channel = db.channel(`space-${spaceId}`, { config: { broadcast: { self: false } } });
  const listeners = new Set();
  channel.on('broadcast', { event: 'changed' }, () => listeners.forEach(fn => fn()));
  channel.subscribe();
  const ping = () => channel.send({ type: 'broadcast', event: 'changed', payload: {} }).catch(() => {});

  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async list() {
      return check(await db.from('entries').select('*')
        .eq('space_id', spaceId)
        .order('occurred_at', { ascending: false })
        .limit(LIMIT));
    },
    async add(entry) {
      const row = check(await db.from('entries')
        .insert({ ...entry, space_id: spaceId })
        .select().single());
      ping();
      return row;
    },
    async update(id, patch) {
      check(await db.from('entries').update(patch).eq('id', id));
      ping();
    },
    async remove(id) {
      check(await db.from('entries').delete().eq('id', id));
      ping();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}
