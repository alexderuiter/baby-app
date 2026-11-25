// Data access. Both backends share one interface:
//   list() -> Promise<Entry[]> (newest first)
//   add(entry) -> Promise<Entry>
//   update(id, patch) -> Promise<void>
//   remove(id) -> Promise<void>
//   subscribe(onChange) -> unsubscribe()   onChange fires when another device/tab changed data
//
// Entry: { id, space_id, type: 'feed'|'diaper', kind, amount_ml, note,
//          created_by (name), created_by_user (account id, shared mode), occurred_at, created_at }
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { safeGet, safeSet } from './space.js';

const LIMIT = 300;

export const isShared = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// opts.userId: the signed-in caregiver (shared mode only).
export async function openStore(spaceId, opts) {
  return isShared ? openSupabaseStore(spaceId, opts) : openLocalStore(spaceId);
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
// Needs a signed-in caregiver of the space; row-level security does the access checks.
async function openSupabaseStore(spaceId, { userId } = {}) {
  const { getClient } = await import('./cloud.js');
  const db = await getClient();

  // Live updates: Postgres changes on this space's entries (RLS-filtered by Supabase).
  // Any change just triggers a refetch, which keeps ordering and edits simple.
  const listeners = new Set();
  const channel = db.channel(`entries-${spaceId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'entries', filter: `space_id=eq.${spaceId}` },
      () => listeners.forEach(fn => fn()))
    .subscribe();

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
      // The database stamps new rows with the signed-in account. When Undo restores
      // someone else's entry, keep their name but don't claim their account.
      const { created_by_user, id, created_at, ...rest } = entry;
      const row = { ...rest, space_id: spaceId };
      if (created_by_user && created_by_user !== userId) row.created_by_user = null;
      return check(await db.from('entries').insert(row).select().single());
    },
    async update(id, patch) {
      check(await db.from('entries').update(patch).eq('id', id));
    },
    async remove(id) {
      check(await db.from('entries').delete().eq('id', id));
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    close() { db.removeChannel(channel); },
  };
}
