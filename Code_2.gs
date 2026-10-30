/**
 * Orri's Crate
 * A crate-digging front end for a public Discogs collection.
 * Google Apps Script web app. Two files: Code.gs (this one) and Index.html.
 *
 * Script properties (Project Settings > Script properties), all optional:
 *   DISCOGS_TOKEN          Personal access token from discogs.com/settings/developers.
 *                          Strongly recommended: Apps Script shares IP addresses with
 *                          every other script, so anonymous Discogs calls can get rate limited.
 *   SPOTIFY_CLIENT_ID      From developer.spotify.com/dashboard. Turns on the Spotify player.
 *   SPOTIFY_CLIENT_SECRET  Same app as above.
 *
 * After pasting both files: run warmUp() once from the editor (authorizes the script and
 * backfills original release years), then Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Anyone.
 *
 * The page itself is hosted on GitHub Pages and reads from this script as a JSON feed:
 *   <exec url>?api=collection        the whole crate
 *   <exec url>?api=record&id=<id>    one release with tracklist (and Spotify id if set up)
 * The page calls it without cookies, so visitors' Google sign-ins never get involved.
 * Opening the /exec URL without ?api still serves the full page, as a backup.
 */

const CONFIG = {
  DISCOGS_USER: 'orrisachar',
  SITE_TITLE: "Orri's Crate",
  DEFAULT_SORT: 'az',             // az | genre | label | added | era | shuffle
  COLLECTION_CACHE_MINUTES: 10,   // new Discogs adds show up within this window
  SPOTIFY_MARKET: 'CA',
  // Fix a wrong or missing Spotify match: Discogs release id -> Spotify album id.
  // Use '' to hide the player for that record.
  SPOTIFY_OVERRIDES: {
    // '23052887': 'spotifyAlbumIdHere',
  },
};

const UA = 'OrrisCrate/1.0 +https://www.discogs.com/user/' + CONFIG.DISCOGS_USER;

/* ------------------------------------------------------------------ */
/* Web app                                                             */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api) return api_(p);

  let boot;
  try {
    boot = getCollection_();
    boot.ok = true;
  } catch (err) {
    boot = { ok: false, error: errText_(err), records: [] };
  }
  boot.config = clientConfig_();
  // ?r=<release id> opens straight onto one record (handy for a QR on a specific sleeve)
  const r = e && e.parameter && Number(e.parameter.r);
  if (r) boot.open = r;
  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = asciiJson_(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(CONFIG.SITE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** JSON feed for the hosted page. Errors come back as { ok: false, error }. */
function api_(p) {
  let out;
  try {
    if (p.api === 'collection') out = getCollectionData();
    else if (p.api === 'record') out = getRecord(p.id);
    else throw new Error('Unknown api call');
  } catch (err) {
    out = { ok: false, error: errText_(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Called from the page to retry when the first load failed. */
function getCollectionData() {
  const data = getCollection_();
  data.ok = true;
  data.config = clientConfig_();
  return data;
}

/** Called from the page when someone pulls a record out. */
function getRecord(id) {
  id = Number(id);
  if (!id || id !== Math.floor(id) || id < 1) throw new Error('Bad release id');

  // Only serve releases that are actually in the collection, so the
  // endpoint can't be used as an open Discogs proxy.
  const col = getCollection_();
  const owned = (col.records || []).find(function (r) { return r.id === id; });
  if (!owned) throw new Error('That release is not in this collection');

  const cache = CacheService.getScriptCache();
  const key = 'rel:v1:' + id;
  let rec = cacheGetJson_(cache, key);
  if (!rec) {
    rec = trimRelease_(discogsGet_('https://api.discogs.com/releases/' + id));
    cachePutJson_(cache, key, rec, 21600);
  }
  try {
    rec.spotify = spotifyFor_(id, owned);
  } catch (err) {
    rec.spotify = null;
  }
  return rec;
}

function clientConfig_() {
  return {
    title: CONFIG.SITE_TITLE,
    user: CONFIG.DISCOGS_USER,
    defaultSort: CONFIG.DEFAULT_SORT,
    spotify: hasSpotify_(),
  };
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

function getCollection_() {
  const cache = CacheService.getScriptCache();
  const hit = cacheGetJson_(cache, 'col:v1');
  if (hit) return hit;
  let data;
  try {
    data = buildCollection_(4000, 0);
  } catch (err) {
    const fresh = cacheGetJson_(cache, 'col:v1'); // another visitor may have just refreshed it
    if (fresh) return fresh;
    const backup = propsGetJson_('BACKUP');
    if (backup) {
      backup.stale = true;
      cachePutJson_(cache, 'col:v1', backup, 60); // don't hammer Discogs while it's down
      return backup;
    }
    throw err;
  }
  cachePutJson_(cache, 'col:v1', data, CONFIG.COLLECTION_CACHE_MINUTES * 60);
  try { propsPutJson_('BACKUP', data); } catch (err) { /* backup is best effort */ }
  return data;
}

function buildCollection_(masterBudgetMs, masterSleepMs) {
  const raw = [];
  let page = 1;
  let pages = 1;
  do {
    const url = 'https://api.discogs.com/users/' + encodeURIComponent(CONFIG.DISCOGS_USER) +
      '/collection/folders/0/releases?per_page=100&sort=added&sort_order=desc&page=' + page;
    const json = discogsGet_(url);
    pages = (json.pagination && json.pagination.pages) || 1;
    Array.prototype.push.apply(raw, json.releases || []);
    page++;
  } while (page <= pages && page <= 50);

  const years = fillMasterYears_(raw, masterBudgetMs, masterSleepMs);
  const byId = {};
  const records = [];
  raw.forEach(function (r) {
    const b = r.basic_information || {};
    if (!b.id) return;
    if (byId[b.id]) { byId[b.id].n++; return; }
    const m = b.master_id || 0;
    const rec = {
      id: b.id,
      n: 1,
      a: (b.artists || []).map(function (a) { return { n: a.anv || a.name || '', j: a.join || '' }; }),
      t: b.title || '',
      y: b.year || 0,
      oy: m ? (years[m] || 0) : (b.year || 0),
      g: b.genres || [],
      s: b.styles || [],
      f: (b.formats || []).map(function (f) {
        return { q: f.qty || '1', n: f.name || '', d: f.descriptions || [], x: (f.text || '').trim() };
      }),
      l: (b.labels || []).slice(0, 2).map(function (l) { return { n: l.name || '', c: l.catno || '' }; }),
      img: b.cover_image || '',
      th: b.thumb || '',
      d: (r.date_added || '').slice(0, 10),
      m: m,
    };
    byId[b.id] = rec;
    records.push(rec);
  });
  return { records: records, total: raw.length, updated: new Date().toISOString() };
}

/** Original release year lives on the Discogs "master". Kept permanently in script properties. */
function fillMasterYears_(raw, budgetMs, sleepMs) {
  const years = propsGetJson_('MASTER_YEARS') || {};
  const missing = [];
  raw.forEach(function (r) {
    const m = r.basic_information && r.basic_information.master_id;
    if (m && !(m in years) && missing.indexOf(m) < 0) missing.push(m);
  });
  if (!missing.length || budgetMs <= 0) return years;

  const start = Date.now();
  let added = 0;
  for (let i = 0; i < missing.length; i++) {
    if (Date.now() - start > budgetMs) break;
    try {
      const master = discogsGet_('https://api.discogs.com/masters/' + missing[i]);
      years[missing[i]] = master.year || 0;
      added++;
    } catch (err) {
      const msg = errText_(err);
      if (/rate limit/i.test(msg)) break;
      if (/404/.test(msg)) years[missing[i]] = 0; // master is gone, don't keep asking
    }
    if (sleepMs) Utilities.sleep(sleepMs);
  }
  if (added || missing.length) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(3000)) {
      try {
        const latest = propsGetJson_('MASTER_YEARS') || {};
        Object.keys(years).forEach(function (k) { latest[k] = years[k]; });
        propsPutJson_('MASTER_YEARS', latest);
      } catch (err) {
        // couldn't save; the years still apply to this response and get refetched later
      } finally {
        lock.releaseLock();
      }
    }
  }
  return years;
}

/* ------------------------------------------------------------------ */
/* Release detail                                                      */
/* ------------------------------------------------------------------ */

function trimRelease_(r) {
  const tracks = [];
  (r.tracklist || []).forEach(function (t) {
    if (t.type_ === 'heading') { tracks.push({ h: 1, t: t.title || '' }); return; }
    tracks.push({ p: t.position || '', t: t.title || '', d: t.duration || '', a: artistsText_(t.artists) });
    if (t.type_ === 'index' && t.sub_tracks) {
      t.sub_tracks.forEach(function (st) {
        tracks.push({ p: st.position || '', t: st.title || '', d: st.duration || '', a: artistsText_(st.artists), sub: 1 });
      });
    }
  });

  const wanted = /^(Producer|Written-By|Composed By|Mixed By|Mastered By|Lacquer Cut By|Design|Artwork|Art Direction|Photography By|Remix|Arranged By|Lyrics By|Music By)/i;
  const credits = [];
  const seen = {};
  (r.extraartists || []).forEach(function (e) {
    const role = (e.role || '').split(',')[0].trim();
    const name = cleanName_(e.anv || e.name);
    const k = role + '|' + name;
    if (!role || !wanted.test(role) || seen[k] || credits.length >= 8) return;
    seen[k] = 1;
    credits.push({ r: role, n: name });
  });

  const c = r.community || {};
  return {
    id: r.id,
    uri: r.uri || ('https://www.discogs.com/release/' + r.id),
    country: r.country || '',
    released: r.released_formatted || r.released || '',
    notes: String(r.notes || '').slice(0, 700),
    tracks: tracks.slice(0, 80),
    credits: credits,
    have: c.have || 0,
    want: c.want || 0,
    rating: c.rating && c.rating.count ? { avg: c.rating.average, n: c.rating.count } : null,
    videos: (r.videos || []).filter(function (v) { return /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(v.uri || ''); })
      .slice(0, 3).map(function (v) { return { t: v.title, u: v.uri }; }),
    images: (r.images || []).slice(0, 6).map(function (i) { return { u: i.uri, t: i.type }; }),
  };
}

function artistsText_(arr) {
  if (!arr || !arr.length) return '';
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += cleanName_(arr[i].anv || arr[i].name);
    if (i === arr.length - 1) break;
    const j = (arr[i].join || '').trim();
    if (j === '=') break;
    out += (j === ',' || j === '') ? ', ' : ' ' + j + ' ';
  }
  return out;
}

function cleanName_(s) {
  return String(s || '').replace(/\s\(\d+\)$/, '').trim();
}

/* ------------------------------------------------------------------ */
/* Discogs HTTP                                                        */
/* ------------------------------------------------------------------ */

function discogsGet_(url) {
  const token = PropertiesService.getScriptProperties().getProperty('DISCOGS_TOKEN');
  const headers = { 'User-Agent': UA };
  if (token) headers.Authorization = 'Discogs token=' + token.trim();
  const res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 200) return JSON.parse(res.getContentText('UTF-8'));
  if (code === 429) throw new Error('Discogs rate limit hit. Try again in a minute.');
  if (code === 401 || code === 403) throw new Error('Discogs refused the request (' + code + '). Check the collection is public and the token is valid.');
  if (code === 404) throw new Error('Discogs returned 404 for ' + url.replace(/\?.*$/, ''));
  throw new Error('Discogs error ' + code);
}

/* ------------------------------------------------------------------ */
/* Spotify (optional)                                                  */
/* ------------------------------------------------------------------ */

function hasSpotify_() {
  const p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('SPOTIFY_CLIENT_ID') && p.getProperty('SPOTIFY_CLIENT_SECRET'));
}

function spotifyFor_(id, owned) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(CONFIG.SPOTIFY_OVERRIDES, key)) {
    return CONFIG.SPOTIFY_OVERRIDES[key] || null;
  }
  if (!hasSpotify_()) return null;

  const known = propsGetJson_('SPOTIFY_IDS') || {};
  if (key in known) return known[key] || null;

  const artists = (owned.a || []).map(function (a) { return cleanName_(String(a.n).split(' = ')[0]); })
    .filter(function (n) { return n && !/^various$/i.test(n); });
  const found = spotifySearch_(artists, owned.t);
  if (found === null) return null; // auth/network problem: don't remember a miss

  const lock = LockService.getScriptLock();
  if (lock.tryLock(3000)) {
    try {
      const latest = propsGetJson_('SPOTIFY_IDS') || {};
      latest[key] = found;
      propsPutJson_('SPOTIFY_IDS', latest);
    } finally {
      lock.releaseLock();
    }
  }
  return found || null;
}

function spotifyToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sp:token');
  if (hit) return hit;
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('SPOTIFY_CLIENT_ID');
  const secret = p.getProperty('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) return null;
  const res = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
    method: 'post',
    payload: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id.trim() + ':' + secret.trim()) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Spotify auth failed (' + res.getResponseCode() + ')');
  const j = JSON.parse(res.getContentText('UTF-8'));
  cache.put('sp:token', j.access_token, Math.max(60, (j.expires_in || 3600) - 300));
  return j.access_token;
}

/** Returns an album id, '' for "searched and found nothing", or null for "couldn't search". */
function spotifySearch_(artists, rawTitle) {
  let token;
  try { token = spotifyToken_(); } catch (err) { return null; }
  if (!token) return null;

  const title = baseTitle_(rawTitle);
  const lead = artists[0] || '';
  const queries = [];
  if (lead) queries.push('album:' + title + ' artist:' + lead);
  queries.push((lead ? lead + ' ' : '') + title);

  let best = null;
  let bestScore = 0;
  for (let q = 0; q < queries.length; q++) {
    const url = 'https://api.spotify.com/v1/search?type=album&limit=10&market=' + CONFIG.SPOTIFY_MARKET +
      '&q=' + encodeURIComponent(queries[q]);
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 401) { CacheService.getScriptCache().remove('sp:token'); return null; }
    if (code === 429 || code >= 500) return null;
    if (code !== 200) continue;
    const items = ((JSON.parse(res.getContentText('UTF-8')).albums) || {}).items || [];
    items.forEach(function (it) {
      if (!it) return;
      const s = scoreAlbum_(it, artists, title);
      if (s > bestScore) { bestScore = s; best = it; }
    });
    if (bestScore >= 6) break;
  }
  return bestScore >= 5 && best ? best.id : '';
}

function scoreAlbum_(it, artists, title) {
  const nt = norm_(title);
  const it_t = norm_(baseTitle_(it.name));
  let s = 0;
  if (it_t === nt) s += 3;
  else if (it_t.indexOf(nt) === 0 || nt.indexOf(it_t) === 0) s += 2;
  else if (jaccard_(it_t, nt) >= 0.6) s += 1;

  const theirs = (it.artists || []).map(function (a) { return norm_(a.name); });
  const ours = artists.map(norm_).filter(Boolean);
  if (!ours.length) {
    s += theirs.indexOf('various artists') >= 0 ? 2 : 1;
  } else if (theirs.some(function (n) { return ours.indexOf(n) >= 0; })) {
    s += 3;
  } else if (theirs.some(function (n) { return ours.some(function (o) { return n.indexOf(o) >= 0 || o.indexOf(n) >= 0; }); })) {
    s += 2;
  }
  return s;
}

function baseTitle_(s) {
  return String(s || '').split(' = ')[0].replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function norm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|remastered|deluxe|edition|expanded)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function jaccard_(a, b) {
  const A = a.split(' ').filter(Boolean);
  const B = b.split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const inter = A.filter(function (w) { return B.indexOf(w) >= 0; }).length;
  return inter / (A.length + B.length - inter);
}

/* ------------------------------------------------------------------ */
/* Run these from the editor                                           */
/* ------------------------------------------------------------------ */

/**
 * Editor-only utilities. Any top-level function without a trailing underscore can be called
 * from the page through google.script.run, so these refuse to run for anonymous visitors.
 */
function ownerOnly_() {
  const active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) throw new Error('Owner only');
}

/** Run once after setup. Authorizes the script, backfills original years, primes the cache. */
function warmUp() {
  ownerOnly_();
  const hasToken = !!PropertiesService.getScriptProperties().getProperty('DISCOGS_TOKEN');
  // Discogs allows 25 requests/min anonymous, 60/min with a token.
  const data = buildCollection_(5 * 60 * 1000 - 30000, hasToken ? 1100 : 2600);
  const cache = CacheService.getScriptCache();
  cachePutJson_(cache, 'col:v1', data, CONFIG.COLLECTION_CACHE_MINUTES * 60);
  propsPutJson_('BACKUP', data);
  const withYear = data.records.filter(function (r) { return r.oy; }).length;
  Logger.log('Collection: ' + data.total + ' copies, ' + data.records.length + ' unique releases');
  Logger.log('Original years known for ' + withYear + ' of ' + data.records.length +
    (withYear < data.records.length ? ' (run warmUp again to fill the rest)' : ''));
  Logger.log(hasToken ? 'Discogs token: yes' :
    'WARNING: no DISCOGS_TOKEN set. Apps Script shares IP addresses with other scripts, so anonymous Discogs calls ' +
    'get rate limited and guests will see "Couldn\'t load the tracklist". Add one under Project Settings > Script properties.');
  if (hasSpotify_()) {
    try { spotifyToken_(); Logger.log('Spotify: connected'); }
    catch (err) { Logger.log('Spotify: ' + errText_(err)); }
  } else {
    Logger.log('Spotify: not set up (records will link out to Spotify search instead)');
  }
}

/** Forces the next page load to pull fresh data from Discogs. */
function refreshNow() {
  ownerOnly_();
  CacheService.getScriptCache().remove('col:v1:n');
  getCollection_();
  Logger.log('Refreshed');
}

/** Clears remembered Spotify matches so they get searched again. */
function resetSpotifyMatches() {
  ownerOnly_();
  propsPutJson_('SPOTIFY_IDS', {});
  Logger.log('Spotify matches cleared');
}

/** Lists every Spotify match so you can spot wrong ones and add overrides. */
function listSpotifyMatches() {
  ownerOnly_();
  const known = propsGetJson_('SPOTIFY_IDS') || {};
  const col = getCollection_();
  col.records.forEach(function (r) {
    const k = String(r.id);
    const v = Object.prototype.hasOwnProperty.call(CONFIG.SPOTIFY_OVERRIDES, k) ? CONFIG.SPOTIFY_OVERRIDES[k] + ' (override)' :
      (k in known ? (known[k] ? 'https://open.spotify.com/album/' + known[k] : 'no match') : 'not looked up yet');
    Logger.log(k + '  ' + artistsText_(r.a.map(function (a) { return { name: a.n, join: a.j }; })) + ' - ' + r.t + '  ->  ' + v);
  });
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

/** JSON with every non-ASCII char escaped, so byte length == char length for size limits. */
function asciiJson_(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function cachePutJson_(cache, key, obj, ttl) {
  const s = asciiJson_(obj);
  const size = 90000;
  const n = Math.max(1, Math.ceil(s.length / size));
  const map = {};
  for (let i = 0; i < n; i++) map[key + ':' + i] = s.slice(i * size, (i + 1) * size);
  map[key + ':n'] = String(n);
  cache.putAll(map, ttl);
}

function cacheGetJson_(cache, key) {
  const n = Number(cache.get(key + ':n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = cache.getAll(keys);
  let s = '';
  for (let i = 0; i < keys.length; i++) {
    if (got[keys[i]] == null) return null;
    s += got[keys[i]];
  }
  try { return JSON.parse(s); } catch (err) { return null; }
}

function propsPutJson_(key, obj) {
  const props = PropertiesService.getScriptProperties();
  const s = asciiJson_(obj);
  const size = 8000; // script properties cap each value at 9KB
  const n = Math.max(1, Math.ceil(s.length / size));
  const oldN = Number(props.getProperty(key + '_n')) || 0;
  const map = {};
  for (let i = 0; i < n; i++) map[key + '_' + i] = s.slice(i * size, (i + 1) * size);
  map[key + '_n'] = String(n);
  props.setProperties(map, false);
  for (let i = n; i < oldN; i++) props.deleteProperty(key + '_' + i);
}

function propsGetJson_(key) {
  const all = PropertiesService.getScriptProperties().getProperties();
  const n = Number(all[key + '_n']);
  if (!n) return null;
  let s = '';
  for (let i = 0; i < n; i++) {
    const part = all[key + '_' + i];
    if (part == null) return null;
    s += part;
  }
  try { return JSON.parse(s); } catch (err) { return null; }
}

function errText_(err) {
  return String((err && err.message) || err);
}
