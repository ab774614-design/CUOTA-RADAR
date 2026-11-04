'use strict';
// Conector para OddsPapi (https://oddspapi.io): cuotas de bet365, Pinnacle y muchas más casas.
// Plan gratuito: 250 peticiones al mes (se renueva el día 1). Cada llamada facturable cuenta 1, venga lo que
// venga; /v4/account es gratis. Por eso se cachea todo en disco y se cuentan las peticiones.
const fs = require('fs');

const BASE = 'https://api.oddspapi.io/v4';

class OddsPapi {
  constructor(cacheFile = null) {
    this.cacheFile = cacheFile;
    this.cache = {}; // clave -> { t, data }
    this.account = null; // { limit, used }
    this.lastCall = 0;
    try {
      const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      this.cache = d.cache || {};
      this.account = d.account || null;
    } catch {}
  }

  _save() {
    if (!this.cacheFile) return;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify({ cache: this.cache, account: this.account })); } catch {}
  }

  async get(apiKey, path, { billable = true } = {}) {
    // Las llamadas tienen un enfriamiento de 1 segundo
    const wait = 1100 - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}apiKey=${encodeURIComponent(apiKey)}`, { headers: { accept: 'application/json' } });
    const body = await res.text();
    if (billable && this.account) { this.account.used = (this.account.used || 0) + 1; this._save(); }
    if (!res.ok) {
      let msg = body;
      try { const j = JSON.parse(body); msg = j.details || j.message || body; } catch {}
      if (res.status === 401 || res.status === 403) throw new Error(`OddsPapi no acepta la clave (${res.status}): ${String(msg).slice(0, 120)}`);
      if (res.status === 429) throw new Error('OddsPapi: se han acabado las peticiones del mes (se renuevan el día 1) o se ha llamado demasiado rápido.');
      throw new Error(`OddsPapi ${res.status}: ${String(msg).slice(0, 160)}`);
    }
    return JSON.parse(body);
  }

  // Cuenta y uso del mes (gratis)
  async accountInfo(apiKey) {
    const a = await this.get(apiKey, '/account', { billable: false });
    const sub = Array.isArray(a.subscriptions) ? a.subscriptions[0] : a.subscription || a;
    const limit = Number(sub?.request_limit ?? a.request_limit);
    const used = Number(sub?.request_count ?? a.request_count);
    this.account = { limit: Number.isFinite(limit) ? limit : null, used: Number.isFinite(used) ? used : null, raw: undefined };
    this._save();
    return { ...this.account, data: a };
  }

  async _cached(key, ttlMs, fetcher) {
    const c = this.cache[key];
    if (c && Date.now() - c.t < ttlMs) return c.data;
    const data = await fetcher();
    this.cache[key] = { t: Date.now(), data };
    for (const [k, v] of Object.entries(this.cache)) if (k.startsWith('odds|') && Date.now() - v.t > 12 * 3600e3) delete this.cache[k];
    this._save();
    return data;
  }

  isCached(key, ttlMs) {
    const c = this.cache[key];
    return !!(c && Date.now() - c.t < ttlMs);
  }

  // Definiciones de mercados (cambian muy poco: caché de 30 días)
  markets(apiKey) {
    return this._cached('markets', 30 * 864e5, async () => {
      const list = await this.get(apiKey, '/markets?language=en');
      const map = {};
      for (const m of list) {
        map[m.marketId] = { name: m.marketName, handicap: m.handicap, period: m.period, type: m.marketType, sportId: m.sportId, prop: m.playerProp, outcomes: Object.fromEntries((m.outcomes || []).map((o) => [o.outcomeId, o.outcomeName])) };
      }
      return map;
    });
  }

  // Equipos de un deporte (caché de 7 días)
  participants(apiKey, sportId) {
    return this._cached(`participants|${sportId}`, 7 * 864e5, async () => {
      const list = await this.get(apiKey, `/participants?sportId=${sportId}&language=en`);
      const arr = Array.isArray(list) ? list : Object.entries(list).map(([id, name]) => ({ participantId: Number(id), participantName: name }));
      return Object.fromEntries(arr.map((p) => [p.participantId ?? p.id, p.participantName ?? p.name]));
    });
  }

  // Ligas de un deporte (caché de 7 días)
  tournaments(apiKey, sportId) {
    return this._cached(`tournaments|${sportId}`, 7 * 864e5, () => this.get(apiKey, `/tournaments?sportId=${sportId}&language=en`));
  }

  // Cuotas de hasta 3 ligas de una casa en 1 petición (caché de 30 min)
  oddsByTournaments(apiKey, bookmaker, ids) {
    const key = `odds|${bookmaker}|${[...ids].sort().join(',')}`;
    return this._cached(key, 30 * 60e3, () => this.get(apiKey, `/odds-by-tournaments?bookmaker=${encodeURIComponent(bookmaker)}&tournamentIds=${ids.join(',')}&oddsFormat=decimal&language=en`));
  }
}

// ---------- De OddsPapi al formato de la app ----------
const { marketLabel } = require('./demo');
const isHalf = (x) => Math.abs(x % 1) === 0.5;
const BOOK_TITLES = { bet365: 'bet365', pinnacle: 'Pinnacle' };

// Tipo de mercado de OddsPapi (con periodo) → prefijo de la app. Solo partido completo (y 1X2 al descanso).
const TOTALS = { totals: 'totals', 'totals-corners': 'corners', 'totals-bookings': 'cards', 'teamtotals-team1': 'htotal', 'teamtotals-team2': 'atotal', 'teamtotals-corners-team1': 'hcorners', 'teamtotals-corners-team2': 'acorners', 'teamtotals-bookings-team1': 'hcards', 'teamtotals-bookings-team2': 'acards' };
const SPREADS = { spreads: 'spreads', 'spreads-corners': 'cspread' };

function mapMarket(def) {
  if (!def || def.prop) return null;
  const h = Number(def.handicap);
  if (def.period === 'p1') return def.type === '1x2' ? { id: 'ht', sel: (n) => ({ 1: '1', X: 'X', 2: '2' }[n]) } : null;
  if (def.period !== 'fulltime') return null;
  if (def.type === '1x2') return { id: 'h2h', sel: (n) => ({ 1: '1', X: 'X', 2: '2' }[n]) };
  if (TOTALS[def.type] && isHalf(h)) return { id: `${TOTALS[def.type]}:${h}`, sel: (n) => (/^over$/i.test(n) ? `Más ${h}` : /^under$/i.test(n) ? `Menos ${h}` : null) };
  if (SPREADS[def.type] && isHalf(h)) return { id: `${SPREADS[def.type]}:${h}`, sel: (n) => ({ 1: '1', 2: '2' }[n]) };
  if (def.type === 'spreads-european' && Number.isInteger(h)) return { id: `eh:${h}`, sel: (n) => ({ 1: '1', X: 'X', 2: '2' }[n]) };
  if (def.type === 'bothteamsscore') return { id: 'btts', sel: (n) => ({ Yes: 'Sí', No: 'No' }[n]) };
  if (def.type === 'drawnobet') return { id: 'dnb', sel: (n) => ({ 1: '1', 2: '2' }[n]) };
  if (def.type === 'doublechance') return { id: 'dc', sel: (n) => ({ '1X': '1X', 12: '12', '2X': 'X2', X2: 'X2' }[n]) };
  return null;
}

// `lists`: [{ bookmaker, data }]. Une los partidos de todas las casas por su fixtureId (es el mismo en todas).
function normalizeOddsPapi(lists, markets, participants, leagues) {
  const byId = new Map();
  for (const { bookmaker, data } of lists) {
    for (const f of Array.isArray(data) ? data : []) {
      if (f.statusId >= 2) continue; // en juego o terminado
      const home = participants[f.participant1Id] || `Equipo ${f.participant1Id}`;
      const away = participants[f.participant2Id] || `Equipo ${f.participant2Id}`;
      let ev = byId.get(f.fixtureId);
      if (!ev) {
        const lg = leagues[f.tournamentId] || {};
        ev = { id: `op-${f.fixtureId}`, sport: 'futbol', sportKey: lg.key || `op_${f.tournamentId}`, league: lg.name || `Liga ${f.tournamentId}`, home, away, commence: f.startTime, live: false, books: [] };
        byId.set(f.fixtureId, ev);
      }
      const bo = f.bookmakerOdds && f.bookmakerOdds[bookmaker];
      if (!bo || bo.suspended) continue;
      const out = {};
      for (const [mid, m] of Object.entries(bo.markets || {})) {
        if (m.marketActive === false) continue;
        const def = markets[mid];
        const mm = mapMarket(def);
        if (!mm) continue;
        for (const [oid, o] of Object.entries(m.outcomes || {})) {
          const p = o.players && o.players['0'];
          const sel = mm.sel(def.outcomes[oid]);
          if (!p || p.active === false || !sel || !(p.price > 1)) continue;
          out[mm.id] = out[mm.id] || { label: marketLabel(mm.id, 'futbol', home, away), outcomes: {} };
          out[mm.id].outcomes[sel] = p.price;
        }
      }
      ev.books.push({ key: bookmaker, title: BOOK_TITLES[bookmaker] || bookmaker, updated: Date.now(), markets: out });
    }
  }
  return [...byId.values()];
}

function cleanOpKey(k) {
  return String(k || '').replace(/[\s"'`​-‍﻿]/g, '');
}

module.exports = { OddsPapi, cleanOpKey, normalizeOddsPapi, mapMarket };
