# Baby Log

A small installable web app (PWA) for logging a baby's feeds and diapers together with other caregivers.

- Big one-tap buttons: breast **Left / Right**, **Bottle** (with amount), diaper **Wet / Dirty / Both**
- "Last feed … ago" and "Last diaper … ago" at the top, plus a "next" hint for which breast to use
- Today's totals and a timeline of recent entries, with the time since the previous feed/diaper
- Tap an entry to fix its time, amount or add a note, or delete it. Every log has an Undo.
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
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
3. In **Project settings → API**, copy the project URL and the `anon` public key into [`js/config.js`](js/config.js).
4. Host the folder anywhere static over HTTPS (GitHub Pages works: Settings → Pages → deploy from branch).
5. In **Authentication → URL Configuration**, set the **Site URL** to where the app is hosted and add
   `https://<your-site>/**` under **Redirect URLs**, so sign-in links come back to the app.
6. In **Authentication → Email Templates → Magic Link**, add the code to the email, for example
   `<p>Of vul deze code in de app in: <b>{{ .Token }}</b></p>`. On a phone where the app is installed
   on the home screen, the email link opens the browser instead of the app, so the code is the easy way in there.
7. Open the app, sign in with your email, and set up your baby's log. Then open the gear and tap
   **Create invite link** to send to the other caregivers.

Supabase's built-in email sender is limited to a few emails per hour, which is fine for a family.
For more, connect your own SMTP under **Authentication → Emails**.

### How sharing works

- **Sign-in**: email only, no passwords. Supabase emails a link and a 6-digit code.
- **Space**: one baby's log. Whoever sets it up is its owner; the people they invite are caregivers.
  Each caregiver picks the name that is shown next to what they log.
- **Invite links**: any caregiver can make one in settings. A link works for 7 days and can be used by
  whoever it's sent to; open ones can be cancelled from settings. Opening it shows who invited you, then
  asks you to sign in and enter your name.
- **Who logged it**: every entry stores the account that logged it and the name at that moment.
  The timeline shows the caregiver's current name ("by Sam").
- **Access**: row-level security only lets caregivers of a space read or change its entries. The owner can
  remove a caregiver in settings, and caregivers can leave. Removing someone takes away their access right away.
- **Live updates**: the app listens to Postgres changes on the space's entries (Supabase Realtime) and also
  reloads when it comes back to the foreground.

Without Supabase settings the app keeps working as before, on this device only, without sign-in.

## Install on a phone

- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** menu → Install app

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | UI (light and dark mode) |
| `js/app.js` | Rendering, buttons, sheets |
| `js/store.js` | Data access: local and Supabase backends behind one interface |
| `js/cloud.js` | Sign-in, spaces, caregivers and invite links (Supabase) |
| `js/space.js` | Random codes, local space id, safe localStorage |
| `js/config.js` | Supabase URL and anon key |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA + offline app shell |
| `supabase/schema.sql` | Tables, invite functions and row-level security |
