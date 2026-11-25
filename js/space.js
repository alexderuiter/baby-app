// Small shared helpers: random codes and storage that never throws.
// In "this device only" mode the log is keyed by a random local space id.
// (Shared mode uses real spaces, caregivers and invite links: see cloud.js.)
const LOCAL_KEY = 'babylog.space';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)

// 31 symbols, rejection-sampled so every symbol is equally likely.
export function randomCode(length = 20) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

export function localSpaceId() {
  const stored = safeGet(LOCAL_KEY);
  if (stored && /^[a-z0-9]{16,64}$/.test(stored)) return stored;
  const code = randomCode();
  safeSet(LOCAL_KEY, code);
  return code;
}

export function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}
export function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
