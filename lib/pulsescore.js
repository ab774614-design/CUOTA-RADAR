'use strict';
// Conector para PulseScore (https://pulsescore.net): cuotas de bet365.
// Plan gratuito: 500 peticiones al mes y 1 por segundo por casa. La clave va en la cabecera X-Secret.
// Se cachea todo en disco y se cuentan las peticiones del mes para no pasarse.
const fs = require('fs');
const { marketLabel } = require('./demo');

const BASE = 'https://api.pulsescore.net/api';
const MONTHLY = 500;

class PulseScore {
  constructor(cacheFile = null) {
    this.limits = { limit: null, remaining: null, reset: null };
    this.last = new Map(); // casa -> momento de la última petición (1 por segundo por casa)
    this.cacheFile = cacheFile;
    this.cache = {}; // clave -> { t, data }
    this.usage = { month: '', count: 0 };
    try {
      const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      this.cache = d.cache || {};
      this.usage = d.usage || this.usage;
    } catch {}
  }

  _save() {
    if (!this.cacheFile) return;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify({ cache: this.cache, usage: this.usage })); } catch {}
  }

  monthUsage() {
    const m = new Date().toISOString().slice(0, 7);
    if (this.usage.month !== m) this.usage = { month: m, count: 0 };
    return { used: this.usage.count, total: MONTHLY, left: Math.max(0, MONTHLY - this.usage.count) };
  }

  base(book) {
    return book === 'bet365' ? `${BASE}/v3/bet365` : `${BASE}/${book}`;
  }

  async get(apiKey, book, path, attempt = 1) {
    const wait = 1100 - (Date.now() - (this.last.get(book) || 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last.set(book, Date.now());
    const res = await fetch(`${this.base(book)}${path}`, { headers: { 'X-Secret': apiKey, accept: 'application/json' } });
    this.monthUsage();
    this.usage.count++;
    const h = (k) => res.headers.get(k);
    if (h('x-ratelimit-remaining') !== null) this.limits = { limit: Number(h('x-ratelimit-limit')), remaining: Number(h('x-ratelimit-remaining')), reset: h('x-ratelimit-reset') };
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return this.get(apiKey, book, path, attempt + 1);
    }
    const body = await res.text();
    this._save();
    if (!res.ok) {
      let msg = body;
      try { msg = JSON.parse(body).message || JSON.parse(body).error || body; } catch {}
      if (res.status === 401 || res.status === 403) throw new Error(`PulseScore no acepta la clave (${res.status}). Cópiala entera desde Dashboard → API keys.`);
      if (res.status === 429) throw new Error('PulseScore (429): se ha llegado al límite de peticiones. Espera un poco o al mes que viene.');
      throw new Error(`PulseScore ${res.status}: ${String(msg).slice(0, 200)}`);
    }
    return JSON.parse(body);
  }

  async _cached(key, ttlMs, fetcher) {
    const c = this.cache[key];
    if (c && Date.now() - c.t < ttlMs) return c.data;
    const data = await fetcher();
    this.cache[key] = { t: Date.now(), data };
    // Se limpian entradas viejas para que el archivo no crezca
    for (const [k, v] of Object.entries(this.cache)) if (Date.now() - v.t > 12 * 3600e3) delete this.cache[k];
    this._save();
    return data;
  }

  isCached(key, ttlMs) {
    const c = this.cache[key];
    return !!(c && Date.now() - c.t < ttlMs);
  }

  // Comprobación de la clave: deportes de bet365 con partidos en vivo (respuesta pequeña).
  async test(apiKey) {
    await this.get(apiKey, 'bet365', '/live-events/sports');
    return { ...this.limits };
  }

  // Todas las ligas de fútbol de bet365 con su 1X2 (unas 6 peticiones de 30 ligas). Caché de 3 horas.
  async soccerListing(apiKey) {
    return this._cached('b365|soccer|listing', 3 * 3600e3, async () => {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const r = await this.get(apiKey, 'bet365', `/soccer/leagues?limit=30&page=${page}`);
        for (const lg of r.leagues || []) for (const e of lg.events || []) if (!e.live) out.push(normalizeB365(e, 'futbol'));
        if (!r.hasNextPage) break;
      }
      return out;
    });
  }

  // Todos los mercados de los partidos de una liga de fútbol de bet365 (1 petición). Caché de 30 minutos.
  async soccerLeague(apiKey, league) {
    return this._cached(`b365|soccer|${league}`, 30 * 60e3, async () => {
      const r = await this.get(apiKey, 'bet365', `/soccer/leagues/${encodeURIComponent(league)}/events`);
      return (r.events || []).filter((e) => !e.live).map((e) => normalizeB365(e, 'futbol'));
    });
  }

  // Una liga de PS3838 (copia de las cuotas de Pinnacle): la referencia sin margen (1 petición, 30 min).
  async pinnacleLeague(apiKey, league) {
    return this._cached(`ps3838|soccer|${league}`, 30 * 60e3, async () => {
      const r = await this.get(apiKey, 'ps3838', `/soccer/leagues/${encodeURIComponent(league)}/events`);
      return (r.events || []).filter((e) => !e.live).map(normalizePs3838);
    });
  }

  // Voleibol de bet365 antes del partido, todas las ligas (1-2 peticiones). Caché de 30 minutos.
  async volleyball(apiKey) {
    return this._cached('b365|volleyball', 30 * 60e3, async () => {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const r = await this.get(apiKey, 'bet365', `/volleyball/events?limit=30&page=${page}`);
        for (const e of r.events || []) if (!e.live) out.push(normalizeB365(e, 'voleibol'));
        if (!r.hasNextPage) break;
      }
      return out;
    });
  }
}

const isHalf = (x) => Math.abs(x % 1) === 0.5;
const leagueName = (l) => String(l || '').split('||').pop().replace(/\s+/g, ' ').trim();

// Convierte un partido de bet365 (formato PulseScore) al formato de la app: un evento con la casa bet365.
function normalizeB365(e, sport) {
  const home = e.home.trim(), away = e.away.trim();
  const markets = {};
  const put = (id, sel, odds) => {
    if (!(odds > 1) || !sel) return;
    markets[id] = markets[id] || { label: marketLabel(id, sport, home, away), outcomes: {} };
    if (markets[id].outcomes[sel] === undefined) markets[id].outcomes[sel] = odds;
  };
  // Hándicap de dos opciones con media línea: local L y visitante −L
  const halfSpread = (prefix, sels) => {
    for (const h of sels.filter((s) => s.canonicalOutcome === 'HOME' && s.line !== undefined && isHalf(s.line))) {
      const a = sels.find((s) => s.canonicalOutcome === 'AWAY' && s.line === -h.line);
      if (a) { put(`${prefix}:${h.line}`, '1', h.odds); put(`${prefix}:${h.line}`, '2', a.odds); }
    }
  };
  // Más/menos con medias líneas; `side` dice si la selección es «más» o «menos».
  const ou = (prefix, s, side) => {
    if (s.line === undefined || !isHalf(s.line) || !side) return;
    put(`${prefix}:${s.line}`, `${side === 'OVER' ? 'Más' : 'Menos'} ${s.line}`, s.odds);
  };
  const sideOf = (s) => (s.canonicalOutcome === 'OVER' || s.canonicalOutcome === 'UNDER'
    ? s.canonicalOutcome
    : /^over/i.test(s.moreInfo?.HD || '') ? 'OVER' : /^under/i.test(s.moreInfo?.HD || '') ? 'UNDER' : null);
  for (const m of e.markets || []) {
    const full = m.period === 'FULL_TIME' || (sport === 'futbol' && m.canonicalMarket === 'MATCH_RESULT' && m.rawName === 'main');
    const sels = (m.selections || []).filter((s) => s.isActive !== false);
    const cm = m.canonicalMarket;
    const raw = String(m.rawName || '');
    // ---- Mercados especiales de fútbol: córners, tarjetas, disparos a puerta, hándicap europeo, descanso ----
    if (sport === 'futbol') {
      if (full && (raw === 'Corners 2-Way' || raw === 'Alternative Corners') && cm === 'CORNERS_OVER_UNDER') { for (const s of sels) ou('corners', s, sideOf(s)); continue; }
      if (full && /^Team Corners — /.test(raw)) { const p = cm === 'HOME_CORNERS_OVER_UNDER' ? 'hcorners' : cm === 'AWAY_CORNERS_OVER_UNDER' ? 'acorners' : null; if (p) for (const s of sels) ou(p, s, sideOf(s)); continue; }
      if (full && cm === 'CORNERS_HANDICAP') { halfSpread('cspread', sels); continue; }
      if (full && raw === 'Number of Cards In Match') { for (const s of sels) ou('cards', s, sideOf(s)); continue; }
      if (full && raw === 'Team Cards') { for (const s of sels) ou(s.canonicalOutcome === 'HOME' ? 'hcards' : 'acards', s, sideOf(s)); continue; }
      if (full && raw === 'Match Shots on Target') { for (const s of sels) ou('sot', s, sideOf(s)); continue; }
      if (full && raw === 'Team Shots on Target') { for (const s of sels) ou(s.canonicalOutcome === 'HOME' ? 'hsot' : 'asot', s, sideOf(s)); continue; }
      if (full && cm === 'EUROPEAN_HANDICAP') {
        // Hándicap europeo (3 resultados): la línea es la del local
        for (const s of sels) if (s.line !== undefined && Number.isInteger(s.line)) put(`eh:${s.line}`, { HOME: '1', DRAW: 'X', AWAY: '2' }[s.canonicalOutcome], s.odds);
        continue;
      }
      if (m.period === 'FIRST_HALF' && cm === 'HALF_TIME_RESULT') { for (const s of sels) put('ht', { HOME: '1', DRAW: 'X', AWAY: '2' }[s.canonicalOutcome], s.odds); continue; }
    }
    if (cm === 'MATCH_RESULT' && full) {
      for (const s of sels) put('h2h', { HOME: '1', DRAW: 'X', AWAY: '2' }[s.canonicalOutcome], s.odds);
    } else if (sport === 'futbol' && full && cm === 'DOUBLE_CHANCE') {
      for (const s of sels) put('dc', { HOME_DRAW: '1X', HOME_AWAY: '12', DRAW_AWAY: 'X2' }[s.canonicalOutcome], s.odds);
    } else if (sport === 'futbol' && full && cm === 'DRAW_NO_BET') {
      for (const s of sels) put('dnb', { HOME: '1', AWAY: '2' }[s.canonicalOutcome], s.odds);
    } else if (sport === 'futbol' && full && cm === 'BOTH_TEAMS_TO_SCORE') {
      for (const s of sels) put('btts', { YES: 'Sí', NO: 'No' }[s.canonicalOutcome], s.odds);
    } else if (full && cm === 'OVER_UNDER' && !/goal line/i.test(m.rawName)) {
      // Solo líneas de medio gol/punto (las asiáticas .25/.75 y enteras tienen devoluciones)
      for (const s of sels) if (s.line !== undefined && isHalf(s.line) && (s.canonicalOutcome === 'OVER' || s.canonicalOutcome === 'UNDER')) {
        put(`totals:${s.line}`, `${s.canonicalOutcome === 'OVER' ? 'Más' : 'Menos'} ${s.line}`, s.odds);
      }
    } else if (sport === 'futbol' && full && (cm === 'HOME_OVER_UNDER' || cm === 'AWAY_OVER_UNDER')) {
      const id = cm === 'HOME_OVER_UNDER' ? 'htotal' : 'atotal';
      for (const s of sels) if (s.line !== undefined && isHalf(s.line) && (s.canonicalOutcome === 'OVER' || s.canonicalOutcome === 'UNDER')) {
        put(`${id}:${s.line}`, `${s.canonicalOutcome === 'OVER' ? 'Más' : 'Menos'} ${s.line}`, s.odds);
      }
    } else if (full && (cm === 'ASIAN_HANDICAP' || cm === 'SET_HANDICAP')) {
      // Hándicap del local L con su pareja (visitante −L); solo medias líneas
      const homes = sels.filter((s) => s.canonicalOutcome === 'HOME' && s.line !== undefined && isHalf(s.line));
      for (const h of homes) {
        const a = sels.find((s) => s.canonicalOutcome === 'AWAY' && s.line === -h.line);
        if (a) { put(`spreads:${h.line}`, '1', h.odds); put(`spreads:${h.line}`, '2', a.odds); }
      }
    } else if (sport === 'voleibol' && cm === 'SET_BETTING') {
      // «Equipo 3-1»: si es el visitante se le da la vuelta (1-3)
      for (const s of sels) {
        const m2 = String(s.rawName).match(/^(.*)\s(\d)-(\d)$/);
        if (!m2) continue;
        const [, team, a, b] = m2;
        put('cs', team.trim() === away ? `${b}-${a}` : `${a}-${b}`, s.odds);
      }
    } else if (sport === 'voleibol' && cm === 'SET_WINNER' && m.period === 'FIRST_SET') {
      for (const s of sels) put('set1', { HOME: '1', AWAY: '2' }[s.canonicalOutcome], s.odds);
    }
  }
  delete markets.undefined;
  return {
    id: `b365-${e.eventId}`,
    b365Id: String(e.eventId),
    b365League: e.league,
    sport,
    sportKey: sport === 'voleibol' ? 'b365_volleyball' : 'b365_soccer',
    league: leagueName(e.league),
    home, away,
    commence: e.startTime,
    live: !!e.live,
    books: [{ key: 'bet365', title: 'bet365', updated: Date.now(), markets }],
  };
}

// PS3838 (copia de Pinnacle): 1X2, más/menos y hándicap asiático (solo medias líneas). Se presenta como
// la casa «pinnacle» para que el análisis la use como referencia sin margen.
function normalizePs3838(e) {
  const home = e.home.trim(), away = e.away.trim();
  const markets = {};
  const put = (id, sel, odds) => {
    if (!(odds > 1) || !sel) return;
    markets[id] = markets[id] || { label: marketLabel(id, 'futbol', home, away), outcomes: {} };
    markets[id].outcomes[sel] = odds;
  };
  for (const m of e.markets || []) {
    const sels = m.selections || [];
    if (m.period === 'FULL_TIME' && m.canonicalMarket === 'MATCH_RESULT') {
      for (const s of sels) put('h2h', { HOME: '1', DRAW: 'X', AWAY: '2' }[s.canonicalOutcome], s.odds);
    } else if (m.period === 'FULL_TIME' && m.canonicalMarket === 'OVER_UNDER') {
      for (const s of sels) if (s.line !== undefined && isHalf(s.line)) put(`totals:${s.line}`, `${s.canonicalOutcome === 'OVER' ? 'Más' : 'Menos'} ${s.line}`, s.odds);
    } else if (m.period === 'FULL_TIME' && m.canonicalMarket === 'ASIAN_HANDICAP') {
      const h = sels.find((s) => s.canonicalOutcome === 'HOME'), a = sels.find((s) => s.canonicalOutcome === 'AWAY');
      if (h && a && h.line !== undefined && isHalf(h.line)) { put(`spreads:${h.line}`, '1', h.odds); put(`spreads:${h.line}`, '2', a.odds); }
    } else if (m.period === 'FIRST_HALF' && m.canonicalMarket === 'MATCH_RESULT') {
      for (const s of sels) put('ht', { HOME: '1', DRAW: 'X', AWAY: '2' }[s.canonicalOutcome], s.odds);
    }
  }
  return {
    id: `ps-${e.eventId}`, sport: 'futbol', league: leagueName(e.league), home, away, commence: e.startTime, live: !!e.live,
    books: [{ key: 'pinnacle', title: 'Pinnacle (PS3838)', updated: Date.now(), markets }],
  };
}

// Quita espacios, comillas y caracteres invisibles que se cuelan al copiar.
function cleanPsKey(k) {
  return String(k || '').replace(/[\s"'`​-‍﻿]/g, '');
}

module.exports = { PulseScore, cleanPsKey, normalizeB365, normalizePs3838, MONTHLY };
