# DAILY PLAYLIST CREATOR

A phone app (web app, add it to the iPhone home screen) that builds the bar's daily Spotify playlist from two
source playlists ("early evening" and "mid evening onward"), plus an automatic run every day at 12:00 Israel time.

- App: https://oribass2907.github.io/daily-playlist-creator/
- `index.html`: the app. `core.js`: the playlist rules (shared by the app and the daily run). `auto.mjs`: the daily run.
- `.github/workflows/daily.yml`: runs `auto.mjs` at 12:00 Israel time. Fridays and Sundays (or whatever days are
  switched off in the app) are skipped. If today's playlist already exists, it is left alone. A manual "create"
  in the app the same day replaces that day's playlist.

## Rules
Length, early/late split, Hebrew share, blend songs, max songs per artist, no duplicate titles, and at most N songs
from the previous playlist (the newest playlist whose name has an earlier date). All set with sliders in the app.

## How settings reach the daily run
The app writes a short settings code at the end of the newest daily playlist's description (after "⚙").
The daily run reads it from there, so whatever was last saved in the app is used.

## Connection for the daily run
In the app, "הפעל יצירה אוטומטית" signs in to Spotify separately, encrypts that sign-in with a random key
(AES-GCM, PBKDF2) and commits it as `tokens/<account>--<time>.json`. The key is stored only as the repository
secret `DPC_KEY`. Spotify requires signing in again every 6 months; the app shows the date.

Spotify app settings: the Redirect URI `https://oribass2907.github.io/daily-playlist-creator/` must be listed.
