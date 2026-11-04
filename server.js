'use strict';
// Servidor sin dependencias: sirve la interfaz, guarda la configuración y ejecuta los análisis.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { analyze, History, DEFAULTS } = require('./lib/analysis');
const { DemoMarket } = require('./lib/demo');
const { OddsApi, cleanKey, keyProblem } = require('./lib/oddsapi');
const { newsFor } = require('./lib/news');
const { PulseScore, cleanPsKey } = require('./lib/pulsescore');
const { OddsPapi, cleanOpKey, normalizeOddsPapi } = require('./lib/oddspapi');
const { matchEvents } = require('./lib/match');
const { volleyModelBook } = require('./lib/b365model');

const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 5180;
// En la nube (variable APP_PASSWORD o RENDER) la app pide contraseña; en este ordenador, no.
const CLOUD = !!(process.env.APP_PASSWORD || process.env.RENDER);
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const MAX_REAL_SPORTS = 20;

fs.mkdirSync(DATA, { recursive: true });

const BASE_CONFIG = {
  mode: 'demo',
  apiKey: '',
  regions: 'eu',
  ttlSec: 900,
  refreshDemoSec: 10,
  refreshRealSec: 180,
  method: DEFAULTS.method,
  minEV: DEFAULTS.minEV,
  palpable: DEFAULTS.palpable,
  kellyFraction: DEFAULTS.kellyFraction,
  maxStakePct: DEFAULTS.maxStakePct,
  bankroll: DEFAULTS.bankroll,
  maxAgeMin: DEFAULTS.maxAgeMin,
  maxCreditsPerSearch: 30, // tope de créditos de The Odds API que puede gastar una sola búsqueda o rastreo
};

let config = { ...BASE_CONFIG };
try { config = { ...BASE_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// En la nube (Render) las claves llegan como variables secretas del servidor y mandan sobre config.json,
// que allí se borra en cada reinicio. Con clave de The Odds API la app arranca en modo real.
if (process.env.ODDS_API_KEY) { config.apiKey = cleanKey(process.env.ODDS_API_KEY); if (!process.env.APP_MODE) config.mode = 'real'; }
if (process.env.PULSESCORE_KEY) config.psKey = cleanPsKey(process.env.PULSESCORE_KEY);
if (process.env.ODDSPAPI_KEY) config.opKey = cleanOpKey(process.env.ODDSPAPI_KEY);
if (Number(process.env.MAX_CREDITS_PER_SEARCH) > 0) config.maxCreditsPerSearch = Number(process.env.MAX_CREDITS_PER_SEARCH);
const creditCap = () => Math.max(1, Number(config.maxCreditsPerSearch) || 30);
if (process.env.APP_MODE === 'demo' || process.env.APP_MODE === 'real') config.mode = process.env.APP_MODE;

// Ahorro de créditos: una sola región (Europa ya incluye Pinnacle y Betfair) y caché de 15 minutos.
if (!config.savingV2) {
  if (config.regions === 'eu,uk') config.regions = 'eu';
  if (config.ttlSec < 900) config.ttlSec = 900;
  config.savingV2 = true;
  saveConfig();
}

const demo = new DemoMarket();
const api = new OddsApi(path.join(DATA, 'cache-odds.json'));
const ps = new PulseScore(path.join(DATA, 'cache-pulsescore.json'));
const op = new OddsPapi(path.join(DATA, 'cache-oddspapi.json'));
const histories = { demo: new History(), real: new History() };

function publicConfig() {
  const { apiKey, psKey, opKey, ...rest } = config;
  return {
    ...rest, hasKey: !!apiKey, keyMasked: apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '',
    hasPsKey: !!psKey, psKeyMasked: psKey ? `${psKey.slice(0, 4)}…${psKey.slice(-4)}` : '', psUsage: ps.monthUsage(),
    hasOpKey: !!opKey, opKeyMasked: opKey ? (opKey.slice(0, 4) + '…' + opKey.slice(-4)) : '', opUsage: op.account,
    keyIssue: apiKey ? keyProblem(apiKey) : null, credits: api.credits,
    cloud: CLOUD, keysFromServer: !!(process.env.ODDS_API_KEY || process.env.PULSESCORE_KEY),
  };
}

function analysisOpts() {
  return {
    method: config.method, minEV: config.minEV, palpable: config.palpable, kellyFraction: config.kellyFraction,
    maxStakePct: config.maxStakePct, bankroll: config.bankroll, maxAgeMin: config.maxAgeMin,
  };
}

function checkKey() {
  if (!config.apiKey) throw new Error('Falta la clave de The Odds API (⚙ Ajustes).');
  const problem = keyProblem(config.apiKey);
  if (problem) throw new Error(`La clave guardada no es válida. ${problem}`);
}

async function listSports() {
  if (config.mode === 'real') {
    checkKey();
    const list = await api.sports(config.apiKey);
    // Con clave de PulseScore se añade el voleibol de bet365 (todas sus ligas en una sola entrada).
    if (!config.psKey && !config.opKey) return list;
    const favKeys = new Set(FAVORITES.map((f) => f.oddsKey));
    return [...FAVORITES.map((f) => ({ key: f.key, title: f.title, sport: 'futbol', group: 'Fútbol' })), ...list.filter((s) => !favKeys.has(s.key)), ...(config.psKey ? [B365_VOLLEY] : [])];
  }
  return demo.sports();
}

const B365_VOLLEY = { key: 'b365_volleyball', title: 'Voleibol: todas las ligas (bet365)', sport: 'voleibol', group: 'Voleibol' };
const MAX_B365_LEAGUES = 8;

// Añade bet365 (PulseScore) a los partidos de fútbol de The Odds API. Se usa el listado barato de bet365
// (solo 1X2, caché de 3 h) para saber qué ligas de bet365 corresponden y se piden completas las que
// más partidos tienen en común (1 petición por liga, caché de 30 min).
async function addBet365Soccer(events, errors) {
  if (!config.psKey || !events.length) return 0;
  let listing;
  try { listing = await ps.soccerListing(config.psKey); } catch (e) { errors.push(e.message); return 0; }
  const pairs = matchEvents(events, listing);
  const leagues = new Map();
  for (const o of pairs.values()) leagues.set(o.b365League, (leagues.get(o.b365League) || 0) + 1);
  const full = new Map();
  for (const [lg] of [...leagues.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_B365_LEAGUES)) {
    try { for (const e of await ps.soccerLeague(config.psKey, lg)) full.set(e.b365Id, e); } catch (e) { errors.push(e.message); }
  }
  let n = 0;
  for (const ev of events) {
    const o = pairs.get(ev.id);
    if (!o) continue;
    const b = (full.get(o.b365Id) || o).books[0];
    ev.books = ev.books.filter((x) => x.key !== 'bet365').concat([b]);
    n++;
  }
  return n;
}

// Competiciones que entran siempre (con clave de PulseScore): todos sus partidos, todos los mercados de
// bet365 y Pinnacle (PS3838) como referencia. No gastan créditos de The Odds API (unas 4 peticiones de
// PulseScore por búsqueda, con caché de 30 min).
const FAVORITES = [
  { key: 'fav_ucl', title: '⭐ Champions League (siempre)', league: 'Champions League', b365: 'UEFA Competitions||UEFA Champions League', ps: 'UEFA - Champions League', oddsKey: 'soccer_uefa_champs_league' },
  { key: 'fav_laliga', title: '⭐ LaLiga (siempre)', league: 'LaLiga', b365: 'Spain||Spain La Liga', ps: 'Spain - La Liga', oddsKey: 'soccer_spain_la_liga' },
];

// Con OddsPapi: Champions (7) y LaLiga (8), bet365 y Pinnacle → 2 peticiones (caché de 30 min)
const OP_LEAGUES = { 7: { key: 'fav_ucl', name: 'Champions League' }, 8: { key: 'fav_laliga', name: 'LaLiga' } };

async function favoriteEventsOddsPapi(errors) {
  try {
    const ids = Object.keys(OP_LEAGUES).map(Number);
    const [markets, participants] = [await op.markets(config.opKey), await op.participants(config.opKey, 10)];
    const lists = [];
    for (const bookmaker of ['bet365', 'pinnacle']) {
      try { lists.push({ bookmaker, data: await op.oddsByTournaments(config.opKey, bookmaker, ids) }); } catch (e) { errors.push(`OddsPapi (${bookmaker}): ${e.message}`); }
    }
    return normalizeOddsPapi(lists, markets, participants, OP_LEAGUES);
  } catch (e) {
    errors.push(e.message);
    return [];
  }
}

async function favoriteEvents(errors) {
  if (config.opKey) return favoriteEventsOddsPapi(errors);
  const out = [];
  for (const f of FAVORITES) {
    let b365 = [];
    try { b365 = await ps.soccerLeague(config.psKey, f.b365); } catch (e) { errors.push(`${f.league} (bet365): ${e.message}`); continue; }
    let pin = [];
    try { pin = await ps.pinnacleLeague(config.psKey, f.ps); } catch (e) { errors.push(`${f.league} (Pinnacle): ${e.message}`); }
    const pairs = matchEvents(b365, pin);
    for (const e of b365) {
      const p = pairs.get(e.id);
      out.push({ ...e, sportKey: f.key, league: f.league, books: p ? [...e.books, ...p.books] : e.books });
    }
  }
  return out;
}

// Voleibol de bet365 con su modelo de referencia.
async function bet365Volleyball() {
  const evs = await ps.volleyball(config.psKey);
  return evs.map((e) => {
    const model = volleyModelBook(e);
    return model ? { ...e, books: [...e.books, model] } : e;
  });
}

async function scan(sportKeys) {
  const errors = [];
  let events = [];
  let b365Matched = 0;
  if (config.mode === 'real') {
    checkKey();
    const sports = await api.sports(config.apiKey);
    // La Champions y LaLiga ya llegan por PulseScore: no se piden también a The Odds API
    const favKeys = config.psKey || config.opKey ? new Set(FAVORITES.map((f) => f.oddsKey)) : new Set();
    const chosen = sports.filter((s) => sportKeys.includes(s.key) && !favKeys.has(s.key)).slice(0, MAX_REAL_SPORTS);
    const noCredits = api.credits.remaining !== null && api.credits.remaining <= 1 && api.estimate(chosen.map((s) => s.key), { regions: config.regions, markets: FULL_MARKETS, ttlSec: config.ttlSec }) > 0;
    if (noCredits && chosen.length) errors.push('The Odds API se ha quedado sin créditos este mes: solo se usan las cuotas guardadas y la Champions y LaLiga (OddsPapi).');
    // Tope por búsqueda: se buscan las ligas en orden hasta llegar al límite de créditos; el resto se salta
    let spent = 0;
    const skipped = [];
    for (const s of chosen) {
      try {
        const cost = api.estimate([s.key], { regions: config.regions, markets: FULL_MARKETS, ttlSec: config.ttlSec });
        if (noCredits && cost > 0) continue;
        if (spent + cost > creditCap()) { skipped.push(s.title); continue; }
        spent += cost;
        events.push(...(await api.odds(config.apiKey, s, { regions: config.regions, ttlSec: config.ttlSec, markets: FULL_MARKETS })));
      } catch (e) {
        errors.push(`${s.title}: ${e.message}`);
      }
    }
    if (skipped.length) errors.push(`Tope de ${creditCap()} créditos por búsqueda: no se han buscado ${skipped.length} liga${skipped.length > 1 ? 's' : ''} (${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}). Puedes subir el tope en ⚙ Ajustes.`);
    b365Matched = await addBet365Soccer(events, errors);
    if (config.psKey || config.opKey) events.push(...(await favoriteEvents(errors)));
    if (config.psKey && sportKeys.includes(B365_VOLLEY.key)) {
      try { events.push(...(await bet365Volleyball())); } catch (e) { errors.push(e.message); }
    }
  } else {
    events = demo.snapshot(sportKeys);
  }
  const result = analyze(events, analysisOpts(), histories[config.mode]);
  return {
    mode: config.mode, at: Date.now(), credits: config.mode === 'real' ? api.credits : null,
    psUsage: config.psKey ? ps.monthUsage() : null, opUsage: config.opKey ? op.account : null, b365Matched, errors, ...result,
  };
}

const FULL_MARKETS = 'h2h,totals,spreads';
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const madridDay = (t) => MADRID_DAY.format(new Date(t));

// Créditos que costaría buscar estas ligas ahora mismo.
async function estimate(sportKeys) {
  if (config.mode !== 'real') return { credits: 0, remaining: null };
  sportKeys = sportKeys.filter((k) => k !== B365_VOLLEY.key && !k.startsWith('fav_'));
  return { cap: creditCap(), credits: Math.min(creditCap(), api.estimate(sportKeys.slice(0, MAX_REAL_SPORTS), { regions: config.regions, markets: FULL_MARKETS, ttlSec: config.ttlSec })), remaining: api.credits.remaining };
}

// Rastreo barato: mira gratis qué ligas juegan en los próximos días, pide solo el 1X2 de esas ligas
// (1 crédito por liga y región) y las ordena por valor encontrado. Las mejores se buscan luego completas.
async function scout({ days = 3, top = 5, maxScout = 20, dryRun = false } = {}) {
  const now = Date.now();
  // «hoy» = partidos con fecha de hoy en Madrid (incluidos los que ya han empezado hace menos de 2 h)
  const inWindow = (t) => t > now - 2 * 3600e3 && (days === 'hoy' ? madridDay(t) === madridDay(now) : t < now + days * 864e5);
  const score = (opps) => opps.filter((o) => o.type !== 'interno').reduce((a, o) => a + Math.min(o.ev, 0.15), 0);
  if (config.mode !== 'real') {
    const ranking = demo.sports().map((s) => {
      const r = analyze(demo.snapshot([s.key]), analysisOpts());
      const upcoming = r.events.length;
      return { key: s.key, title: s.title, sport: s.sport, upcoming, opps: r.opportunities.length, bestEv: Math.max(0, ...r.opportunities.map((o) => o.ev)), score: score(r.opportunities) };
    }).sort((a, b) => b.score - a.score);
    return { ranking, recommended: ranking.slice(0, top).map((r) => r.key), cost: 0, fullCost: 0, credits: null };
  }
  checkKey();
  // Sin créditos de The Odds API no se puede rastrear otras ligas (la Champions, LaLiga y el voleibol sí se buscan)
  if (api.credits.remaining !== null && api.credits.remaining <= 1) {
    return { noCredits: true, ranking: [], recommended: [], cost: 0, fullCost: 0, psCost: 0, credits: api.credits, errors: [] };
  }
  const sports = (await api.sports(config.apiKey)).filter((s) => !(config.psKey && FAVORITES.some((f) => f.oddsKey === s.key)));
  const errors = [];
  const withEvents = [];
  const queue = [...sports];
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const list = await api.events(config.apiKey, s); // gratis
        await new Promise((r) => setTimeout(r, 250)); // sin agobiar a la API
        const upcoming = list.filter((e) => inWindow(Date.parse(e.commence_time))).length;
        if (upcoming) withEvents.push({ ...s, upcoming });
      } catch (e) { errors.push(`${s.title}: ${e.message}`); }
    }
  }));
  // El rastreo (solo 1X2) también respeta el tope: se queda con las ligas con más partidos que quepan
  const candidates = [];
  let cost = 0;
  for (const s of withEvents.sort((a, b) => b.upcoming - a.upcoming).slice(0, maxScout)) {
    const c = api.estimate([s.key], { regions: config.regions, markets: 'h2h', ttlSec: config.ttlSec });
    if (cost + c > creditCap()) break;
    cost += c;
    candidates.push(s);
  }
  const extraPerLeague = (FULL_MARKETS.split(',').length - 1) * config.regions.split(',').length;
  // Peticiones de PulseScore (bet365) que costará: listado de fútbol, ligas completas y voleibol.
  const psCost = config.psKey
    ? (ps.isCached('b365|soccer|listing', 3 * 3600e3) ? 0 : 6) + Math.min(top, MAX_B365_LEAGUES) + (ps.isCached('b365|volleyball', 30 * 60e3) ? 0 : 2)
    : 0;
  if (dryRun) {
    return { candidates: candidates.length, leaguesWithMatches: withEvents.length, cost, fullCost: Math.min(top * extraPerLeague, creditCap()), cap: creditCap(), psCost, psUsage: config.psKey ? ps.monthUsage() : null, credits: api.credits, errors };
  }
  const ranking = [];
  for (const s of candidates) {
    try {
      const evs = (await api.odds(config.apiKey, s, { regions: config.regions, ttlSec: config.ttlSec, markets: 'h2h' }))
        .filter((e) => inWindow(Date.parse(e.commence)));
      const r = analyze(evs, analysisOpts());
      ranking.push({ key: s.key, title: s.title, sport: s.sport, upcoming: s.upcoming, opps: r.opportunities.length, bestEv: Math.max(0, ...r.opportunities.map((o) => o.ev)), score: score(r.opportunities) });
    } catch (e) { errors.push(`${s.title}: ${e.message}`); }
  }
  ranking.sort((a, b) => b.score - a.score || b.upcoming - a.upcoming);
  // Primero las ligas con valor en el 1X2; si faltan, se completa con las que más partidos tienen
  // (los errores de bet365 pueden estar en otros mercados que el rastreo no mira).
  const recommended = [...ranking.filter((r) => r.score > 0), ...ranking.filter((r) => r.score <= 0).sort((a, b) => b.upcoming - a.upcoming)]
    .slice(0, top).map((r) => r.key);
  // Voleibol de bet365: si hay valor, se marca también (no gasta créditos de The Odds API)
  if (config.psKey) {
    try {
      const evs = (await bet365Volleyball()).filter((e) => inWindow(Date.parse(e.commence)));
      const r = analyze(evs, analysisOpts());
      const item = { key: B365_VOLLEY.key, title: B365_VOLLEY.title, sport: 'voleibol', upcoming: evs.length, opps: r.opportunities.length, bestEv: Math.max(0, ...r.opportunities.map((o) => o.ev)), score: score(r.opportunities) };
      ranking.push(item);
      if (item.score > 0) recommended.push(item.key);
    } catch (e) { errors.push(e.message); }
  }
  return { ranking, recommended, cost, fullCost: recommended.length * extraPerLeague, psUsage: config.psKey ? ps.monthUsage() : null, credits: api.credits, errors };
}

function version() {
  let v = 0;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p); else v = Math.max(v, fs.statSync(p).mtimeMs);
    }
  };
  walk(PUBLIC);
  return String(Math.floor(v));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, obj, req) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  // Los análisis completos pesan bastante: se comprimen si el navegador lo admite.
  if (req && body.length > 20000 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(code, { ...headers, 'content-encoding': 'gzip' });
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(code, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const NUMERIC = ['ttlSec', 'refreshDemoSec', 'refreshRealSec', 'minEV', 'palpable', 'kellyFraction', 'maxStakePct', 'bankroll', 'maxAgeMin', 'maxCreditsPerSearch'];

// ---------- Contraseña de acceso en la nube ----------
const password = () => String(process.env.APP_PASSWORD || '').trim();
if (CLOUD && !password()) console.error('Falta la variable APP_PASSWORD: la app no dejará entrar a nadie.');
const sessionToken = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || password()).update(password()).digest('hex');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
function authed(req) {
  const t = cookies(req).cuotaradar_sesion || '';
  const ok = sessionToken();
  return !!password() && t.length === ok.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ok));
}
const attempts = new Map(); // ip -> intentos recientes (frena a quien pruebe contraseñas)
function loginPage(msg = '') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CuotaRadar · Acceso</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 70% -100px,#10223b,transparent 60%),#070b14;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:#e6edf7;padding:16px}
form{background:#0e1626;border:1px solid #1f2b44;border-radius:14px;padding:28px;width:min(360px,100%);display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:24px}h1 span{color:#37e2a8}input{font:inherit;padding:12px;border:1px solid #1f2b44;border-radius:8px;background:#070b14;color:#e6edf7}
input:focus{outline:none;border-color:#37e2a8}button{font:inherit;font-weight:700;padding:12px;border:0;border-radius:8px;background:#37e2a8;color:#04140d;cursor:pointer}.err{color:#ff5d6c;margin:0}</style></head>
<body><form method="post" action="/acceso"><h1>Cuota<span>Radar</span></h1><p style="margin:0">Escribe la contraseña de acceso.</p>
${msg ? `<p class="err">${msg}</p>` : ''}<input type="password" name="clave" autocomplete="current-password" autofocus required aria-label="Contraseña"><button>Entrar</button></form></body></html>`;
}

// Devuelve true si la petición ya se ha respondido (pantalla de acceso o error).
function guard(req, res, url) {
  if (!CLOUD) return false;
  if (url.pathname === '/api/version' && !req.headers.cookie) { send(res, 200, { ok: true }); return true; } // comprobación de salud de Render
  if (url.pathname === '/acceso' && req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      const html = (code, msg) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(loginPage(msg)); };
      if (recent.length >= 8) return html(429, 'Demasiados intentos. Espera 15 minutos.');
      const given = new URLSearchParams(body).get('clave') || '';
      const a = crypto.createHash('sha256').update(given).digest();
      const b = crypto.createHash('sha256').update(password()).digest();
      if (password() && crypto.timingSafeEqual(a, b)) {
        attempts.delete(ip);
        res.writeHead(303, { location: '/', 'set-cookie': `cuotaradar_sesion=${sessionToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}` });
        return res.end();
      }
      attempts.set(ip, [...recent, now]);
      html(401, 'Contraseña incorrecta.');
    });
    return true;
  }
  if (authed(req)) return false;
  if (url.pathname.startsWith('/api/')) { send(res, 401, { error: 'Acceso no autorizado' }); return true; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(loginPage());
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (guard(req, res, url)) return;
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, publicConfig());
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        // Se comprueba la clave antes de guardarla; si falla, se conserva la anterior.
        const key = cleanKey(body.apiKey);
        const problem = keyProblem(key);
        if (problem) return send(res, 400, { error: problem });
        try {
          const credits = await api.test(key);
          config.apiKey = key;
          config.keyCheckedAt = Date.now();
          api.reset();
          api.credits = credits;
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (typeof body.opKey === 'string' && body.opKey.trim()) {
        // Clave de OddsPapi: se comprueba con la consulta de cuenta (gratis) y, si falla, se conserva la anterior
        const key = cleanOpKey(body.opKey);
        if (key.length < 16) return send(res, 400, { error: `La clave de OddsPapi parece incompleta (${key.length} caracteres). Cópiala entera.` });
        try {
          await op.accountInfo(key);
          config.opKey = key;
          config.opCheckedAt = Date.now();
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (typeof body.psKey === 'string' && body.psKey.trim()) {
        // Clave de PulseScore (bet365): se comprueba antes de guardarla y, si falla, se conserva la anterior.
        const key = cleanPsKey(body.psKey);
        if (key.length < 16) return send(res, 400, { error: `La clave de PulseScore parece incompleta (${key.length} caracteres). Cópiala entera.` });
        try {
          await ps.test(key);
          config.psKey = key;
          config.psCheckedAt = Date.now();
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (body.mode === 'demo' || body.mode === 'real') config.mode = body.mode;
      if (typeof body.regions === 'string' && /^[a-z,]+$/.test(body.regions)) config.regions = body.regions;
      if (['multiplicativo', 'aditivo', 'potencia', 'shin'].includes(body.method)) config.method = body.method;
      for (const k of NUMERIC) if (body[k] !== undefined && Number.isFinite(Number(body[k]))) config[k] = Number(body[k]);
      saveConfig();
      return send(res, 200, publicConfig());
    }
    if (url.pathname === '/api/sports') return send(res, 200, { mode: config.mode, sports: await listSports() });
    if (url.pathname === '/api/scan') {
      const keys = (url.searchParams.get('sports') || '').split(',').filter(Boolean);
      return send(res, 200, await scan(keys), req);
    }
    if (url.pathname === '/api/news' && req.method === 'POST') {
      const body = await readBody(req);
      const teams = (Array.isArray(body.teams) ? body.teams : []).slice(0, 60)
        .filter((t) => t && typeof t.name === 'string' && t.name.length < 80)
        .map((t) => ({ name: t.name, sport: t.sport === 'voleibol' ? 'voleibol' : 'futbol' }));
      return send(res, 200, await newsFor(teams), req);
    }
    if (url.pathname === '/api/estimate') {
      return send(res, 200, await estimate((url.searchParams.get('sports') || '').split(',').filter(Boolean)));
    }
    if (url.pathname === '/api/scout' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await scout({
        days: body.days === 'hoy' ? 'hoy' : Math.min(7, Math.max(1, Number(body.days) || 3)),
        top: Math.min(MAX_REAL_SPORTS, Math.max(1, Number(body.top) || 5)),
        maxScout: Math.min(49, Math.max(1, Number(body.maxScout) || Math.max(20, Math.ceil((Number(body.top) || 5) * 1.5)))),
        dryRun: !!body.dryRun,
      }), req);
    }
    if (url.pathname === '/api/version') return send(res, 200, { v: version() });

    // Archivos estáticos
    let p = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!p.startsWith(PUBLIC)) return send(res, 403, { error: 'prohibido' });
    fs.readFile(p, (err, data) => {
      if (err) return send(res, 404, { error: 'no encontrado' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`CuotaRadar escuchando en http://localhost:${PORT}`));
