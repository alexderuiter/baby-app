import { openStore, isShared } from './store.js';
import { localSpaceId, safeGet, safeSet, safeRemove } from './space.js';

const $ = sel => document.querySelector(sel);
const NAME_KEY = 'babylog.name';
const BOTTLE_KEY = 'babylog.lastBottle';
const LABELS = {
  feed: { left: 'Breast · left', right: 'Breast · right', bottle: 'Bottle' },
  diaper: { wet: 'Wet diaper', dirty: 'Dirty diaper', both: 'Wet + dirty diaper' },
};

let store;
let entries = [];
let undoTimer;
let cloud;            // js/cloud.js, loaded in shared mode only
let me = null;        // shared mode: { user, space: { id, name, myName, role }, spaces: [...] }
let members = new Map(); // user_id -> { display_name, role }
let membersLoadedAt = 0;

// Your name: per space in shared mode, per device in local mode.
const myName = () => (me ? me.space.myName : safeGet(NAME_KEY)) || null;

// Who logged an entry: their current name if they're still a caregiver, else the name saved with it.
function nameFor(e) {
  return members.get(e.created_by_user)?.display_name || e.created_by || '';
}

// ---------- formatting ----------
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function duration(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
const ago = iso => {
  const d = duration(Date.now() - new Date(iso));
  return d === 'just now' ? d : `${d} ago`;
};

function describe(e) {
  let text = LABELS[e.type]?.[e.kind] ?? e.kind;
  if (e.amount_ml) text += ` · ${e.amount_ml} ml`;
  return text;
}

function dayLabel(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dayFmt.format(date);
}

// <input type="datetime-local"> wants local time without a zone.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = value => new Date(value).toISOString();

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- rendering ----------
function render() {
  const lastFeed = entries.find(e => e.type === 'feed');
  const lastDiaper = entries.find(e => e.type === 'diaper');

  $('#last-feed-ago').textContent = lastFeed ? ago(lastFeed.occurred_at) : '–';
  $('#last-feed-detail').textContent = lastFeed
    ? `${describe(lastFeed)} at ${timeFmt.format(new Date(lastFeed.occurred_at))}`
    : 'Nothing logged yet';
  $('#last-diaper-ago').textContent = lastDiaper ? ago(lastDiaper.occurred_at) : '–';
  $('#last-diaper-detail').textContent = lastDiaper
    ? `${describe(lastDiaper)} at ${timeFmt.format(new Date(lastDiaper.occurred_at))}`
    : 'Nothing logged yet';

  // Suggest the other breast next time.
  const lastBreast = entries.find(e => e.type === 'feed' && (e.kind === 'left' || e.kind === 'right'));
  $('#hint-left').textContent = lastBreast?.kind === 'right' ? 'next' : '';
  $('#hint-right').textContent = lastBreast?.kind === 'left' ? 'next' : '';

  renderToday();
  renderTimeline();
}

function renderToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = entries.filter(e => new Date(e.occurred_at) >= start);
  if (!today.length) { $('#today').innerHTML = ''; return; }
  const feeds = today.filter(e => e.type === 'feed');
  const ml = feeds.reduce((sum, e) => sum + (e.amount_ml || 0), 0);
  const wet = today.filter(e => e.type === 'diaper' && e.kind !== 'dirty').length;
  const dirty = today.filter(e => e.type === 'diaper' && e.kind !== 'wet').length;
  $('#today').innerHTML = `
    <span class="label">Today so far</span>
    <span><b>${feeds.length}</b> ${feeds.length === 1 ? 'feed' : 'feeds'}${ml ? ` (<b>${ml}</b> ml bottle)` : ''}</span>
    <span><b>${wet}</b> wet</span>
    <span><b>${dirty}</b> dirty</span>`;
}

function renderTimeline() {
  const list = $('#timeline');
  $('#timeline-empty').hidden = entries.length > 0;
  let html = '';
  let currentDay = '';
  entries.forEach((e, i) => {
    const when = new Date(e.occurred_at);
    const day = dayLabel(when);
    if (day !== currentDay) {
      html += `<li class="day">${escapeHtml(day)}</li>`;
      currentDay = day;
    }
    // Time since the previous entry of the same type (helps see feed intervals).
    const prev = entries.slice(i + 1).find(p => p.type === e.type);
    const gapMs = prev ? when - new Date(prev.occurred_at) : 0;
    const gap = gapMs >= 60000 ? `+${duration(gapMs)}` : '';
    const who = nameFor(e);
    const sub = [who ? `by ${who}` : '', e.note].filter(Boolean).join(' · ');
    html += `<li><button class="entry ${e.type}" data-id="${escapeHtml(e.id)}">
      <span class="time">${timeFmt.format(when)}</span>
      <span class="dot" aria-hidden="true"></span>
      <span class="what">${escapeHtml(describe(e))}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
      <span class="gap" title="Since previous ${e.type}">${gap}</span>
    </button></li>`;
  });
  list.innerHTML = html;
}

function banner(text, isError = false) {
  const el = $('#mode-banner');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

function toast(text, onUndo) {
  clearTimeout(undoTimer);
  $('#toast-text').textContent = text;
  const undo = $('#toast-undo');
  undo.hidden = !onUndo;
  undo.onclick = async () => { $('#toast').hidden = true; await onUndo?.(); };
  $('#toast').hidden = false;
  undoTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}

// ---------- data ----------
async function refresh() {
  try {
    entries = await store.list();
    if (isShared) {
      banner('');
      // Someone new joined and logged something: fetch the caregiver list again.
      const unknown = entries.some(e => e.created_by_user && !members.has(e.created_by_user));
      if (unknown && Date.now() - membersLoadedAt > 30000) await loadMembers();
    }
    render();
  } catch (err) {
    console.error(err);
    banner(`Couldn't load the latest entries (${err.message}). Showing what we had.`, true);
  }
}

async function log(entry, sourceBtn) {
  sourceBtn?.classList.remove('flash');
  void sourceBtn?.offsetWidth;
  sourceBtn?.classList.add('flash');
  navigator.vibrate?.(15);
  try {
    const row = await store.add({ created_by: myName(), ...entry });
    entries = [row, ...entries].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    render();
    toast(`Logged: ${describe(row)}`, async () => {
      await store.remove(row.id);
      entries = entries.filter(e => e.id !== row.id);
      render();
    });
  } catch (err) {
    console.error(err);
    toast(`Not saved: ${err.message}`);
  }
}

// ---------- bottle sheet ----------
function openBottle() {
  const last = Number(safeGet(BOTTLE_KEY)) || 90;
  const presets = [...new Set([60, 90, 120, 150, 180, last])].sort((a, b) => a - b);
  const amount = $('#bottle-amount');
  amount.value = last;
  const syncChips = () => $('#bottle-presets').querySelectorAll('.chip')
    .forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.ml) === Number(amount.value))));
  $('#bottle-presets').innerHTML = presets
    .map(ml => `<button type="button" class="chip" data-ml="${ml}">${ml} ml</button>`).join('');
  $('#bottle-presets').onclick = ev => {
    const chip = ev.target.closest('.chip');
    if (chip) { amount.value = chip.dataset.ml; syncChips(); }
  };
  amount.oninput = syncChips;
  syncChips();
  $('#bottle-time').value = $('#bottle-time').defaultValue = toLocalInput(new Date().toISOString());
  $('#bottle-dialog').showModal();
}

$('#bottle-dialog').addEventListener('close', () => {
  const dlg = $('#bottle-dialog');
  if (dlg.returnValue !== 'save') return;
  const ml = Math.round(Number($('#bottle-amount').value));
  if (!ml) return;
  safeSet(BOTTLE_KEY, String(ml));
  // Untouched time field means "now" (the field drops seconds, which would misorder entries).
  const timeInput = $('#bottle-time');
  const occurred_at = timeInput.value === timeInput.defaultValue ? new Date().toISOString() : fromLocalInput(timeInput.value);
  log({ type: 'feed', kind: 'bottle', amount_ml: ml, occurred_at }, $('#bottle-btn'));
});

// ---------- edit sheet ----------
let editing = null;
function openEdit(id) {
  editing = entries.find(e => e.id === id);
  if (!editing) return;
  $('#edit-title').textContent = describe(editing);
  $('#edit-time').value = $('#edit-time').defaultValue = toLocalInput(editing.occurred_at);
  $('#edit-amount-field').hidden = editing.kind !== 'bottle';
  $('#edit-amount').value = editing.amount_ml ?? '';
  $('#edit-note').value = editing.note ?? '';
  $('#edit-dialog').showModal();
}

$('#edit-dialog').addEventListener('close', async () => {
  const action = $('#edit-dialog').returnValue;
  const entry = editing;
  editing = null;
  if (!entry || action === 'cancel' || !action) return;
  try {
    if (action === 'delete') {
      await store.remove(entry.id);
      entries = entries.filter(e => e.id !== entry.id);
      render();
      toast('Entry deleted', async () => {
        const { id, created_at, space_id, ...rest } = entry;
        await store.add(rest);
        await refresh();
      });
    } else if (action === 'save') {
      const patch = {
        occurred_at: $('#edit-time').value === $('#edit-time').defaultValue
          ? entry.occurred_at : fromLocalInput($('#edit-time').value),
        note: $('#edit-note').value.trim() || null,
      };
      if (entry.kind === 'bottle') patch.amount_ml = Math.round(Number($('#edit-amount').value)) || null;
      await store.update(entry.id, patch);
      await refresh();
      toast('Saved');
    }
  } catch (err) {
    console.error(err);
    toast(`Not saved: ${err.message}`);
  }
});

// ---------- settings sheet ----------
function openSettings(firstRun = false) {
  $('#settings-title').textContent = firstRun ? 'Welcome! Who is logging?' : 'Settings';
  $('#settings-name').value = myName() || '';
  $('#share-block').hidden = !isShared;
  $('#local-note').hidden = isShared;
  if (isShared) {
    $('#invite-row').hidden = true;
    $('#make-invite').hidden = false;
    $('#signed-in-as').textContent = me.user.email || 'you';
    renderMembers();
    loadMembers().then(renderMembers).catch(console.error);
    showOpenInvites();
  }
  $('#settings-dialog').showModal();
}

$('#settings-dialog').addEventListener('close', async () => {
  const name = $('#settings-name').value.trim();
  if (!isShared) { safeSet(NAME_KEY, name); render(); return; }
  if (!name || name === me.space.myName) return;
  try {
    await cloud.renameMe(me.space.id, me.user.id, name);
    me.space.myName = name;
    members.set(me.user.id, { ...members.get(me.user.id), display_name: name });
    render();
  } catch (err) {
    console.error(err);
    toast(`Name not saved: ${err.message}`);
  }
});

// ---------- caregivers and invites (shared mode) ----------
async function loadMembers() {
  const rows = await cloud.listMembers(me.space.id);
  membersLoadedAt = Date.now();
  members = new Map(rows.map(r => [r.user_id, r]));
  if (!members.has(me.user.id)) {
    // Removed from this log by its owner: start over (join or create another one).
    cloud.saveSpaceId('');
    location.reload();
  }
}

function renderMembers() {
  $('#members-title').textContent = `Caregivers of ${me.space.name}`;
  const iAmOwner = me.space.role === 'owner';
  $('#member-list').innerHTML = [...members.values()].map(m => {
    const isMe = m.user_id === me.user.id;
    const canRemove = m.role !== 'owner' && (isMe || iAmOwner);
    return `<li>
      <span class="who">${escapeHtml(m.display_name)}${isMe ? ' (you)' : ''}</span>
      ${m.role === 'owner' ? '<span class="role">owner</span>' : ''}
      ${canRemove ? `<button type="button" class="danger" data-remove="${escapeHtml(m.user_id)}">${isMe ? 'Leave' : 'Remove'}</button>` : ''}
    </li>`;
  }).join('');
}

// Removing someone takes two taps (no browser confirm dialogs).
$('#member-list').addEventListener('click', async ev => {
  const btn = ev.target.closest('[data-remove]');
  if (!btn) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to confirm';
    return;
  }
  const userId = btn.dataset.remove;
  btn.disabled = true;
  try {
    await cloud.removeMember(me.space.id, userId);
    if (userId === me.user.id) { cloud.saveSpaceId(''); location.reload(); return; }
    await loadMembers();
    renderMembers();
  } catch (err) {
    console.error(err);
    toast(err.message);
    btn.disabled = false;
  }
});

async function showOpenInvites() {
  try {
    const n = await cloud.countOpenInvites(me.space.id);
    $('#open-invites').hidden = n === 0;
    $('#open-invites-text').textContent = n === 1 ? '1 invite link is still open.' : `${n} invite links are still open.`;
  } catch (err) {
    console.error(err);
  }
}

$('#make-invite').addEventListener('click', async () => {
  const btn = $('#make-invite');
  btn.disabled = true;
  try {
    $('#invite-link').value = await cloud.createInvite(me.space.id);
    $('#invite-row').hidden = false;
    btn.hidden = true;
    $('#copy-invite').textContent = navigator.share ? 'Share' : 'Copy';
    showOpenInvites();
  } catch (err) {
    console.error(err);
    toast(`Couldn't create a link: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#copy-invite').addEventListener('click', async () => {
  const link = $('#invite-link').value;
  try {
    if (navigator.share) await navigator.share({ title: 'Baby Log', text: `Join the baby log for ${me.space.name}`, url: link });
    else { await navigator.clipboard.writeText(link); $('#copy-invite').textContent = 'Copied'; }
  } catch {
    $('#invite-link').select();
  }
});

$('#revoke-invites').addEventListener('click', async () => {
  try {
    await cloud.revokeOpenInvites(me.space.id);
    $('#invite-row').hidden = true;
    $('#make-invite').hidden = false;
    await showOpenInvites();
    toast('Open invite links cancelled');
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
});

$('#sign-out').addEventListener('click', async () => {
  await cloud.signOut().catch(console.error);
  location.reload();
});

// ---------- sign-in / join / create (shared mode) ----------
const EMAIL_KEY = 'babylog.signinEmail';
const GATE_PANELS = ['#gate-signin', '#gate-code', '#gate-join', '#gate-create'];

function showGate(panel) {
  $('#gate').hidden = false;
  document.querySelector('main').hidden = true;
  $('#settings-btn').hidden = true;
  GATE_PANELS.forEach(p => { $(p).hidden = p !== panel; });
  gateError('');
  $(panel)?.querySelector('input')?.focus();
}
function hideGate() {
  $('#gate').hidden = true;
  document.querySelector('main').hidden = false;
  $('#settings-btn').hidden = false;
}
function gateError(text) {
  $('#gate-error').textContent = text || '';
  $('#gate-error').hidden = !text;
}

// Shows a panel and runs handler on submit, with the button disabled while it works.
function onSubmit(panel, handler) {
  const form = $(panel);
  showGate(panel);
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    gateError('');
    try { await handler(); } catch (err) { console.error(err); gateError(err.message); } finally { btn.disabled = false; }
  };
}

async function signInGate() {
  let done;
  const signedIn = new Promise(resolve => { done = resolve; });
  // Magic link opened in another tab of this browser: pick up the session when we're back.
  const unsubscribe = await cloud.onSignIn(done);
  const recheck = async () => { if (!document.hidden) { const u = await cloud.currentUser(); if (u) done(u); } };
  document.addEventListener('visibilitychange', recheck);

  const askEmail = () => onSubmit('#gate-signin', async () => {
    const email = $('#signin-email').value.trim();
    await cloud.sendSignInEmail(email);
    safeSet(EMAIL_KEY, email);
    askCode(email);
  });
  // The code is what works inside an installed app, where the email link opens the browser instead.
  const askCode = email => {
    $('#code-email').textContent = email;
    $('#signin-code').value = '';
    onSubmit('#gate-code', async () => done(await cloud.verifyCode(email, $('#signin-code').value.trim())));
  };
  $('#code-back').onclick = () => { safeRemove(EMAIL_KEY); askEmail(); };

  const sentTo = safeGet(EMAIL_KEY);
  if (sentTo) { $('#signin-email').value = sentTo; askCode(sentTo); } else askEmail();

  const user = await signedIn;
  unsubscribe();
  document.removeEventListener('visibilitychange', recheck);
  safeRemove(EMAIL_KEY);
  return user;
}

// Shows who invited you on every gate screen.
async function describeInvite(token) {
  const info = await cloud.previewInvite(token).catch(() => null);
  const el = $('#gate-invite');
  if (!info) { el.hidden = true; return null; }
  el.textContent = info.usable
    ? `${info.invited_by || 'Someone'} invited you to the baby log for ${info.space_name}.`
    : `This invite to the log for ${info.space_name} has expired. Ask ${info.invited_by || 'them'} for a new link.`;
  el.hidden = false;
  return info;
}

// Resolves with the joined space id, or null to carry on without joining.
async function joinGate(token, spaces) {
  const info = await describeInvite(token);
  const finish = id => { cloud.clearPendingInvite(); $('#gate-invite').hidden = true; return id; };
  if (!info) { finish(null); gateError('That invite link is not valid. Ask for a new one.'); return null; }
  // Already in it: just open it.
  if (spaces.some(s => s.id === info.space_id)) return finish(info.space_id);
  if (!info.usable) { finish(null); return null; }

  return new Promise(resolve => {
    $('#join-title').textContent = `Join the log for ${info.space_name}`;
    $('#join-name').value = spaces[0]?.myName || safeGet(NAME_KEY) || '';
    $('#join-skip').onclick = () => resolve(finish(null));
    onSubmit('#gate-join', async () => {
      const name = $('#join-name').value.trim();
      const id = await cloud.acceptInvite(token, name);
      safeSet(NAME_KEY, name);
      resolve(finish(id));
    });
  });
}

function createGate() {
  return new Promise(resolve => {
    $('#create-name').value = safeGet(NAME_KEY) || '';
    onSubmit('#gate-create', async () => {
      const name = $('#create-name').value.trim();
      const id = await cloud.createSpace($('#create-baby').value.trim(), name);
      safeSet(NAME_KEY, name);
      resolve(id);
    });
  });
}

// Signs in, then picks (or joins, or creates) the space. Returns its id.
async function startShared() {
  cloud = await import('./cloud.js');
  cloud.takeInviteFromUrl();
  const token = cloud.pendingInvite();
  if (token) describeInvite(token);

  const user = (await cloud.currentUser()) || (await signInGate());
  let spaces = await cloud.mySpaces(user.id);

  let spaceId = token ? await joinGate(token, spaces) : null;
  if (!spaceId) {
    const saved = cloud.savedSpaceId();
    spaceId = (spaces.find(s => s.id === saved) || spaces[0])?.id;
  }
  if (!spaceId) spaceId = await createGate();
  if (!spaces.some(s => s.id === spaceId)) spaces = await cloud.mySpaces(user.id);

  cloud.saveSpaceId(spaceId);
  me = { user, spaces, space: spaces.find(s => s.id === spaceId) };
  cloud.onSignOut(() => location.reload());
  await loadMembers();
  hideGate();
  $('.topbar h1').textContent = me.space.name;
  return spaceId;
}

// ---------- wiring ----------
document.querySelectorAll('.big-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => log({ type: btn.dataset.type, kind: btn.dataset.kind }, btn));
});
$('#bottle-btn').addEventListener('click', openBottle);
$('#settings-btn').addEventListener('click', () => openSettings());
$('#timeline').addEventListener('click', ev => {
  const btn = ev.target.closest('.entry');
  if (btn) openEdit(btn.dataset.id);
});

async function start() {
  let spaceId;
  if (isShared) {
    try {
      spaceId = await startShared();
    } catch (err) {
      console.error(err);
      showGate(null);
      gateError(`Couldn't connect (${err.message}). Check your connection and reopen the app.`);
      return;
    }
  } else {
    spaceId = localSpaceId();
    banner('Saved on this device only. Connect Supabase to share with others.');
  }

  try {
    store = await openStore(spaceId, { userId: me?.user.id });
  } catch (err) {
    console.error(err);
    banner(`Couldn't connect to the shared log (${err.message}).`, true);
    return;
  }
  store.subscribe(refresh);
  await refresh();

  // Keep "x min ago" fresh, and catch up when the phone wakes up or comes online.
  setInterval(render, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('online', refresh);

  if (!isShared && safeGet(NAME_KEY) === null) openSettings(true);
}

start();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
}
