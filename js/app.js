import { openStore, isShared } from './store.js';
import { currentSpace, newSpaceCode, saveSpace, inviteLink, safeGet, safeSet } from './space.js';

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
    const sub = [e.created_by ? `by ${e.created_by}` : '', e.note].filter(Boolean).join(' · ');
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
    if (isShared) banner('');
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
    const row = await store.add({ created_by: safeGet(NAME_KEY) || null, ...entry });
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
  $('#settings-name').value = safeGet(NAME_KEY) || '';
  $('#share-block').hidden = !isShared;
  $('#local-note').hidden = isShared;
  $('#invite-link').value = inviteLink(store.spaceId);
  $('#settings-dialog').showModal();
}
$('#settings-dialog').addEventListener('close', () => {
  safeSet(NAME_KEY, $('#settings-name').value.trim());
});
$('#copy-invite').addEventListener('click', async () => {
  const link = $('#invite-link').value;
  try {
    if (navigator.share) await navigator.share({ title: 'Baby Log', text: 'Join our baby log', url: link });
    else { await navigator.clipboard.writeText(link); $('#copy-invite').textContent = 'Copied'; }
  } catch {
    $('#invite-link').select();
  }
});

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
  let spaceId = currentSpace();
  if (!spaceId) { spaceId = newSpaceCode(); saveSpace(spaceId); }

  if (!isShared) banner('Saved on this device only. Connect Supabase to share with others.');
  try {
    store = await openStore(spaceId);
  } catch (err) {
    console.error(err);
    banner(`Couldn't connect to the shared log (${err.message}).`, true);
    return;
  }
  store.spaceId = spaceId;
  store.subscribe(refresh);
  await refresh();

  // Keep "x min ago" fresh, and catch up when the phone wakes up or comes online.
  setInterval(render, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('online', refresh);

  if (safeGet(NAME_KEY) === null) openSettings(true);
}

start();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
}
