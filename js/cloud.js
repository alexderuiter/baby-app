// Everything that talks to Supabase apart from the entries themselves:
// sign-in, spaces (one per baby), caregivers and invite links.
// Only loaded when js/config.js has a Supabase URL and key.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { randomCode, safeGet, safeSet, safeRemove } from './space.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.118.0';
const SPACE_KEY = 'babylog.cloudSpace';
const INVITE_KEY = 'babylog.pendingInvite';

let client;
export async function getClient() {
  if (!client) {
    const { createClient } = await import(SUPABASE_JS);
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}

const check = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// ---------- sign-in ----------
export async function currentUser() {
  const db = await getClient();
  const { data } = await db.auth.getSession();
  return data.session?.user ?? null;
}

// Sends an email with a sign-in link (and a 6-digit code if the email template includes it).
// The link comes back to this page, carrying the pending invite so it also works on another browser.
export async function sendSignInEmail(email) {
  const db = await getClient();
  const back = new URL(location.pathname, location.origin);
  const invite = pendingInvite();
  if (invite) back.searchParams.set('invite', invite);
  check(await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: back.toString(), shouldCreateUser: true },
  }));
}

export async function verifyCode(email, code) {
  const db = await getClient();
  const { data, error } = await db.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) {
    throw new Error(/expired|invalid/i.test(error.message)
      ? 'Deze code klopt niet. Controleer hem, of ga terug en vraag een nieuwe e-mail aan.'
      : error.message);
  }
  return data.user;
}

export async function onSignIn(fn) {
  const db = await getClient();
  const { data } = db.auth.onAuthStateChange((event, session) => {
    if (session?.user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) fn(session.user);
  });
  return () => data.subscription.unsubscribe();
}

export async function onSignOut(fn) {
  const db = await getClient();
  db.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') fn(); });
}

export async function signOut() {
  const db = await getClient();
  safeRemove(SPACE_KEY);
  await db.auth.signOut();
}

// ---------- invite links ----------
// ?invite=TOKEN in the URL is kept until it's accepted, so it survives the sign-in step.
export function takeInviteFromUrl() {
  const url = new URL(location.href);
  const token = url.searchParams.get('invite');
  if (token && /^[a-z0-9]{16,64}$/.test(token)) safeSet(INVITE_KEY, token);
  if (url.searchParams.has('invite')) {
    url.searchParams.delete('invite');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}
export const pendingInvite = () => safeGet(INVITE_KEY);
export const clearPendingInvite = () => safeRemove(INVITE_KEY);

export async function previewInvite(token) {
  const db = await getClient();
  const rows = check(await db.rpc('invite_preview', { invite_token: token }));
  return rows?.[0] ?? null; // { space_id, space_name, invited_by, expires_at, usable }
}

export async function acceptInvite(token, myName) {
  const db = await getClient();
  return check(await db.rpc('accept_invite', { invite_token: token, my_name: myName }));
}

export async function createInvite(spaceId) {
  const db = await getClient();
  const token = randomCode(24);
  check(await db.from('invites').insert({ token, space_id: spaceId }));
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('invite', token);
  return url.toString();
}

export async function revokeOpenInvites(spaceId) {
  const db = await getClient();
  const rows = check(await db.from('invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('space_id', spaceId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('token'));
  return rows.length;
}

export async function countOpenInvites(spaceId) {
  const db = await getClient();
  const { count, error } = await db.from('invites')
    .select('token', { count: 'exact', head: true })
    .eq('space_id', spaceId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// ---------- spaces and caregivers ----------
// The spaces I'm a caregiver in, with my name and role there.
export async function mySpaces(userId) {
  const db = await getClient();
  const rows = check(await db.from('members')
    .select('space_id, display_name, role, joined_at, spaces(name)')
    .eq('user_id', userId)
    .order('joined_at'));
  return rows.map(r => ({
    id: r.space_id, name: r.spaces?.name ?? '', myName: r.display_name, role: r.role,
  }));
}

export async function createSpace(babyName, myName) {
  const db = await getClient();
  return check(await db.rpc('create_space', { baby_name: babyName, my_name: myName }));
}

export const savedSpaceId = () => safeGet(SPACE_KEY);
export const saveSpaceId = id => safeSet(SPACE_KEY, id);

export async function listMembers(spaceId) {
  const db = await getClient();
  return check(await db.from('members')
    .select('user_id, display_name, role, joined_at')
    .eq('space_id', spaceId)
    .order('joined_at'));
}

export async function renameMe(spaceId, userId, name) {
  const db = await getClient();
  check(await db.from('members').update({ display_name: name })
    .eq('space_id', spaceId).eq('user_id', userId));
}

export async function removeMember(spaceId, userId) {
  const db = await getClient();
  const rows = check(await db.from('members').delete()
    .eq('space_id', spaceId).eq('user_id', userId).select('user_id'));
  if (!rows.length) throw new Error('Kon deze verzorger niet verwijderen');
}
