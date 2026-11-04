'use strict';
// Conector para The Odds API (https://the-odds-api.com). Cada petición de cuotas gasta créditos
// (mercados × regiones), así que se cachea por competición y no se repite antes del TTL.
const { marketLabel } = require('./demo');

const BASE = 'https://api.the-odds-api.com/v4';

const fs = require('fs');

// Coste en créditos de una petición de cuotas: un crédito por mercado y región.
const costOf = (markets, regions) => markets.split(',').length * regions.split(',').length;

class OddsApi {
  constructor(cacheFile = null) {
    this.cache = new Map(); // liga|regiones|mercados -> { t, events }
    this.eventsCache = new Map(); // liga -> { t, list } (gratis, pero se cachea igual)
    this.sportsCache = null;
    this.credits = { remaining: null, used: null };
    this.cacheFile = cacheFile;
    this._load();
  }

  // La caché se guarda en disco: reiniciar la app no obliga a volver a pagar por las mismas cuotas.
  _load() {
    if (!this.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [k, v] of Object.entries(data.odds || {})) if (Date.now() - v.t < 6 * 3600e3) this.cache.set(k, v);
      if (data.credits) this.credits = data.credits;
    } catch {}
  }

  _save() {
    if (!this.cacheFile) return;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify({ odds: Object.fromEntries(this.cache), credits: this.credits }));
    } catch {}
  }

  _cached(key, ttlSec) {
    const c = this.cache.get(key);
    return c && Date.now() - c.t < ttlSec * 1000 ? c : null;
  }

  // Créditos que gastaría pedir estas ligas ahora (lo que está en caché no cuenta).
  estimate(sportKeys, { regions = 'eu', markets = 'h2h,totals,spreads', ttlSec = 600 } = {}) {
    let total = 0;
    for (const k of sportKeys) {
      for (const m of markets.split(',')) if (!this._cached(`${k}|${regions}|${m}`, ttlSec)) total += costOf(m, regions);
    }
    return total;
  }

  async _get(url, attempt = 1) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    // 429 con créditos disponibles = demasiadas peticiones seguidas: se espera un poco y se reintenta.
    if (res.status === 429 && attempt < 4 && this.credits.remaining !== 0) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return this._get(url, attempt + 1);
    }
    const rem = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (rem !== null) this.credits = { remaining: Number(rem), used: Number(used) };
    const body = await res.text();
    if (!res.ok) {
      let msg = body;
      try { msg = JSON.parse(body).message || body; } catch {}
      const err = new Error(explainError(res.status, msg));
      err.status = res.status;
      throw err;
    }
    return JSON.parse(body);
  }

  // Comprueba una clave sin gastar créditos (el listado de deportes es gratis).
  async test(apiKey) {
    await this._get(`${BASE}/sports?apiKey=${encodeURIComponent(apiKey)}`);
    return { ...this.credits };
  }

  reset() {
    this.cache.clear();
    this.eventsCache.clear();
    this.sportsCache = null;
    this.credits = { remaining: null, used: null };
    this._save();
  }

  async sports(apiKey) {
    if (this.sportsCache && Date.now() - this.sportsCache.t < 6 * 3600 * 1000) return this.sportsCache.list;
    // El listado de deportes no gasta créditos.
    const all = await this._get(`${BASE}/sports?apiKey=${encodeURIComponent(apiKey)}`);
    const list = all
      .filter((s) => s.group === 'Soccer' || /volley/i.test(s.group + ' ' + s.title))
      .filter((s) => !s.has_outrights)
      .map((s) => ({
        key: s.key,
        title: s.title,
        sport: s.group === 'Soccer' ? 'futbol' : 'voleibol',
        group: s.group === 'Soccer' ? 'Fútbol' : 'Voleibol',
      }));
    this.sportsCache = { t: Date.now(), list };
    return list;
  }

  // Partidos de una liga sin cuotas: no gasta créditos.
  async events(apiKey, sport) {
    const c = this.eventsCache.get(sport.key);
    if (c && Date.now() - c.t < 30 * 60e3) return c.list;
    const list = await this._get(`${BASE}/sports/${encodeURIComponent(sport.key)}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`);
    this.eventsCache.set(sport.key, { t: Date.now(), list });
    return list;
  }

  // Cuotas de una liga. Cada mercado se cachea por separado, así lo que ya se pidió en el rastreo
  // (solo 1X2) no se vuelve a pagar en la búsqueda completa: solo se piden los mercados que faltan.
  async odds(apiKey, sport, { regions = 'eu', ttlSec = 600, markets = 'h2h,totals,spreads' } = {}) {
    const wanted = markets.split(',');
    const missing = wanted.filter((m) => !this._cached(`${sport.key}|${regions}|${m}`, ttlSec));
    if (missing.length) {
      const url = `${BASE}/sports/${encodeURIComponent(sport.key)}/odds?apiKey=${encodeURIComponent(apiKey)}` +
        `&regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(missing.join(','))}&oddsFormat=decimal&dateFormat=iso`;
      const raw = await this._get(url);
      const events = raw.map((e) => normalize(e, sport));
      const t = Date.now();
      // Se guarda cada mercado por separado
      for (const m of missing) this.cache.set(`${sport.key}|${regions}|${m}`, { t, events: onlyMarket(events, m) });
      this._save();
    }
    return mergeEvents(wanted.map((m) => this.cache.get(`${sport.key}|${regions}|${m}`).events));
  }
}

const marketKind = (id) => (id === 'h2h' ? 'h2h' : id.split(':')[0]);

function onlyMarket(events, m) {
  return events.map((e) => ({
    ...e,
    books: e.books.map((b) => ({
      ...b,
      markets: Object.fromEntries(Object.entries(b.markets).filter(([id]) => marketKind(id) === m)),
    })),
  }));
}

// Junta en un solo evento los mercados que llegaron en peticiones distintas.
function mergeEvents(lists) {
  const byId = new Map();
  for (const list of lists) for (const e of list) {
    const cur = byId.get(e.id);
    if (!cur) { byId.set(e.id, { ...e, books: e.books.map((b) => ({ ...b, markets: { ...b.markets } })) }); continue; }
    for (const b of e.books) {
      const cb = cur.books.find((x) => x.key === b.key);
      if (cb) { Object.assign(cb.markets, b.markets); cb.updated = Math.min(cb.updated, b.updated); }
      else cur.books.push({ ...b, markets: { ...b.markets } });
    }
  }
  return [...byId.values()];
}

function explainError(status, msg) {
  if (status === 401) return 'The Odds API no acepta la clave (401). Comprueba que la has copiado entera: son 32 letras y números.';
  if (status === 429) return 'The Odds API (429): se han acabado los créditos del mes o se le han pedido demasiadas cosas seguidas. Espera un minuto y vuelve a probar.';
  return `The Odds API ${status}: ${msg || 'error desconocido'}`;
}

// Quita espacios, saltos de línea, comillas y caracteres invisibles que se cuelan al copiar.
function cleanKey(k) {
  return String(k || '').replace(/[\s"'`​-‍﻿]/g, '');
}

// Las claves de The Odds API son 32 caracteres hexadecimales.
function keyProblem(k) {
  if (!k) return 'La clave está vacía.';
  if (!/^[0-9a-f]+$/i.test(k)) return 'La clave solo puede tener números y letras de la a a la f. Revisa que no hayas copiado otro texto del correo.';
  if (k.length !== 32) return `La clave tiene ${k.length} caracteres y las de The Odds API tienen 32: ${k.length < 32 ? 'falta un trozo' : 'sobra algo'}. Vuelve a copiarla entera del correo.`;
  return null;
}

function normalize(e, sport) {
  const now = Date.now();
  return {
    id: e.id,
    sport: sport.sport,
    sportKey: sport.key,
    league: sport.title,
    home: e.home_team,
    away: e.away_team,
    commence: e.commence_time,
    live: new Date(e.commence_time).getTime() < now,
    books: (e.bookmakers || []).map((b) => {
      const markets = {};
      for (const m of b.markets || []) {
        if (m.key === 'h2h') {
          const outcomes = {};
          for (const o of m.outcomes) {
            const sel = o.name === e.home_team ? '1' : o.name === e.away_team ? '2' : /draw/i.test(o.name) ? 'X' : null;
            if (sel) outcomes[sel] = o.price;
          }
          markets.h2h = { label: marketLabel('h2h', sport.sport, e.home_team, e.away_team), outcomes };
        } else if (m.key === 'spreads') {
          // Solo líneas de medio punto (±0.5, ±1.5…): las enteras y las de cuarto tienen devoluciones parciales.
          const home = m.outcomes.find((o) => o.name === e.home_team);
          const away = m.outcomes.find((o) => o.name === e.away_team);
          if (home && away && Math.abs(home.point % 1) === 0.5) {
            const id = `spreads:${home.point}`;
            markets[id] = { label: marketLabel(id, sport.sport, e.home_team, e.away_team), outcomes: { '1': home.price, '2': away.price } };
          }
        } else if (m.key === 'totals') {
          // Puede haber varias líneas: se agrupa cada una como mercado aparte.
          for (const o of m.outcomes) {
            // Solo líneas de medio gol: en 2, 2.25 o 2.75 hay devoluciones totales o parciales.
            if (o.point === undefined || Math.abs(o.point % 1) !== 0.5) continue;
            const id = `totals:${o.point}`;
            markets[id] = markets[id] || { label: marketLabel(id, sport.sport, e.home_team, e.away_team), outcomes: {} };
            const sel = /over/i.test(o.name) ? `Más ${o.point}` : `Menos ${o.point}`;
            markets[id].outcomes[sel] = o.price;
          }
        }
      }
      return { key: b.key, title: b.title, updated: new Date(b.last_update).getTime(), markets };
    }),
  };
}

module.exports = { OddsApi, normalize, cleanKey, keyProblem, mergeEvents, costOf };
