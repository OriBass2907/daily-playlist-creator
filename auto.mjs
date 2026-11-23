// The daily 12:00 run (GitHub Actions). For every account connected in the app (tokens/<account>.json, encrypted
// with that account's DPC_KEY_<ACCOUNT> secret), build today's playlist unless one already exists. Settings come from the app
// (carried in the description of the newest dated playlist). Writes status/<account>.json for the app to show.
import "./core.js";
import {webcrypto as crypto} from "node:crypto";
import fs from "node:fs";

const DPC = globalThis.DPC;
// One secret per account: the token file says which one (DPC_KEY, DPC_KEY_2 … DPC_KEY_5); older files use DPC_KEY.
const KEY_NAMES = ["DPC_KEY", "DPC_KEY_2", "DPC_KEY_3", "DPC_KEY_4", "DPC_KEY_5"];
const keyName = box => KEY_NAMES.includes(box.key) ? box.key : "DPC_KEY";
const FORCE = process.env.FORCE === "true";   // manual "Run workflow" button: ignore the time window
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => Buffer.from(buf).toString("base64"), unb64 = s => new Uint8Array(Buffer.from(s, "base64"));

async function aesKey(salt, KEY) {
  const base = await crypto.subtle.importKey("raw", enc.encode(KEY), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256"}, base, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}
async function decrypt(box, key) {
  const pt = await crypto.subtle.decrypt({name: "AES-GCM", iv: unb64(box.iv)}, await aesKey(unb64(box.salt), key), unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
async function encrypt(obj, key) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv}, await aesKey(salt, key), enc.encode(JSON.stringify(obj)));
  return {v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct)};
}

const now = DPC.israelNow();
if (!FORCE && (now.hour < 12 || now.hour >= 16)) {
  console.log(`Israel time ${now.hour}:${DPC.pad(now.minute)}: outside 12:00-16:00, nothing to do.`);
  process.exit(0);
}

fs.mkdirSync("status", {recursive: true});
// tokens/<account>--<time>.json: the app adds a new file on every (re)connect; keep only the newest per account.
const all = fs.existsSync("tokens") ? fs.readdirSync("tokens").filter(f => f.endsWith(".json")).sort() : [];
const newest = {};
for (const f of all) newest[f.split("--")[0].replace(/\.json$/, "")] = f;
for (const f of all) if (!Object.values(newest).includes(f)) fs.unlinkSync("tokens/" + f);
const files = Object.values(newest);
if (!files.length) console.log("No account is connected for the automatic run yet.");
let failed = 0;
for (const f of files) {
  const slug = f.split("--")[0].replace(/\.json$/, ""), status = {date: now.iso, time: `${now.hour}:${DPC.pad(now.minute)}`};
  try {
    const box = JSON.parse(fs.readFileSync("tokens/" + f, "utf8"));
    const name = keyName(box), key = process.env[name] || "";
    if (!key) throw new Error(`The GitHub secret ${name} is missing (repo Settings > Secrets and variables > Actions).`);
    let tok;
    try { tok = await decrypt(box, key); } catch {
      throw new Error(key ? `The key in the GitHub secret ${name} does not match: in the app press 'הפעל יצירה אוטומטית' again.`
        : `The GitHub secret ${name} is missing (repo Settings > Secrets and variables > Actions > New repository secret).`);
    }
    status.account = tok.account; status.authorized_at = tok.authorized_at;
    let fresh;
    try { fresh = await DPC.tokenRequest({grant_type: "refresh_token", refresh_token: tok.refresh_token}); }
    catch (e) {
      if (e.code === "invalid_grant") throw new Error("The Spotify connection expired: in the app press 'הפעל יצירה אוטומטית' again.");
      throw e;
    }
    if (fresh.refresh_token && fresh.refresh_token !== tok.refresh_token) {   // Spotify rotated it: keep the new one
      tok.refresh_token = fresh.refresh_token;
      fs.writeFileSync("tokens/" + f, JSON.stringify({...await encrypt(tok, key), key: name}) + "\n");
    }
    const saved = await DPC.pullSettings(fresh.access_token);
    if (!saved) throw new Error("No settings found yet: create one playlist from the app first.");
    const c = {...DPC.DEFAULTS, ...saved, _name: tok.account};
    if (DPC.isSkipDay(c, now) && !FORCE) {
      status.result = "skip"; console.log(`[${tok.account}] day off today, no playlist.`);
    } else {
      const r = await DPC.run(c, fresh.access_token, {onlyIfMissing: true, step: t => console.log(`[${tok.account}] ${t}`)});
      status.result = r.existed ? "exists" : "created"; status.link = r.link; status.songs = r.tracks.length;
      status.warnings = r.warnings;
      console.log(`[${tok.account}] ${r.existed ? "today's playlist already exists" : `created ${r.tracks.length} songs`}: ${r.link}`);
      r.warnings.forEach(w => console.log(`[${tok.account}] WARNING: ${w}`));
    }
  } catch (e) {
    failed++; status.result = "error"; status.error = e.message; console.error(`[${slug}] FAILED: ${e.message}`);
  }
  fs.writeFileSync(`status/${slug}.json`, JSON.stringify(status, null, 1) + "\n");
}
process.exit(failed ? 1 : 0);
