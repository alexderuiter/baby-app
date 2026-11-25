import { openStore, isShared } from './store.js';
import { currentSpace, newSpaceCode, saveSpace, inviteLink, safeGet, safeSet } from './space.js';

const $ = sel => document.querySelector(sel);
const NAME_KEY = 'babylog.name';
const BOTTLE_KEY = 'babylog.lastBottle';
const INTERVAL_KEY = 'babylog.intervalHours';
const MIN = 60000;
const HOUR = 60 * MIN;

const LABELS = {
  feed: { session: 'Voeding', left: 'Borst · links', right: 'Borst · rechts', bottle: 'Fles' },
  diaper: { wet: 'Natte luier', dirty: 'Poepluier', both: 'Natte luier + poep' },
};
// Standard end-of-feed options. Stored as these keys in entries.tags.
const TAGS_HOW = {
  good: 'Goed gedronken',
  bottle_empty: 'Fles leeg',
  bottle_left: 'Fles niet leeg',
  wanted_more: 'Wilde nog meer',
  satisfied: 'Tevreden',
  spit_up: 'Gespuugd',
  latch: 'Moeite met aanhappen',
};
const TAGS_BABY = {
  sleepy: 'Slaperig',
  alert: 'Actief / alert',
  fussy: 'Onrustig',
  crying: 'Huilerig',
};
const TAG_LABELS = { ...TAGS_HOW, ...TAGS_BABY };

let store;
let entries = [];
let undoTimer;
let dayOffset = 0; // 0 = today, -1 = yesterday, ...

// ---------- formatting ----------
const timeFmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = iso => timeFmt.format(new Date(iso));

function duration(ms) {
  const min = Math.max(0, Math.floor(ms / MIN));
  if (min < 1) return 'zojuist';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}u ${m}m` : `${h}u`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}u`;
}
const ago = iso => {
  const d = duration(Date.now() - new Date(iso));
  return d === 'zojuist' ? d : `${d} geleden`;
};
const clock = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const minutes = sec => Math.round((sec || 0) / 60);

function intervalHours() {
  const v = Number(safeGet(INTERVAL_KEY));
  return v >= 1 && v <= 8 ? v : 3;
}

const isSession = e => e.type === 'feed' && e.kind === 'session';
const isRunning = e => isSession(e) && !e.ended_at;

// Seconds on one breast, including a timer that is still running.
function sideSeconds(e, side) {
  let sec = e[`${side}_sec`] || 0;
  if (e.timer_side === side && e.timer_started_at) {
    sec += Math.max(0, (Date.now() - new Date(e.timer_started_at)) / 1000);
  }
  return sec;
}

function describe(e) {
  if (isSession(e)) {
    const parts = [];
    const l = minutes(sideSeconds(e, 'left'));
    const r = minutes(sideSeconds(e, 'right'));
    if (l) parts.push(`L ${l} min`);
    if (r) parts.push(`R ${r} min`);
    if (e.amount_ml) parts.push(`fles ${e.amount_ml} ml`);
    return parts.length ? `Voeding · ${parts.join(' · ')}` : 'Voeding';
  }
  let text = LABELS[e.type]?.[e.kind] ?? e.kind;
  if (e.amount_ml) text += ` · ${e.amount_ml} ml`;
  return text;
}

function startOfDay(offset = 0) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d;
}

function dayLabel(date) {
  const diff = Math.round((startOfDay() - new Date(new Date(date).setHours(0, 0, 0, 0))) / 86400000);
  if (diff === 0) return 'Vandaag';
  if (diff === 1) return 'Gisteren';
  const s = dayFmt.format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// <input type="datetime-local"> wants local time without a zone.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = value => new Date(value).toISOString();
// Keep the exact original timestamp when the (minute-precision) field was not touched.
const readTime = (input, original) =>
  input.value === input.defaultValue && original ? original : fromLocalInput(input.value);
function setTime(input, iso) {
  input.value = input.defaultValue = iso ? toLocalInput(iso) : '';
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- rendering ----------
const activeSession = () => entries.find(isRunning);
const lastFeed = () => entries.find(e => e.type === 'feed');

function render() {
  renderStatus();
  renderActive();
  renderDay();
}

function renderStatus() {
  const feed = lastFeed();
  const running = feed && isRunning(feed);
  const card = $('#feed-card');
  if (!feed) {
    $('#last-feed-ago').textContent = '–';
    $('#last-feed-detail').textContent = 'Nog niets gelogd';
    $('#next-feed').textContent = '';
  } else if (running) {
    $('#last-feed-ago').textContent = 'Nu bezig';
    $('#last-feed-detail').textContent = `Gestart om ${fmtTime(feed.occurred_at)} (${duration(Date.now() - new Date(feed.occurred_at))})`;
    $('#next-feed').textContent = '';
  } else {
    $('#last-feed-ago').textContent = ago(feed.occurred_at);
    const span = feed.ended_at ? `${fmtTime(feed.occurred_at)}–${fmtTime(feed.ended_at)}` : fmtTime(feed.occurred_at);
    $('#last-feed-detail').textContent = `${span} · ${describe(feed).replace(/^Voeding · /, '')}`;
    const next = new Date(new Date(feed.occurred_at).getTime() + intervalHours() * HOUR);
    $('#next-feed').textContent = `Volgende rond ${timeFmt.format(next)}`;
  }
  const due = feed && !running && Date.now() - new Date(feed.occurred_at) >= intervalHours() * HOUR;
  card.classList.toggle('due', Boolean(due));
  $('#due-banner').hidden = !due;
  if (due) {
    $('#due-banner').textContent =
      `De laatste voeding begon ${duration(Date.now() - new Date(feed.occurred_at))} geleden. Misschien tijd voor een voeding, als de baby eraan toe is.`;
  }

  const diaper = entries.find(e => e.type === 'diaper');
  $('#last-diaper-ago').textContent = diaper ? ago(diaper.occurred_at) : '–';
  $('#last-diaper-detail').textContent = diaper
    ? `${describe(diaper)} om ${fmtTime(diaper.occurred_at)}`
    : 'Nog niets gelogd';
}

function renderActive() {
  const s = activeSession();
  $('#feed-idle').hidden = Boolean(s);
  $('#feed-active').hidden = !s;
  if (!s) return;
  const forgotten = Date.now() - new Date(s.occurred_at) > 3 * HOUR;
  $('#session-since').textContent = forgotten
    ? ` · sinds ${fmtTime(s.occurred_at)}. Vergeten af te ronden? Pas de tijden aan bij het afronden.`
    : ` · sinds ${fmtTime(s.occurred_at)} (${duration(Date.now() - new Date(s.occurred_at))})`;
  for (const side of ['left', 'right']) {
    const on = s.timer_side === side;
    $(`#clock-${side}`).textContent = clock(sideSeconds(s, side));
    $(`#state-${side}`).textContent = on ? '⏸ Pauze' : '▶ Start';
    document.querySelector(`.timer[data-side="${side}"]`).classList.toggle('running', on);
  }
  const chips = $('#session-bottle-chips');
  const presets = bottlePresets();
  const html = [0, ...presets].map(ml =>
    `<button type="button" class="chip" data-ml="${ml}" aria-pressed="${(s.amount_ml || 0) === ml}">${ml ? `${ml} ml` : 'Geen'}</button>`).join('')
    + `<button type="button" class="chip" data-ml="other">Anders…</button>`;
  if (chips.innerHTML !== html) chips.innerHTML = html;
}

function bottlePresets(extra) {
  const last = Number(safeGet(BOTTLE_KEY)) || 90;
  return [...new Set([30, 60, 90, 120, 150, last, extra].filter(Boolean))].sort((a, b) => a - b);
}

function renderDay() {
  const from = startOfDay(dayOffset);
  const to = startOfDay(dayOffset + 1);
  const inDay = e => { const t = new Date(e.occurred_at); return t >= from && t < to; };
  const list = entries.filter(inDay);
  $('#day-title').textContent = dayLabel(from);
  $('#day-next').disabled = dayOffset >= 0;

  // Stats
  const feeds = list.filter(e => e.type === 'feed');
  const sessions = feeds.filter(isSession);
  const leftMin = minutes(sessions.reduce((t, e) => t + sideSeconds(e, 'left'), 0));
  const rightMin = minutes(sessions.reduce((t, e) => t + sideSeconds(e, 'right'), 0));
  const ml = feeds.reduce((t, e) => t + (e.amount_ml || 0), 0);
  const wet = list.filter(e => e.type === 'diaper' && e.kind !== 'dirty').length;
  const dirty = list.filter(e => e.type === 'diaper' && e.kind !== 'wet').length;
  const starts = feeds.map(e => new Date(e.occurred_at).getTime()).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  $('#day-stats').innerHTML = list.length ? [
    stat(feeds.length, feeds.length === 1 ? 'voeding' : 'voedingen'),
    stat(`${leftMin}<small>/</small>${rightMin}`, 'min links/rechts'),
    stat(ml, 'ml fles'),
    stat(avgGap ? duration(avgGap) : '–', 'gem. tussen voedingen'),
    stat(wet, 'nat'),
    stat(dirty, 'poep'),
  ].join('') : '';

  // 24-hour bar: blocks for feeds, ticks for diapers.
  const pct = t => Math.min(100, Math.max(0, ((new Date(t) - from) / (to - from)) * 100));
  const now = new Date();
  let bar = '';
  for (const e of list) {
    if (e.type === 'feed') {
      const end = e.ended_at || (isRunning(e) ? now.toISOString() : new Date(new Date(e.occurred_at).getTime() + 15 * MIN).toISOString());
      const left = pct(e.occurred_at);
      bar += `<span class="blk" style="left:${left}%;width:${Math.max(0.8, pct(end) - left)}%"></span>`;
    } else {
      bar += `<span class="tick ${e.kind}" style="left:${pct(e.occurred_at)}%"></span>`;
    }
  }
  if (dayOffset === 0) bar += `<span class="now" style="left:${pct(now)}%"></span>`;
  bar += ['0', '6', '12', '18'].map(h => `<span class="hour" style="left:${(h / 24) * 100}%">${h}</span>`).join('');
  $('#day-bar').innerHTML = list.length ? bar : '';
  $('#day-bar').hidden = !list.length;

  // List
  $('#timeline-empty').hidden = list.length > 0;
  $('#timeline').innerHTML = list.map(e => {
    const allFeeds = entries.filter(x => x.type === e.type);
    const prev = allFeeds[allFeeds.indexOf(e) + 1];
    const gapMs = prev ? new Date(e.occurred_at) - new Date(prev.occurred_at) : 0;
    const gap = gapMs >= MIN ? `+${duration(gapMs)}` : '';
    const time = isSession(e) && e.ended_at
      ? `${fmtTime(e.occurred_at)}<small>${fmtTime(e.ended_at)}</small>`
      : fmtTime(e.occurred_at);
    const tags = (e.tags || []).map(t => TAG_LABELS[t]).filter(Boolean);
    const sub = [
      isRunning(e) ? 'bezig' : '',
      tags.join(', '),
      e.note,
      e.created_by ? `door ${e.created_by}` : '',
    ].filter(Boolean).join(' · ');
    return `<li><button class="entry ${e.type}" data-id="${escapeHtml(e.id)}">
      <span class="time">${time}</span>
      <span class="dot" aria-hidden="true"></span>
      <span class="what">${escapeHtml(describe(e))}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
      <span class="gap" title="Sinds vorige ${e.type === 'feed' ? 'voeding' : 'luier'}">${gap}</span>
    </button></li>`;
  }).join('');
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
    banner(`Kon de nieuwste gegevens niet laden (${err.message}). Je ziet de laatst bekende stand.`, true);
  }
}

const sortEntries = () => entries.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

async function addEntry(entry) {
  const row = await store.add({ created_by: safeGet(NAME_KEY) || null, ...entry });
  entries = [row, ...entries.filter(e => e.id !== row.id)];
  sortEntries();
  render();
  return row;
}

async function patchEntry(id, patch) {
  await store.update(id, patch);
  entries = entries.map(e => (e.id === id ? { ...e, ...patch } : e));
  sortEntries();
  render();
}

async function removeEntry(entry, label = 'Verwijderd') {
  await store.remove(entry.id);
  entries = entries.filter(e => e.id !== entry.id);
  render();
  toast(label, async () => {
    const { id, created_at, space_id, ...rest } = entry;
    await store.add(rest);
    await refresh();
  });
}

const fail = err => { console.error(err); toast(`Niet opgeslagen: ${err.message}`); };

function flash(btn) {
  btn?.classList.remove('flash');
  void btn?.offsetWidth;
  btn?.classList.add('flash');
  navigator.vibrate?.(15);
}

// ---------- diapers ----------
async function logDiaper(kind, btn) {
  flash(btn);
  try {
    const row = await addEntry({ type: 'diaper', kind });
    toast(`Gelogd: ${describe(row)}`, async () => {
      await store.remove(row.id);
      entries = entries.filter(e => e.id !== row.id);
      render();
    });
  } catch (err) { fail(err); }
}

// ---------- feeding session ----------
// Pause the running breast timer: fold elapsed time into that side's seconds.
function stopTimerPatch(s) {
  if (!s.timer_side || !s.timer_started_at) return {};
  return {
    [`${s.timer_side}_sec`]: Math.round(sideSeconds(s, s.timer_side)),
    timer_side: null,
    timer_started_at: null,
  };
}

async function startSession() {
  flash($('#start-feed'));
  try {
    await addEntry({
      type: 'feed', kind: 'session', occurred_at: new Date().toISOString(),
      ended_at: null, left_sec: 0, right_sec: 0, timer_side: null, timer_started_at: null, tags: [],
    });
  } catch (err) { fail(err); }
}

async function toggleSide(side, btn) {
  const s = activeSession();
  if (!s) return;
  flash(btn);
  const wasOn = s.timer_side === side;
  const patch = stopTimerPatch(s);
  if (!wasOn) {
    patch.timer_side = side;
    patch.timer_started_at = new Date().toISOString();
  }
  try { await patchEntry(s.id, patch); } catch (err) { fail(err); }
}

async function setSessionBottle(value) {
  const s = activeSession();
  if (!s) return;
  let ml = Number(value);
  if (value === 'other') {
    openSession(s.id, 'finish', '#s-ml');
    return;
  }
  if (ml) safeSet(BOTTLE_KEY, String(ml));
  try { await patchEntry(s.id, { amount_ml: ml || null }); } catch (err) { fail(err); }
}

// Session sheet. mode: 'finish' (end running session), 'edit' (existing), 'new' (enter afterwards).
let sheet = null;
function renderTagChips(el, tags, selected) {
  el.innerHTML = Object.entries(tags).map(([key, label]) =>
    `<button type="button" class="chip" data-tag="${key}" aria-pressed="${selected.includes(key)}">${label}</button>`).join('');
}

function syncSessionSheet() {
  const start = $('#s-start').value && new Date($('#s-start').value);
  const end = $('#s-end').value && new Date($('#s-end').value);
  const parts = [];
  if (start && end) {
    if (end < start) parts.push('Einde ligt voor het begin.');
    else parts.push(`Duur: ${duration(end - start).replace('zojuist', '0 min')}`);
  } else if (sheet?.mode === 'edit' && !end) {
    parts.push('Nog bezig. Vul een eindtijd in om af te ronden.');
  }
  $('#s-duration').textContent = parts.join(' ');
  $('#s-ml-chips').querySelectorAll('.chip').forEach(c =>
    c.setAttribute('aria-pressed', String(Number(c.dataset.ml) === Number($('#s-ml').value))));
}

function openSession(id, mode, focus) {
  const s = id ? entries.find(e => e.id === id) : null;
  sheet = { id, mode, original: s };
  const now = new Date().toISOString();
  $('#session-title').textContent =
    mode === 'finish' ? 'Voeding afronden' : mode === 'new' ? 'Eerdere voeding' : 'Voeding bewerken';
  $('#s-save').textContent = mode === 'finish' ? 'Afronden' : 'Opslaan';
  $('#s-delete').hidden = mode === 'new';

  const startIso = s?.occurred_at ?? new Date(Date.now() - 20 * MIN).toISOString();
  const endIso = mode === 'finish' ? now : mode === 'new' ? now : s?.ended_at;
  setTime($('#s-start'), startIso);
  setTime($('#s-end'), endIso);
  $('#s-end').required = mode !== 'edit' || Boolean(s?.ended_at);
  const l = s ? minutes(sideSeconds(s, 'left')) : '';
  const r = s ? minutes(sideSeconds(s, 'right')) : '';
  $('#s-left').value = $('#s-left').defaultValue = l || '';
  $('#s-right').value = $('#s-right').defaultValue = r || '';
  $('#s-ml').value = s?.amount_ml || '';
  $('#s-note').value = s?.note || '';
  $('#s-ml-chips').innerHTML = bottlePresets(s?.amount_ml).map(ml =>
    `<button type="button" class="chip" data-ml="${ml}">${ml} ml</button>`).join('');
  renderTagChips($('#s-tags-how'), TAGS_HOW, s?.tags || []);
  renderTagChips($('#s-tags-baby'), TAGS_BABY, s?.tags || []);
  syncSessionSheet();
  $('#session-dialog').showModal();
  if (focus) $(focus).focus();
}

$('#session-form').addEventListener('input', syncSessionSheet);
$('#s-ml-chips').addEventListener('click', ev => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  $('#s-ml').value = $('#s-ml').value === chip.dataset.ml ? '' : chip.dataset.ml;
  syncSessionSheet();
});
for (const el of [$('#s-tags-how'), $('#s-tags-baby')]) {
  el.addEventListener('click', ev => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    // "Fles leeg" and "Fles niet leeg" exclude each other.
    const other = { bottle_empty: 'bottle_left', bottle_left: 'bottle_empty' }[chip.dataset.tag];
    if (on && other) el.querySelector(`[data-tag="${other}"]`)?.setAttribute('aria-pressed', 'false');
  });
}

$('#session-dialog').addEventListener('close', async () => {
  const action = $('#session-dialog').returnValue;
  const ctx = sheet;
  sheet = null;
  $('#session-dialog').returnValue = '';
  if (!ctx || !action || action === 'cancel') return;
  const s = ctx.original;
  try {
    if (action === 'delete') {
      if (s) await removeEntry(s, 'Voeding verwijderd');
      return;
    }
    const secs = (input, side) => {
      if (input.value === input.defaultValue && s) return Math.round(sideSeconds(s, side));
      return Math.max(0, Math.round(Number(input.value) || 0) * 60);
    };
    const ml = Math.round(Number($('#s-ml').value)) || null;
    if (ml) safeSet(BOTTLE_KEY, String(ml));
    const tags = [...document.querySelectorAll('#s-tags-how .chip, #s-tags-baby .chip')]
      .filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.tag);
    const occurred_at = readTime($('#s-start'), s?.occurred_at);
    let ended_at = $('#s-end').value ? readTime($('#s-end'), s?.ended_at) : null;
    if (ended_at && ended_at < occurred_at) ended_at = occurred_at;
    const data = {
      occurred_at,
      ended_at,
      left_sec: secs($('#s-left'), 'left'),
      right_sec: secs($('#s-right'), 'right'),
      amount_ml: ml,
      tags,
      note: $('#s-note').value.trim() || null,
    };
    // Finishing (or giving an end time) stops any running timer.
    if (ended_at) Object.assign(data, { timer_side: null, timer_started_at: null });
    if (ctx.mode === 'new') {
      await addEntry({ type: 'feed', kind: 'session', timer_side: null, timer_started_at: null, ...data });
      toast('Voeding opgeslagen');
    } else {
      // Keep a running timer running when only editing without an end time.
      if (!ended_at && s.timer_side) {
        const changed = side => $(`#s-${side}`).value !== $(`#s-${side}`).defaultValue;
        if (changed(s.timer_side)) {
          Object.assign(data, { timer_side: null, timer_started_at: null });
        } else {
          data[`${s.timer_side}_sec`] = s[`${s.timer_side}_sec`] || 0;
        }
      }
      await patchEntry(s.id, data);
      toast(ctx.mode === 'finish' ? `Afgerond: ${describe({ ...s, ...data })}` : 'Opgeslagen');
    }
  } catch (err) { fail(err); }
});

// ---------- edit sheet (diapers, old single feeds) ----------
let editing = null;
function openEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  if (isSession(e)) { openSession(id, isRunning(e) ? 'edit' : 'edit'); return; }
  editing = e;
  $('#edit-title').textContent = describe(e);
  setTime($('#edit-time'), e.occurred_at);
  $('#edit-amount-field').hidden = e.kind !== 'bottle';
  $('#edit-amount').value = e.amount_ml ?? '';
  $('#edit-note').value = e.note ?? '';
  $('#edit-dialog').showModal();
}

$('#edit-dialog').addEventListener('close', async () => {
  const action = $('#edit-dialog').returnValue;
  const entry = editing;
  editing = null;
  $('#edit-dialog').returnValue = '';
  if (!entry || action === 'cancel' || !action) return;
  try {
    if (action === 'delete') {
      await removeEntry(entry);
    } else if (action === 'save') {
      const patch = {
        occurred_at: readTime($('#edit-time'), entry.occurred_at),
        note: $('#edit-note').value.trim() || null,
      };
      if (entry.kind === 'bottle') patch.amount_ml = Math.round(Number($('#edit-amount').value)) || null;
      await patchEntry(entry.id, patch);
      toast('Opgeslagen');
    }
  } catch (err) { fail(err); }
});

// ---------- settings sheet ----------
function openSettings(firstRun = false) {
  $('#settings-title').textContent = firstRun ? 'Welcome! Who is logging?' : 'Settings';
  $('#settings-name').value = safeGet(NAME_KEY) || '';
  $('#settings-interval').value = intervalHours();
  $('#share-block').hidden = !isShared;
  $('#local-note').hidden = isShared;
  $('#invite-link').value = inviteLink(store.spaceId);
  $('#settings-dialog').showModal();
}
$('#settings-dialog').addEventListener('close', () => {
  safeSet(NAME_KEY, $('#settings-name').value.trim());
  const hours = Number($('#settings-interval').value);
  if (hours >= 1 && hours <= 8) safeSet(INTERVAL_KEY, String(hours));
  render();
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
document.querySelectorAll('.big-btn[data-type="diaper"]').forEach(btn => {
  btn.addEventListener('click', () => logDiaper(btn.dataset.kind, btn));
});
$('#start-feed').addEventListener('click', startSession);
$('#add-past-feed').addEventListener('click', () => openSession(null, 'new'));
document.querySelectorAll('.timer').forEach(btn => {
  btn.addEventListener('click', () => toggleSide(btn.dataset.side, btn));
});
$('#session-bottle-chips').addEventListener('click', ev => {
  const chip = ev.target.closest('.chip');
  if (chip) setSessionBottle(chip.dataset.ml);
});
$('#session-finish').addEventListener('click', () => {
  const s = activeSession();
  if (s) openSession(s.id, 'finish');
});
$('#session-edit').addEventListener('click', () => {
  const s = activeSession();
  if (s) openSession(s.id, 'edit');
});
$('#session-cancel').addEventListener('click', () => {
  const s = activeSession();
  if (s) removeEntry(s, 'Voeding geannuleerd').catch(fail);
});
$('#settings-btn').addEventListener('click', () => openSettings());
$('#timeline').addEventListener('click', ev => {
  const btn = ev.target.closest('.entry');
  if (btn) openEntry(btn.dataset.id);
});
$('#day-prev').addEventListener('click', () => { dayOffset -= 1; renderDay(); });
$('#day-next').addEventListener('click', () => { dayOffset = Math.min(0, dayOffset + 1); renderDay(); });

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
  // Tick the breast timer every second while a session is running.
  setInterval(() => { if (activeSession() && !document.hidden) { renderActive(); renderStatus(); } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('online', refresh);

  if (safeGet(NAME_KEY) === null) openSettings(true);
}

start();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
}
