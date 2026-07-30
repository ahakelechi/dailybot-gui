# DailyBot GUI

DailyBot fills in and submits your Daily Log automatically, so you don't
have to click through the account-management portal by hand every day --
now with a simple browser-based control panel instead of editing an Excel
file and running commands.

This is a self-contained fork of the original CLI-only DailyBot: same
underlying automation (`core/`), plus a local web GUI (`server/` +
`public/`) for settings, entries, and running it.

## For someone installing this for the first time

1. Copy this whole `DailyBot-GUI` folder to the new computer.
2. Double-click **`Setup.bat`**. It checks for Node.js, asks for your
   login (or you can skip and add it later), and installs everything
   else automatically. This can take a few minutes the first time.
3. Double-click **`Run DailyBot GUI.bat`**. Your browser opens to the
   control panel automatically at `http://localhost:4287`.

## Using it day to day

- **Settings tab** -- your login email/password for the portal. Saved
  only in this computer's local `.env` file.
- **Daily Entries tab** -- add today's visits (partner, calls, meetings,
  notes) instead of opening an Excel file. Each row disappears once it's
  confirmed submitted. Each entry can also have its own location -- pick
  "Custom coordinates" (or a place from your saved list) if that visit
  happened somewhere different from your default location, otherwise it
  just uses the default from Settings.
- **Run & Reports tab** -- click **Run Now**. A real browser window will
  open and do the actual submitting -- most days you won't need to touch
  it. Some days a login code is sent to your phone/email; when boxes
  appear on screen asking for it, type it into *that* window, not the
  control panel. Progress streams live in the Progress panel, and every
  run leaves a report you can open from the Reports list.

Leave the black terminal window (from `Run DailyBot GUI.bat`) open while
you use the control panel -- closing it stops DailyBot. Closing just the
browser tab is fine; reopen `http://localhost:4287` any time the terminal
window is still running.

## What's different from the original CLI version

- Settings and daily entries are edited through the web page instead of
  `.env` and `data/dailyLog.xlsx` directly (though that spreadsheet still
  exists underneath -- the GUI just reads and writes it for you).
- Everything else -- login handling, OTP waiting, the daily-log form
  filling, retries, screenshots, reports -- is the same engine, unchanged.

## Folder layout

```
DailyBot-GUI/
  core/            the automation engine (login, forms, retries, reports...)
  server/          the local web server the GUI runs on
  public/          the control panel's HTML/CSS/JS
  data/            dailyLog.xlsx -- read/written by the Entries tab
  sessions/        saved login session (per computer, don't copy between PCs)
  logs/, reports/, screenshots/   runtime output
  .env             this computer's login + settings (never copy between PCs)
```

## Deploying to another person's PC

Copy the whole folder **except**:
- `node_modules/` -- reinstalled per machine (`npm install` in Setup.bat).
- `.env` -- contains credentials. Never copy; each person sets up their
  own via Setup.bat or the Settings tab.
- `sessions/` -- a saved login session. Don't reuse one PC's session on
  another.
- `logs/`, `reports/`, `screenshots/`, and any entries in `data/` -- runtime
  output specific to this install.

Each install is independent: its own login, its own entries, its own
reports. They all run the same underlying automation.

## Updating

If your copy already has `Update.bat`, just double-click it -- it pulls
the latest version and reinstalls dependencies if needed, without
touching your login, entries, or reports.

If it's an **older copy that doesn't have `Update.bat` yet**:

- **It's a git clone** (there's a hidden `.git` folder inside it): open a
  terminal in the folder and run:
  ```bash
  git pull
  npm install
  ```
  This also pulls down `Update.bat` itself, so every update after this
  one is back to just double-clicking it.

- **It's a plain folder copy** (a zip someone sent you, no `.git`
  folder): there's no history to pull from, so instead:
  1. Get a fresh copy -- either `git clone
     https://github.com/ahakelechi/dailybot-gui.git` into a new folder,
     or download the ZIP from the repo's green **Code** button on GitHub
     and unzip it as a new folder.
  2. From your **old** folder, copy these into the new one: `.env`,
     `data/dailyLog.xlsx`, `data/locations.json`, and the whole
     `sessions/` folder.
  3. Run `npm install` in the new folder (or double-click `Setup.bat` --
     it detects your existing `.env` and offers to keep it).

## If something goes wrong

- Check the **Progress** panel in the Run tab for the error message.
- Open the newest file in **Reports** for a full summary of what
  succeeded/failed.
- Check the `screenshots/` folder -- a picture is saved automatically at
  the moment anything fails.
- The `logs/` folder has the full detailed history if you need to dig
  deeper.
