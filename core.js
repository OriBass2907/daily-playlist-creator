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
  hebrew_artists: ["Omer Adam","Noa Kirel"], not_hebrew_artists: [], public: false
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
    n(c.max_from_yesterday), c.unique_titles === false ? 0 : 1, skip, playlistId(c.early_playlist), playlistId(c.late_playlist), he].join("/");
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
  return {length_minutes: num(p[0]) ?? DEFAULTS.length_minutes, early_percent: num(p[1]) ?? DEFAULTS.early_percent,
    hebrew_percent: num(p[2]), blend_songs: num(p[3]) ?? 0, max_songs_per_artist: num(p[4]), max_from_yesterday: num(p[5]),
    unique_titles: p[6] !== "0", skip_days: p[7] === "-" ? [] : [...p[7]].map(ch => back[ch]).filter(Boolean),
    early_playlist: p[8], late_playlist: p[9], hebrew_artists: (p.slice(10).join("/") || "").split(";").map(s => s.trim()).filter(Boolean)};
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

function build(earlyPool, latePool, c, yesterday, todayIso) {
  const rng = rngFrom(todayIso + c._name);
  const totalMs = c.length_minutes * 60000, earlyMs = totalMs * c.early_percent / 100;
  const taken = new Taken(c, yesterday), hp = c.hebrew_percent;
  let [early, gotEarly] = pickSection(earlyPool, earlyMs, hp, rng, taken);
  let [late, gotLate] = pickSection(latePool, totalMs - gotEarly, hp, rng, taken);
  early = noArtistBackToBack(early); late = noArtistBackToBack(late);
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
  step("בונה פלייליסט…");
  const [tracks, warnings] = build(earlyPool, latePool, c, yesterday, d.iso);
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
  return {tracks, warnings, link, dry: !!opts.dry, existed: false};
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

root.DPC = {CLIENT_ID, SCOPES, API, DAY_KEYS, WEEKDAYS, DEFAULTS, tokenRequest, Spotify, playlistId, encodeTag, decodeTag,
  markHebrew, normTitle, build, israelNow, playlistName, isSkipDay, run, pushSettings, pullSettings, pad};
})(typeof window !== "undefined" ? window : globalThis);
