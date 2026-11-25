// The "space" is the shared log a group of caregivers writes to.
// v1: identified by a random code that travels in a ?space=CODE link.
const KEY = 'babylog.space';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)

export function newSpaceCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

export function isValidSpaceCode(code) {
  return typeof code === 'string' && /^[a-z0-9]{16,64}$/.test(code);
}

// Reads ?space= from the URL (joining via invite link), else localStorage.
export function currentSpace() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('space');
  if (isValidSpaceCode(fromUrl)) {
    saveSpace(fromUrl);
    url.searchParams.delete('space');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  const stored = safeGet(KEY);
  return isValidSpaceCode(stored) ? stored : null;
}

export function saveSpace(code) { safeSet(KEY, code); }

export function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('space', code);
  return url.toString();
}

export function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}
