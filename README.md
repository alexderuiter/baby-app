# Baby Log

A small installable web app (PWA) for logging a baby's feeds and diapers together with other caregivers.

- Feeds are **sessions**: start a feed, time the left and right breast (tap to switch or pause), add bottle ml,
  then finish with the end time and standard options (how it went, how the baby was). Everything stays editable,
  so a forgotten timer is easy to fix. Past feeds can be entered afterwards.
- One-tap diaper buttons: **Wet / Dirty / Both**
- "Last feed … ago" and "Last diaper … ago" at the top, with the expected next feed and a warning once the
  feeding interval (default 3 hours, from the start of the last feed; change it in settings) has passed
- Day overview: totals, a 24-hour bar and the day's entries; browse back to earlier days
- Shows who logged each entry
- Works offline-first in "this device only" mode; connect Supabase to share between phones live

No build step: plain HTML, CSS and ES modules.

## Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Without Supabase settings it stores everything in the browser's localStorage.

## Share between phones (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql), then the files in `supabase/migrations/` in order.
3. In **Project settings → API**, copy the project URL and the `anon` public key into [`js/config.js`](js/config.js).
4. Host the folder anywhere static over HTTPS (GitHub Pages works: Settings → Pages → deploy from branch).
5. Open the app, tap the gear, and send the invite link to the other caregivers. Opening it joins the same log.

### How sharing works (v1)

Each log ("space") has a long random code. The invite link carries it as `?space=…`; the app then keeps it in
localStorage and sends it as an `x-space-id` header. Row-level security only returns rows whose `space_id`
matches that header, so the code works like a secret share link. Live updates use a Supabase Realtime broadcast
channel per space: whoever changes something pings it, and the other phones reload the list. The list also reloads
whenever the app comes back to the foreground.

This is a placeholder until proper sign-in and invites land: anyone with the link has full access, and there's no
way to revoke it other than starting a new space.

## Install on a phone

- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** menu → Install app

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | UI (light and dark mode) |
| `js/app.js` | Rendering, buttons, sheets |
| `js/store.js` | Data access: local and Supabase backends behind one interface |
| `js/space.js` | Space code, invite links |
| `js/config.js` | Supabase URL and anon key |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA + offline app shell |
| `supabase/schema.sql` | Table and row-level security |
