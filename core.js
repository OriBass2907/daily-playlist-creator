// DAILY PLAYLIST CREATOR: the playlist logic, shared by the phone app (index.html) and the daily 12:00 cloud run (auto.mjs).
"use strict";
(function (root) {
const CLIENT_ID = "8708536718354d5eaf1484962c8e5089";
const SCOPES = "playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public";
const API = "https://api.spotify.com/v1";
const DAY_KEYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]; // = Date.getDay()
const WEEKDAYS = ["יום ראשון","יום שני","יום שלישי","יום רביעי","יום חמישי","יום שישי","יום שבת"];
const DEFAULTS = {
  early_playlist: "https://open.spotify.com/playlist/5UorrGgj3rJJRTUhpUonzi",
  late_playlist: "https://open.spotify.com/playlist/0CZKyjDjz2h9uxd8ugTcfL",
  length_minutes: 360, early_percent: 40, hebrew_percent: 55, blend_songs: 4,
  max_songs_per_artist: 5, max_from_yesterday: 10, unique_titles: true,
  skip_days: ["friday","sunday"], new_playlist_name: "{weekday} {date}",
  hebrew_artists: ["Omer Adam","Noa Kirel"], not_hebrew_artists: [], public: false,
  bpm_min: null, bpm_max: null, bpm_rise: false, bpm_start: 95, bpm_end: 125,   // BPM shaping, off by default
  hebrew_blocks: false,   // Hebrew songs in small groups (2-3 in a row) instead of evenly spread
  learn: true, learn_from: ["https://open.spotify.com/playlist/5EcQHirLwlqgFxWRSQLnxD", "https://open.spotify.com/playlist/0awpur3xdWrUBWCpkCCOAY", "https://open.spotify.com/playlist/3OslX3nsRpnDl7UWvPdptC"]   // order songs (inside each part) by the energy curve learned from Ori's example playlists (empty = the two source playlists)
};

// ------------------------------------------------------------ Spotify
async function tokenRequest(data) {
  const r = await fetch("https://accounts.spotify.com/api/token", {method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({...data, client_id: CLIENT_ID})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error("ההתחברות לספוטיפיי נכשלה (" + (j.error_description || j.error || r.status) + ")");
    e.code = j.error; throw e;
  }
  return j;
}

class Spotify {
  constructor(token) { this.token = token; }
  async call(method, path, body) {
    const url = path.startsWith("http") ? path : API + path;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url, {method, headers: {Authorization: "Bearer " + this.token, "Accept-Language": "he",
        ...(body ? {"Content-Type": "application/json"} : {})}, body: body ? JSON.stringify(body) : undefined});
      if (r.status === 429) { await new Promise(res => setTimeout(res, (+r.headers.get("Retry-After") || 3) * 1000 + 1000)); continue; }
      const txt = await r.text();
      if (!r.ok) throw new Error("שגיאה מספוטיפיי " + r.status + ": " + txt.slice(0, 300));
      return txt ? JSON.parse(txt) : {};
    }
    throw new Error("ספוטיפיי עמוס כרגע. נסה שוב בעוד דקה.");
  }
  async playlistTracks(pid) {
    const out = []; let url = `/playlists/${pid}/items?limit=50`;
    while (url) {
      const page = await this.call("GET", url);
      for (const e of page.items || []) {
        const t = e.item || e.track;
        if (t && (t.type || "track") === "track" && (t.uri || "").startsWith("spotify:track:") && !t.is_local)
          out.push({uri: t.uri, name: t.name || "", artist: (t.artists || []).map(a => a.name).join(", "), ms: t.duration_ms || 210000});
      }
      url = page.next;
    }
    return out;
  }
  async myPlaylists() {
    const out = []; let url = "/me/playlists?limit=50";
    while (url) { const p = await this.call("GET", url); out.push(...(p.items || []).filter(Boolean)); url = p.next; }
    return out;
  }
  async setItems(pid, uris) {
    await this.call("PUT", `/playlists/${pid}/items`, {uris: uris.slice(0, 100)});
    for (let i = 100; i < uris.length; i += 100) await this.call("POST", `/playlists/${pid}/items`, {uris: uris.slice(i, i + 100)});
  }
}

function playlistId(ref) {
  ref = String(ref || "").trim();
  const m = ref.match(/playlist[/:]([A-Za-z0-9]{22})/);
  return m ? m[1] : ref;
}

// ------------------------------------------------------------ settings carried in the playlist description
// The daily playlist's description ends with "⚙ " + a short code holding the settings, so the 12:00 cloud run
// uses whatever was last saved in the app. Example: ⚙300/40/30/4/5/10/1/fs/<early id>/<late id>/Omer Adam;Noa Kirel
const DAY_LETTER = {sunday:"s",monday:"m",tuesday:"t",wednesday:"w",thursday:"h",friday:"f",saturday:"a"};
function encodeTag(c) {
  const n = v => v == null ? "-" : String(v);
  const skip = c.skip_days.map(d => DAY_LETTER[d]).join("") || "-";
  const he = (c.hebrew_artists || []).map(a => a.replace(/[;/⚙]/g, "")).join(";");
  let tag = ["⚙" + n(c.length_minutes), n(c.early_percent), n(c.hebrew_percent), n(c.blend_songs), n(c.max_songs_per_artist),
    n(c.max_from_yesterday), c.unique_titles === false ? 0 : 1, skip, playlistId(c.early_playlist), playlistId(c.late_playlist),
    `b${n(c.bpm_min)}-${n(c.bpm_max)}-${c.bpm_rise ? 1 : 0}-${n(c.bpm_start)}-${n(c.bpm_end)}`,
    "L" + (c.learn ? 1 : 0) + ((c.learn_from || []).length ? ":" + c.learn_from.slice(0, 3).map(playlistId).join(".") : ""),
    "H" + (c.hebrew_blocks ? 1 : 0), he].join("/");
  return tag.slice(0, 200);
}
function decodeTag(desc) {
  const text = String(desc || "").replace(/&#x2F;|&#47;/g, "/").replace(/&amp;/g, "&");
  const m = text.match(/⚙\s?([^\n]*)$/);
  if (!m) return null;
  const p = m[1].split("/");
  if (p.length < 10) return null;
  const num = v => v === "-" || v === "" ? null : +v;
  const back = Object.fromEntries(Object.entries(DAY_LETTER).map(([k, v]) => [v, k]));
  const hasB = /^b[\d-]/.test(p[10] || ""), hasL = /^L[01](:[A-Za-z0-9.]*)?$/.test(p[hasB ? 11 : 10] || "");
  const hAt = 10 + (hasB ? 1 : 0) + (hasL ? 1 : 0), hasH = /^H[01]$/.test(p[hAt] || "");
  const heAt = hAt + (hasH ? 1 : 0);
  return {length_minutes: num(p[0]) ?? DEFAULTS.length_minutes, early_percent: num(p[1]) ?? DEFAULTS.early_percent,
    hebrew_percent: num(p[2]), blend_songs: num(p[3]) ?? 0, max_songs_per_artist: num(p[4]), max_from_yesterday: num(p[5]),
    unique_titles: p[6] !== "0", skip_days: p[7] === "-" ? [] : [...p[7]].map(ch => back[ch]).filter(Boolean),
    early_playlist: p[8], late_playlist: p[9], ...bpmField(p[10]), ...learnField(p[hasB ? 11 : 10]), ...(hasH ? {hebrew_blocks: p[hAt] === "H1"} : {}),
    hebrew_artists: (p.slice(heAt).join("/") || "").split(";").map(s => s.trim()).filter(Boolean)};
  function learnField(f) {
    const m = /^L([01])(?::([A-Za-z0-9.]*))?$/.exec(f || "");
    if (!m) return {};
    return {learn: m[1] === "1", learn_from: (m[2] || "").split(".").filter(Boolean)};
  }
  function bpmField(f) {
    const m = /^b([\d-]+?)-([\d-]+?)-([01])-([\d-]+?)-([\d-]+)$/.exec(f || "");
    if (!m) return {};
    return {bpm_min: num(m[1]), bpm_max: num(m[2]), bpm_rise: m[3] === "1", bpm_start: num(m[4]) ?? 95, bpm_end: num(m[5]) ?? 125};
  }
}

// ------------------------------------------------------------ selection (same rules as the Mac version)
const HEBREW = /[֐-׿]/;
const lowerSet = arr => new Set((arr || []).map(a => a.trim().toLowerCase()));
const artistsOf = t => new Set(t.artist.split(",").map(a => a.trim().toLowerCase()).filter(Boolean));

function markHebrew(tracks, c) {
  const yes = lowerSet(c.hebrew_artists), no = lowerSet(c.not_hebrew_artists);
  for (const t of tracks) {
    const as = [...artistsOf(t)];
    t.he = as.some(a => no.has(a)) ? false : (HEBREW.test(t.name + t.artist) || as.some(a => yes.has(a)));
  }
  return tracks;
}

function normTitle(name) {
  let n = name.toLowerCase();
  n = n.replace(/\s[-–]\s.*$/u, "");
  n = n.replace(/[(\[].*?[)\]]/gu, "");
  n = n.replace(/\bfeat\.?.*$|\bft\..*$/u, "");
  n = n.replace(/[^\p{L}\p{N}_\s]/gu, "");
  return n.split(/\s+/).filter(Boolean).join(" ");
}

function rngFrom(seed) { // mulberry32 on a string hash: same day -> same playlist
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle(arr, rng) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

class Taken {
  constructor(c, yesterday) {
    this.uris = new Set(); this.titles = new Set(); this.artists = new Map();
    this.maxArtist = c.max_songs_per_artist; this.unique = c.unique_titles !== false;
    this.yesterday = new Set(yesterday || []); this.maxYesterday = c.max_from_yesterday; this.fromYesterday = 0;
  }
  blocked(t) {
    if (this.uris.has(t.uri)) return true;
    if (this.unique && this.titles.has(normTitle(t.name))) return true;
    if (this.maxYesterday != null && this.yesterday.has(t.uri) && this.fromYesterday >= this.maxYesterday) return true;
    if (this.maxArtist != null) for (const a of artistsOf(t)) if ((this.artists.get(a) || 0) >= this.maxArtist) return true;
    return false;
  }
  add(t) {
    if (this.yesterday.has(t.uri)) this.fromYesterday++;
    this.uris.add(t.uri); this.titles.add(normTitle(t.name));
    for (const a of artistsOf(t)) this.artists.set(a, (this.artists.get(a) || 0) + 1);
  }
}

function pick(pool, budget, rng, taken) {
  const cand = shuffle(pool.filter(t => !taken.uris.has(t.uri)), rng);
  const out = []; let total = 0;
  for (const t of cand) {
    if (total >= budget) break;
    if (taken.blocked(t)) continue;
    out.push(t); taken.add(t); total += t.ms;
  }
  return [out, total];
}

function pickSection(pool, budget, hp, rng, taken) {
  if (hp == null) return pick(pool, budget, rng, taken);
  let [he, gotHe] = pick(pool.filter(t => t.he), budget * hp / 100, rng, taken);
  let [other, gotOther] = pick(pool.filter(t => !t.he), budget - gotHe, rng, taken);
  if (gotHe + gotOther < budget) {
    const [extra, gotExtra] = pick(pool, budget - gotHe - gotOther, rng, taken);
    for (const t of extra) (t.he ? he : other).push(t);
    gotOther += gotExtra;
  }
  const out = []; let i = 0, j = 0; const total = he.length + other.length;
  for (let k = 0; k < total; k++) {
    const wantHe = j >= other.length || (i < he.length && (i + 1) / he.length <= (k + 1) / total + 1e-9);
    if (wantHe && i < he.length) out.push(he[i++]); else out.push(other[j++]);
  }
  return [out, gotHe + gotOther];
}

function noArtistBackToBack(tracks) {
  tracks = tracks.slice();
  for (let i = 1; i < tracks.length; i++) {
    if (tracks[i].artist !== tracks[i - 1].artist) continue;
    for (let j = i + 1; j < tracks.length; j++)
      if (tracks[j].artist !== tracks[i - 1].artist && tracks[j].he === tracks[i].he) { [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; break; }
  }
  return tracks;
}

// ------------------------------------------------------------ BPM (free ReccoBeats database; Spotify closed its own in 2024)
const bpmOn = c => c.bpm_min != null || c.bpm_max != null || !!c.bpm_rise;
async function fetchTempos(tracks, step) {
  const ids = [...new Set(tracks.map(t => t.uri.split(":")[2]))], out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    step && step(`בודק BPM… ${Math.min(i + 40, ids.length)}/${ids.length}`);
    try {
      const r = await fetch("https://api.reccobeats.com/v1/audio-features?ids=" + ids.slice(i, i + 40).join(","));
      if (!r.ok) continue;
      for (const x of (await r.json()).content || []) {
        const m = /track\/([A-Za-z0-9]{22})/.exec(x.href || "");
        if (m && x.tempo) out.set(m[1], x);
      }
    } catch (e) { /* missing BPM just means "unknown" */ }
  }
  for (const t of tracks) {
    const f = out.get(t.uri.split(":")[2]); if (!f) continue;
    t.bpm = f.tempo; t.energy = f.energy;
    t.lift = liftOf(f);
  }
}
// "How lifted" a song feels: energetic, danceable, not acoustic. 0 = calm and soft, 1 = peak of the night.
function liftOf(f) {
  if (f.energy == null) return null;
  const v = x => x == null ? 0.5 : x;
  return 0.5 * f.energy + 0.3 * v(f.danceability) + 0.2 * (1 - v(f.acousticness));
}

// ------------------------------------------------------------ learning the evening from example playlists
// Each example playlist (in its own order) shows how the energy moves through an evening. For every song we take how
// lifted it is compared with the rest of that playlist (0 = calmest, 1 = most lifted) and where it sits (0 = start, 1 = end),
// average that over all examples in 10 steps, and smooth it. The new playlist is then ordered to follow that curve.
const STEPS = 10;
function learnCurve(evenings) {
  const sum = Array(STEPS).fill(0), cnt = Array(STEPS).fill(0);
  let used = 0;
  for (const ev of evenings) {
    const known = ev.map((t, i) => ({i, l: t.lift})).filter(x => x.l != null);
    if (known.length < 8) continue;
    used++;
    const ranks = known.slice().sort((a, b) => a.l - b.l);
    ranks.forEach((x, r) => x.r = r / (ranks.length - 1));
    for (const x of known) { const b = Math.min(STEPS - 1, Math.floor(STEPS * x.i / ev.length)); sum[b] += x.r; cnt[b]++; }
  }
  if (!used) return null;
  const raw = sum.map((s, b) => cnt[b] ? s / cnt[b] : null);
  for (let b = 0; b < STEPS; b++) if (raw[b] == null) raw[b] = raw[b - 1] ?? raw.find(v => v != null);
  const curve = raw.map((v, b) => { const w = [raw[b - 1], v, raw[b + 1]].filter(x => x != null); return w.reduce((a, x) => a + x, 0) / w.length; });
  return {curve, playlists: used};
}
const curveAt = (curve, f) => { const x = Math.max(0, Math.min(STEPS - 1, f * STEPS - 0.5)), i = Math.floor(x), k = x - i; return curve[i] * (1 - k) + (curve[Math.min(STEPS - 1, i + 1)]) * k; };
// Order one part of the evening (covering fractions from..to of the night) so its songs follow the curve:
// the calmest songs go where the curve is lowest. Unknown songs are spread evenly.
function curveOrder(tracks, curve, from, to) {
  const known = tracks.filter(t => t.lift != null).sort((a, b) => a.lift - b.lift), unknown = tracks.filter(t => t.lift == null);
  const n = tracks.length, slots = [];
  if (!n) return tracks;
  const every = unknown.length ? n / unknown.length : Infinity; let next = every / 2;
  for (let i = 0; i < n; i++) { if (unknown.length && i >= next && slots.filter(s => s.u).length < unknown.length) { slots.push({i, u: true}); next += every; } else slots.push({i}); }
  const free = slots.filter(s => !s.u);
  while (free.length > known.length) { const s = free.pop(); s.u = true; }   // only if rounding left too few unknown slots
  const out = Array(n);
  free.map(s => ({s, v: curveAt(curve, from + (to - from) * (s.i + 0.5) / n)})).sort((a, b) => a.v - b.v).forEach((x, k) => out[x.s.i] = known[k]);
  slots.filter(s => s.u).forEach((s, k) => out[s.i] = unknown[k]);
  return out.filter(Boolean);
}
function describeCurve(curve) {
  const word = v => v < 0.35 ? "רגוע" : v < 0.55 ? "נעים" : v < 0.7 ? "עולה" : "בשיא";
  const peak = curve.indexOf(Math.max(...curve));
  return `מתחיל ${word(curve[0])}, באמצע ${word(curve[4])}, בסוף ${word(curve[STEPS - 1])} (השיא בערך ב־${Math.round(100 * (peak + 0.5) / STEPS)}% מהערב)`;
}
// Half/double-time readings are common (73 vs 146): use whichever reading fits the wanted range/curve.
function readings(t) { return [t.bpm, t.bpm / 2, t.bpm * 2]; }
function fitsRange(t, c) {
  if (t.bpm == null) return true;  // unknown BPM: keep it, it is placed by its part of the evening
  const lo = c.bpm_min ?? 0, hi = c.bpm_max ?? 999;
  const ok = readings(t).find(b => b >= lo && b <= hi);
  if (ok == null) return false;
  t.bpm = ok; return true;
}
// Rising BPM: each part of the evening keeps songs near its own BPM band (unknown BPM is kept),
// then the part is sorted slow to fast, with the unknown-BPM songs spread evenly through it.
const BAND_SLACK = 8;
function inBand(t, lo, hi) {
  if (t.bpm == null) return true;
  const r = readings(t).find(b => b >= lo - BAND_SLACK && b <= hi + BAND_SLACK);
  if (r == null) return false;
  t.bpm = r; return true;
}
function riseOrder(tracks) {
  const known = tracks.filter(t => t.bpm != null).sort((a, b) => a.bpm - b.bpm), unknown = tracks.filter(t => t.bpm == null);
  if (!unknown.length) return known;
  const out = [], every = tracks.length / unknown.length; let next = every / 2;
  while (known.length || unknown.length) {
    if (unknown.length && (out.length >= next || !known.length)) { out.push(unknown.shift()); next += every; }
    else out.push(known.shift());
  }
  return out;
}

// Hebrew in groups: Hebrew songs come in runs of 2-3 (never more than 3), with the other songs between the runs.
// Each language keeps its own order, so the evening's energy order stays almost the same.
function hebrewBlocks(tracks, max = 3) {
  const he = tracks.filter(t => t.he), other = tracks.filter(t => !t.he);
  if (he.length < 2) return tracks;
  const k = Math.ceil(he.length / max);
  if (other.length < k - 1) return tracks;          // not enough other songs to separate the groups
  const sizes = Array.from({length: k}, (_, i) => Math.floor(he.length / k) + (i < he.length % k ? 1 : 0));
  // k+1 gaps of other songs (before, between, after); the inner gaps get at least one song
  const gaps = Array(k + 1).fill(0); let left = other.length;
  for (let i = 1; i < k; i++) { gaps[i] = 1; left--; }
  for (let i = 0; left > 0; i = (i + 1) % (k + 1)) { gaps[i]++; left--; }
  const out = []; let h = 0, o = 0;
  for (let i = 0; i <= k; i++) {
    for (let g = 0; g < gaps[i]; g++) out.push(other[o++]);
    if (i < k) for (let z = 0; z < sizes[i]; z++) out.push(he[h++]);
  }
  return out;
}

function build(earlyPool, latePool, c, yesterday, todayIso, curve) {
  if (c.bpm_min != null || c.bpm_max != null) { earlyPool = earlyPool.filter(t => fitsRange(t, c)); latePool = latePool.filter(t => fitsRange(t, c)); }
  if (c.bpm_rise) {
    const split = c.bpm_start + (c.bpm_end - c.bpm_start) * c.early_percent / 100;
    earlyPool = earlyPool.filter(t => inBand(t, Math.min(c.bpm_start, split), Math.max(c.bpm_start, split)));
    latePool = latePool.filter(t => inBand(t, Math.min(split, c.bpm_end), Math.max(split, c.bpm_end)));
  }
  const rng = rngFrom(todayIso + c._name);
  const totalMs = c.length_minutes * 60000, earlyMs = totalMs * c.early_percent / 100;
  const taken = new Taken(c, yesterday), hp = c.hebrew_percent;
  let [early, gotEarly] = pickSection(earlyPool, earlyMs, hp, rng, taken);
  let [late, gotLate] = pickSection(latePool, totalMs - gotEarly, hp, rng, taken);
  early = noArtistBackToBack(early); late = noArtistBackToBack(late);
  if (curve) {   // learned evening wins over the BPM rise; then fix back-to-back artists only where it is free
    const e = c.early_percent / 100;
    early = noArtistBackToBack(curveOrder(early, curve, 0, e)); late = noArtistBackToBack(curveOrder(late, curve, e, 1));
  } else if (c.bpm_rise) {   // after the artist reshuffle, so the rise wins; then fix back-to-back artists only where it is free
    const down = c.bpm_end < c.bpm_start;
    early = riseOrder(early); late = riseOrder(late);
    if (down) { early.reverse(); late.reverse(); }
    early = noArtistBackToBack(early); late = noArtistBackToBack(late);
  }
  if (c.hebrew_blocks && c.hebrew_percent != null) { early = noArtistBackToBack(hebrewBlocks(early)); late = noArtistBackToBack(hebrewBlocks(late)); }
  const n = Math.min(c.blend_songs || 0, early.length, late.length), blend = [];
  if (n) {
    const tail = early.slice(-n), head = late.slice(0, n);
    tail.forEach((a, k) => blend.push(a, head[k]));
    early = early.slice(0, -n); late = late.slice(n);
  }
  const result = [...early, ...blend, ...late], warnings = [];
  if (gotEarly < earlyMs * .95) warnings.push(`פלייליסט תחילת הערב קצר מדי: ${Math.floor(gotEarly / 60000)} מתוך ${Math.floor(earlyMs / 60000)} דקות.`);
  if (gotEarly + gotLate < totalMs * .95) warnings.push(`יצא קצר: ${Math.floor((gotEarly + gotLate) / 60000)} מתוך ${c.length_minutes} דקות. הוסף שירים לפלייליסטי המקור או הגדל את מקסימום השירים לאמן.`);
  if (hp != null && result.length) {
    const real = 100 * result.filter(t => t.he).reduce((s, t) => s + t.ms, 0) / result.reduce((s, t) => s + t.ms, 0);
    if (Math.abs(real - hp) > 5) warnings.push(`אחוז העברית יצא ${Math.round(real)}% במקום ${hp}%: אין מספיק שירים ${real < hp ? "בעברית" : "לועזיים"} שעומדים בכללים.`);
  }
  return [result, warnings];
}

// ------------------------------------------------------------ dates (always Israel time, also in the cloud)
const pad = n => String(n).padStart(2, "0");
function israelNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short"}).formatToParts(new Date()).map(x => [x.type, x.value]));
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday);
  return {iso: `${p.year}-${p.month}-${p.day}`, stamp: `${p.day}.${p.month}.${p.year}`, dow, hour: +p.hour % 24, minute: +p.minute};
}
const playlistName = (c, d) => c.new_playlist_name.replace("{weekday}", WEEKDAYS[d.dow]).replace("{date}", d.stamp);
const isSkipDay = (c, d) => c.skip_days.includes(DAY_KEYS[d.dow]);

function datedPlaylists(mine) {
  return mine.map(p => { const m = (p.name || "").match(/(\d{2})\.(\d{2})\.(\d{4})/); return m && {...p, iso: `${m[3]}-${m[2]}-${m[1]}`}; })
    .filter(Boolean).sort((a, b) => b.iso.localeCompare(a.iso));
}

// ------------------------------------------------------------ one run
// opts: {dry, onlyIfMissing, step(text)}. Returns {tracks, warnings, link, dry, existed}.
async function run(c, token, opts = {}) {
  const step = opts.step || (() => {}), d = israelNow(), sp = new Spotify(token);
  step("מחפש את הפלייליסט הקודם…");
  const mine = await sp.myPlaylists(), name = playlistName(c, d), todays = mine.find(p => p.name === name);
  if (opts.onlyIfMissing && todays) return {existed: true, link: "https://open.spotify.com/playlist/" + todays.id, tracks: [], warnings: []};
  const prev = datedPlaylists(mine).find(p => p.iso < d.iso);
  const yesterday = prev ? (await sp.playlistTracks(prev.id)).map(t => t.uri) : [];
  step("קורא את פלייליסטי המקור…");
  const earlyPool = markHebrew(await sp.playlistTracks(playlistId(c.early_playlist)), c);
  const latePool = markHebrew(await sp.playlistTracks(playlistId(c.late_playlist)), c);
  if (!earlyPool.length && !latePool.length) throw new Error("שני פלייליסטי המקור ריקים. הם צריכים להיות פלייליסטים שלך או שאתה שותף בהם.");
  let learned = null;
  const refs = [];
  if (c.learn && (c.learn_from || []).length) {
    step("קורא את הפלייליסטים ללמידה…");
    for (const u of c.learn_from) { try { refs.push(await sp.playlistTracks(playlistId(u))); } catch (e) { /* skip a playlist we can't read */ } }
  }
  if (bpmOn(c) || c.learn) await fetchTempos([...earlyPool, ...latePool, ...refs.flat()], step);
  if (c.learn) {
    // no examples given: the two source playlists, back to back, are one evening
    learned = learnCurve(refs.length ? refs : [[...earlyPool, ...latePool]]);
  }
  step("בונה פלייליסט…");
  const [tracks, warnings] = build(earlyPool, latePool, c, yesterday, d.iso, learned && learned.curve);
  if (c.learn && (c.learn_from || []).length && !refs.some(r => r.length)) warnings.push("לא הצלחתי לקרוא את הפלייליסטים ללמידה (הם צריכים להיות שלך או שאתה שותף בהם), אז למדתי מפלייליסטי המקור.");
  if (c.learn && !learned) warnings.push("לא היה מספיק מידע על השירים בפלייליסטים ללמידה, אז הסדר לא נלמד הפעם.");
  if (bpmOn(c) && tracks.length) {
    const known = tracks.filter(t => t.bpm != null).length;
    if (known < tracks.length * 0.5) warnings.push(`BPM ידוע רק ל־${known} מתוך ${tracks.length} שירים, אז הסידור לפי BPM חלקי.`);
  }
  const earlyUris = new Set(earlyPool.map(t => t.uri));
  tracks.forEach(t => t.early = earlyUris.has(t.uri));
  let link = null;
  if (!opts.dry) {
    step("שומר בספוטיפיי…");
    const desc = `עודכן ${d.stamp} · ${c.early_percent}% תחילת ערב · ${c.length_minutes} דקות ${encodeTag(c)}`;
    let pid = todays && todays.id;
    if (pid) await sp.call("PUT", `/playlists/${pid}`, {description: desc});
    else pid = (await sp.call("POST", "/me/playlists", {name, description: desc, public: !!c.public})).id;
    await sp.setItems(pid, tracks.map(t => t.uri));
    link = "https://open.spotify.com/playlist/" + pid;
  }
  return {tracks, warnings, link, dry: !!opts.dry, existed: false, learned: learned && {...learned, text: describeCurve(learned.curve)}};
}

// Save settings for the 12:00 run: rewrite the tag on the newest dated playlist.
async function pushSettings(c, token) {
  const sp = new Spotify(token), last = datedPlaylists(await sp.myPlaylists())[0];
  if (!last) return false;
  const base = String(last.description || "").replace(/&#x2F;|&#47;/g, "/").replace(/\s*⚙[^\n]*$/, "");
  await sp.call("PUT", `/playlists/${last.id}`, {description: (base + " " + encodeTag(c)).trim()});
  return true;
}

// Settings for the 12:00 run: the newest dated playlist that carries a tag.
async function pullSettings(token) {
  const sp = new Spotify(token);
  for (const p of datedPlaylists(await sp.myPlaylists())) { const s = decodeTag(p.description); if (s) return s; }
  return null;
}

root.DPC = {hebrewBlocks, bpmOn, fetchTempos, riseOrder, learnCurve, curveOrder, describeCurve, liftOf, fitsRange, CLIENT_ID, SCOPES, API, DAY_KEYS, WEEKDAYS, DEFAULTS, tokenRequest, Spotify, playlistId, encodeTag, decodeTag,
  markHebrew, normTitle, build, israelNow, playlistName, isSkipDay, run, pushSettings, pullSettings, pad};
})(typeof window !== "undefined" ? window : globalThis);
