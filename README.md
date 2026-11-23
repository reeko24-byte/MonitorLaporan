# Monitor Laporan

A live wall board for the office. For every Security post and Patrol crew it shows each report the
current shift owes, as green (in), amber (due, inside the grace time), red (missing) or grey (not
due yet). Billy asked for it on 2026-11-19, approved the mockup and said "let's do it" on 2026-11-23.

```
monitor-laporan/
  backend/   Code.gs + appsscript.json   Apps Script: notes in a Google Sheet, photos in Drive, serves the board
  site/      the board page              upload THIS folder's contents to GitHub Pages
  app-hook/  monitor.js + INSTALL.md     the Laporan Tim side; installed only in superapp-laporan2 (see "Status")
```

## Status (2026-11-23, evening)

- **Deployed by Billy (steps 1–3):** the Apps Script answers, the board reads it, and CORS is fine.
  The deployed script is the **notes-only** version. The photo version of `Code.gs` must be pasted in
  and deployed as a *New version* (see "Updating to the photo version").
- **Photos added** (Billy: "add also this"): backend, board and app hook. Tested end to end on this PC
  against a stand-in for Google. Not yet on the real script.
- **The original app is not changed.** The hook (notes + photos) is in the copy `superapp-laporan2`
  (v59), and its `URL_` holds the real `/exec` address. **But the original moved on to v60 the same day
  (Manajemen changes, another session)**, so the copy lacks v60. Don't upload the copy over
  `sec-prabhu` as it stands: rebuild it from v60 first (= v61).
- `site/index.html?demo` shows the board with simulated data and drawn stand-in photos.

## Updating to the photo version (Billy)

1. Paste `backend/Code.gs` over Code.gs in the Apps Script editor and save.
2. Run `setup()` once more. It adds the sheet **Foto** and the Drive folder *Monitor Laporan/Foto*.
   Nothing existing is touched.
3. *Deploy ▸ Manage deployments ▸* (the existing deployment) *▸ Edit ▸ Version: New version ▸ Deploy*.
   **Not** *New deployment*: the address must stay the same.
4. Optional: run `selfTest()`, then delete the TES rows (Catatan, Foto) and the TES file in Foto/YYYY-MM.

## Photos

- After a report's note, the phone sends each photo as a **1024 px copy** (about 100–150 KB, from the
  app's stamped photo), one at a time.
- **Notes always go first.** Photos wait 90 s after the last save so the WhatsApp send has the signal,
  and only go while the app is open on screen. The version line shows *N foto menunggu dikirim*.
- **On Drive:** *Monitor Laporan/Foto/YYYY-MM/*, named `<tanggal>_<shift>_<pos>_<jenis>_<n>dari<m>.jpg`,
  e.g. `2026-11-23_SORE_SORA_Cek19_1dari2.jpg`. Each photo has one row in the sheet **Foto**, linked to its
  note. The files stay private: none is shared.
- **On the board:** a cell's pop-up shows its photos, and a click enlarges one. They are fetched through
  the script only when a pop-up opens (about 3 s). The script serves only files inside the Foto folder,
  and only to the board key.
- **Space:** about 6–10 GB a month for Security + Patrol, against 400 GB on the account. The nightly
  archive moves sheet rows but leaves photo files where they are.

## How it works

1. A guard saves a report in Laporan Tim. Saving happens before WhatsApp opens. With the hook
   installed, the app queues a **note** on the phone: team, kind, post or patrol, zone, shift, shift
   date, hour (checks), checkpoint + Berangkat/Kembali (guard tours), save time, reporter, officers, app
   version and a random device id. **No photos, caption, GPS or findings text.** Security and Patrol only.
2. The phone posts its queue to the Apps Script. A note made with no signal waits on the phone
   (localStorage) and goes out the next time the app is open and online. The server answers with the
   ids it kept. Only those leave the queue, and a repeat is never stored twice.
3. The script appends notes to the sheet **Monitor Laporan — catatan** (in the Drive folder *Monitor
   Laporan* on Billy's account). Rows whose shift is over 35 days old move nightly to
   *Monitor Laporan — arsip YYYY-MM*, so the live sheet stays small (about 1,500 rows a day).
4. The board asks for the shown shift's notes every minute and works out what is owed. It uses the
   app's own lists (`options.js`, `patrol-options.js`), loaded from the app's GitHub Pages address.

## The rules (the spec)

| Team | Owed per shift | Due | Red after |
|---|---|---|---|
| Security, per post | hourly check, start+1 … end−1 (7) | that hour | +30 min |
| | Laporan Shift (serah terima) | end of shift | +30 min |
| | Body Check | end of shift | +30 min |
| Patrol, per patrol | Mulai Shift (KM awal) | start of shift | +30 min |
| | every checkpoint, Berangkat and Kembali | end of shift | +30 min |
| | Akhir Shift (KM akhir) | end of shift | +30 min |

- **Grace** is 30 minutes (Billy, 2026-11-19): `GRACE_MIN` in `site/config.js`.
- **Green** = a note exists. It means the report was saved on the phone. It does *not* prove the
  WhatsApp message went. A note more than 30 min after its due time is green with *telat*.
- **Two phones per post** count together. The first note for an hour wins, and the detail lists both.
- **Checkpoints have no hour.** Their pips stay grey until the end of the shift, then turn red.
  Mulai Shift and body check timing were open questions on the mockup. They stay as above until Billy says otherwise.
- A guard tour at a point not on the list shows as **+N lain** beside the strip. A third visit (*Tambahan*) doesn't count.
- An **incident report** puts a red *KEJADIAN hh:mm* tag on the post or patrol.
- **Shift change.** The board follows the clock, so at 08:00 it moves to PAGI. For the first 2 hours of
  a shift, the previous shift's missing reports stay in *Belum dikirim*, marked *(sebelumnya)*.
  That way MALAM's missing Laporan Shift still turns up at 08:30.
- **Past shifts:** ‹ › in the header. *Langsung* returns to now.
- Old post names are read as the new ones (`SA.canonicalPost`: MENGGALA → MANGGALA BOOSTER). Old
  checkpoint names likewise (`SA.patrolPointName`).

## Setup (Billy, once)

1. **Apps Script.** Go to script.google.com and create a *New project* named `Monitor Laporan`. Paste
   `backend/Code.gs` into Code.gs. In *Project Settings*, tick *Show "appsscript.json"*, then paste
   `backend/appsscript.json` over it. Choose `setup` in the Run box, run it and allow access. The log
   shows the sheet's address and both keys.
2. **Deploy.** *Deploy ▸ New deployment ▸ Web app*: *Execute as: Me*, *Who has access: Anyone*. Copy
   the `/exec` address. **This is the only "New deployment" ever.** For every later code change, use
   *Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version*. A second deployment silently keeps
   serving old code (it happened on ARROW).
3. **Board settings.** In `site/config.js`, set `API_URL` to the `/exec` address. `APP_URL` is already
   Laporan Tim's address, https://reeko24-byte.github.io/sec-prabhu/ (the link the guards use).
4. **GitHub Pages.** Create a new **public** repo `monitor-laporan`, upload the *contents* of `site/`
   (not `backend/`, not `app-hook/`), then *Settings ▸ Pages ▸ Branch: main, / (root)*. Public is safe:
   the repo holds no key.
5. **The board link.** In the script's *Project Settings ▸ Script properties*, add `BOARD_URL` = the
   Pages address. Run `boardLink()`: the log prints the link ending in `#k=…`. Open that link once on
   the office PC. The browser keeps the key and removes it from the address bar. Don't post the link in
   a group: it shows guards' names. To withdraw it, run `newBoardKey()` and open the new link.
6. Run `installArchiveTrigger()` (the nightly archive at 02:00).
7. Optional check: run `selfTest()`. It writes one row for post *TES* and reads it back. Delete that row.
8. When Laporan Tim may change: `app-hook/INSTALL.md`.

## When something is wrong

- **`/exec?action=ping` answers but the board says "Tidak tersambung".** Every call that opens the
  sheet is failing. Check the sheet's owner and that account's Drive storage first (ARROW lost a
  day to this on 21 Oct 2026): the editor keeps working while the web app fails.
- **"Kunci papan tidak cocok"**: the key was changed (`newBoardKey`). Open the new link.
- **Code changed but nothing changed**: there is more than one deployment, or a new version was not
  deployed. See step 2.
- **A post or checkpoint missing on the board**: the board reads the app's lists from `APP_URL`. If
  that address fails, the footer says the board is using its copy in `site/lists/` (app v58,
  23 Nov 2026), which goes stale as the app changes.
- Each Apps Script call takes about 1.8 s whatever the code does (measured on ARROW). The board calls
  once a minute, and the server caches a shift's answer for 45 s.

## Testing without Google

`site/index.html?demo` runs the board on simulated notes, with a time slider and ×60 playback. Every
state is planted: missed, late, just-inside, missing shift report, a patrol with no Mulai Shift, a
point never visited, an incident and an off-list point.

The end-to-end test on 2026-11-23 used two scratch scripts, not kept in this folder. They ran Code.gs
under fake Apps Script services as a local `/exec` and played a phone through `app-hook/monitor.js`.
Results:
- Notes queued offline went out when the phone was back online.
- Repeats were stored once.
- A WT record was not sent.
- A reporter named `=HYPERLINK(…)` was stored as text and shown as text.
- The board matched old post names, tagged the incident and showed *telat*.

## Design

Built with Laporan Tim's own colours and fonts (Barlow, Barlow Condensed, Prabhu green), tuned for a
wall screen:
- **Dark by default**, with a toggle that is remembered.
- **Loud only when something is wrong.** Missing cells are solid red with white text, and a cell
  pulses for its first 10 minutes red. Cells that are in stay quiet green.
- **Every state has an icon** (✓ ⏱ ✗) as well as a colour. Red and green look alike to a
  colour-blind reader.
- **The time sweep.** The signature element is a blue line at the current time, with a soft wake over
  the last hour, sweeping across both boards.

Skills used:
- **ui-ux-pro-max** for the product pattern: status page, timeline, severity colours, and one atomic status line for screen readers.
- **frontend-design** principles for the restraint and the single signature.
- **dataviz** rules: status colours always carry an icon and a label.
