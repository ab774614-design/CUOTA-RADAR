'use strict';
// Simulador de mercado para el modo DEMO: partidos de fútbol y voleibol con cuotas que se mueven,
// casas que reaccionan con retraso (líneas desfasadas) y errores inyectados de vez en cuando.

const LEAGUES = [
  { key: 'demo_laliga', sport: 'futbol', title: 'LaLiga', teams: ['Real Madrid', 'FC Barcelona', 'Atlético de Madrid', 'Athletic Club', 'Real Sociedad', 'Villarreal', 'Real Betis', 'Sevilla', 'Valencia', 'Girona', 'Celta', 'Osasuna'] },
  { key: 'demo_laliga2', sport: 'futbol', title: 'LaLiga Hypermotion', teams: ['Racing', 'Sporting', 'Real Zaragoza', 'Málaga', 'Deportivo', 'Almería', 'Granada', 'Cádiz', 'Huesca', 'Eibar'] },
  { key: 'demo_premier', sport: 'futbol', title: 'Premier League', teams: ['Arsenal', 'Liverpool', 'Manchester City', 'Chelsea', 'Manchester United', 'Tottenham', 'Newcastle', 'Aston Villa', 'Brighton', 'West Ham'] },
  { key: 'demo_seriea', sport: 'futbol', title: 'Serie A', teams: ['Inter', 'Milan', 'Juventus', 'Napoli', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina', 'Bologna', 'Torino'] },
  { key: 'demo_bundesliga', sport: 'futbol', title: 'Bundesliga', teams: ['Bayern', 'Leverkusen', 'Dortmund', 'Leipzig', 'Stuttgart', 'Frankfurt', 'Freiburg', 'Wolfsburg'] },
  { key: 'demo_ligue1', sport: 'futbol', title: 'Ligue 1', teams: ['PSG', 'Marseille', 'Monaco', 'Lyon', 'Lille', 'Nice', 'Lens', 'Rennes'] },
  { key: 'demo_ucl', sport: 'futbol', title: 'Champions League', teams: ['Real Madrid', 'Manchester City', 'Bayern', 'PSG', 'Inter', 'Arsenal', 'Barcelona', 'Benfica'] },
  { key: 'demo_mls', sport: 'futbol', title: 'MLS', teams: ['Inter Miami', 'LA Galaxy', 'LAFC', 'Seattle Sounders', 'Columbus Crew', 'Atlanta United'] },
  { key: 'demo_brasil', sport: 'futbol', title: 'Brasileirão', teams: ['Flamengo', 'Palmeiras', 'São Paulo', 'Corinthians', 'Fluminense', 'Botafogo', 'Grêmio', 'Atlético Mineiro'] },
  { key: 'demo_vol_superliga', sport: 'voleibol', title: 'Superliga Masculina (ESP)', teams: ['Guaguas', 'Río Duero Soria', 'Teruel', 'Melilla', 'Palma Mallorca', 'Unicaja Almería', 'Léleman Valencia', 'Arenal Emevé'] },
  { key: 'demo_vol_superliga_f', sport: 'voleibol', title: 'Superliga Femenina (ESP)', teams: ['Tenerife Libby\'s', 'Valeriano Allés Menorca', 'Avarvarii Vallduxense', 'Haris', 'Sanaya Libby\'s', 'Costa del Voley', 'Kiele Socuéllamos', 'Gran Canaria'] },
  { key: 'demo_vol_superlega', sport: 'voleibol', title: 'SuperLega (ITA)', teams: ['Trentino', 'Perugia', 'Civitanova', 'Piacenza', 'Modena', 'Monza', 'Verona', 'Milano'] },
  { key: 'demo_vol_plusliga', sport: 'voleibol', title: 'PlusLiga (POL)', teams: ['Jastrzębski', 'ZAKSA', 'Projekt Warszawa', 'Resovia', 'Aluron Zawiercie', 'Skra Bełchatów'] },
  { key: 'demo_vol_cev', sport: 'voleibol', title: 'CEV Champions League', teams: ['Trentino', 'Perugia', 'Jastrzębski', 'Halkbank', 'Ziraat', 'Berlin Recycling'] },
];

const BOOKS = [
  { key: 'pinnacle', title: 'Pinnacle', margin: 0.025, lag: 0.95, noise: 0.004 },
  { key: 'betfair_ex_eu', title: 'Betfair Exchange', margin: 0.012, lag: 0.9, noise: 0.006 },
  { key: 'bet365', title: 'bet365', margin: 0.06, lag: 0.45, noise: 0.012 },
  { key: 'williamhill', title: 'William Hill', margin: 0.065, lag: 0.4, noise: 0.012 },
  { key: 'bwin', title: 'bwin', margin: 0.07, lag: 0.35, noise: 0.014 },
  { key: 'codere', title: 'Codere', margin: 0.075, lag: 0.3, noise: 0.016 },
  { key: 'sportium', title: 'Sportium', margin: 0.075, lag: 0.3, noise: 0.016 },
  { key: 'unibet', title: 'Unibet', margin: 0.06, lag: 0.45, noise: 0.012 },
  { key: 'betway', title: 'Betway', margin: 0.065, lag: 0.4, noise: 0.013 },
  { key: 'marathonbet', title: 'Marathonbet', margin: 0.045, lag: 0.55, noise: 0.01 },
  { key: 'retabet', title: 'Retabet', margin: 0.07, lag: 0.25, noise: 0.018 },
  { key: '888sport', title: '888sport', margin: 0.07, lag: 0.35, noise: 0.015 },
];

const TICK_MS = 5000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poissonPmf(k, l) {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return Math.exp(-l) * Math.pow(l, k) / f;
}

function footballProbs(lh, la, line) {
  let h = 0, d = 0, a = 0, over = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = poissonPmf(i, lh) * poissonPmf(j, la);
    if (i > j) h += p; else if (i === j) d += p; else a += p;
    if (i + j > line) over += p;
  }
  const s = h + d + a;
  return { h2h: { '1': h / s, X: d / s, '2': a / s }, over };
}

function roundOdds(o) {
  if (o < 2) return Math.round(o * 100) / 100;
  if (o < 4) return Math.round(o * 50) / 50;
  if (o < 10) return Math.round(o * 10) / 10;
  return Math.round(o * 2) / 2;
}

function priceMarket(probs, margin, noise, r, bias) {
  // Margen repartido de forma proporcional (multiplicativo) y un sesgo propio de cada casa que cambia
  // despacio (no se recalcula de cero en cada actualización, como en una casa real).
  const out = {};
  for (const [k, p] of Object.entries(probs)) {
    if (bias[k] === undefined) bias[k] = (r() - 0.5) * 2 * noise;
    bias[k] = Math.max(-noise, Math.min(noise, bias[k] * 0.97 + (r() - 0.5) * noise * 0.2));
    const pn = Math.min(0.97, Math.max(0.004, p * (1 + bias[k])));
    out[k] = Math.max(1.01, roundOdds(1 / (pn * (1 + margin))));
  }
  return out;
}

// ---------- Todos los mercados a partir del modelo de cada partido ----------

const FB_TOTALS = [1.5, 2.5, 3.5];

// Fútbol: Poisson para cada equipo → 1X2, doble oportunidad, empate no apuesta, más/menos, ambos marcan,
// goles por equipo, hándicap asiático (líneas de medio gol, sin devolución) y resultado exacto.
function footballMarkets(lh, la) {
  const N = 10;
  const M = [];
  for (let i = 0; i <= N; i++) { M[i] = []; for (let j = 0; j <= N; j++) M[i][j] = poissonPmf(i, lh) * poissonPmf(j, la); }
  const sum = (f) => { let s = 0; for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) if (f(i, j)) s += M[i][j]; return s; };
  const tot = sum(() => true);
  const P = (f) => sum(f) / tot;
  const p1 = P((i, j) => i > j), pX = P((i, j) => i === j), p2 = P((i, j) => i < j);
  const out = {
    h2h: { '1': p1, X: pX, '2': p2 },
    dc: { '1X': p1 + pX, '12': p1 + p2, X2: pX + p2 },
    dnb: { '1': p1 / (p1 + p2), '2': p2 / (p1 + p2) },
    btts: { 'Sí': P((i, j) => i > 0 && j > 0), No: P((i, j) => i === 0 || j === 0) },
    'spreads:-1.5': { '1': P((i, j) => i - j >= 2), '2': P((i, j) => i - j < 2) },
    'spreads:1.5': { '1': P((i, j) => i - j >= -1), '2': P((i, j) => i - j < -1) },
    'htotal:1.5': { 'Más 1.5': P((i) => i >= 2), 'Menos 1.5': P((i) => i < 2) },
    'atotal:1.5': { 'Más 1.5': P((i, j) => j >= 2), 'Menos 1.5': P((i, j) => j < 2) },
  };
  for (const L of FB_TOTALS) out[`totals:${L}`] = { [`Más ${L}`]: P((i, j) => i + j > L), [`Menos ${L}`]: P((i, j) => i + j < L) };
  const cs = {};
  let rest = 1;
  for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) { const p = M[i][j] / tot; cs[`${i}-${j}`] = p; rest -= p; }
  cs.Otro = Math.max(rest, 0.001);
  out.cs = cs;
  return out;
}

function normCdf(x) {
  // Aproximación de Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Puntos medios según el número de sets (el 5.º se juega a 15).
const VB_POINTS = { 3: [138, 8], 4: [184, 9.5], 5: [212, 10.5] };

// Voleibol (al mejor de 5): ps = probabilidad de que el local gane un set → ganador, resultado exacto en sets,
// más/menos sets, hándicap de sets, ganador del 1.er set y más/menos puntos.
function volleyMarkets(ps, pace, lines) {
  const p = ps, q = 1 - ps;
  const s = { '3-0': p ** 3, '3-1': 3 * p ** 3 * q, '3-2': 6 * p ** 3 * q ** 2, '0-3': q ** 3, '1-3': 3 * q ** 3 * p, '2-3': 6 * q ** 3 * p ** 2 };
  const nSets = { 3: s['3-0'] + s['0-3'], 4: s['3-1'] + s['1-3'], 5: s['3-2'] + s['2-3'] };
  const pHome = s['3-0'] + s['3-1'] + s['3-2'];
  const out = {
    h2h: { '1': pHome, '2': 1 - pHome },
    cs: { ...s },
    'sets:3.5': { 'Más 3.5': nSets[4] + nSets[5], 'Menos 3.5': nSets[3] },
    'sets:4.5': { 'Más 4.5': nSets[5], 'Menos 4.5': nSets[3] + nSets[4] },
    'spreads:-1.5': { '1': s['3-0'] + s['3-1'], '2': 1 - s['3-0'] - s['3-1'] },
    'spreads:1.5': { '1': 1 - s['0-3'] - s['1-3'], '2': s['0-3'] + s['1-3'] },
    set1: { '1': p, '2': q },
  };
  for (const L of lines) {
    let over = 0;
    for (const n of [3, 4, 5]) {
      const [mu, sd] = VB_POINTS[n];
      over += nSets[n] * (1 - normCdf((L - mu - pace) / sd));
    }
    out[`totals:${L}`] = { [`Más ${L}`]: over, [`Menos ${L}`]: 1 - over };
  }
  return out;
}

// Los mercados raros llevan más margen, como en las casas reales.
function marginFor(m, base) {
  const k = m.split(':')[0];
  const mult = { cs: 3, htotal: 1.3, atotal: 1.3, set1: 1.1, btts: 1.1, sets: 1.2, spreads: 1.05 }[k] || 1;
  return base * mult;
}

class DemoMarket {
  constructor(seed = Date.now()) {
    this.r = rng(seed);
    this.events = [];
    this.lastTick = Date.now();
    this.tickCount = 0;
    this._build();
  }

  _build() {
    const r = this.r;
    const now = Date.now();
    let n = 0;
    for (const lg of LEAGUES) {
      const teams = [...lg.teams].sort(() => r() - 0.5);
      for (let i = 0; i + 1 < teams.length; i += 2) {
        const live = r() < 0.25;
        const commence = live ? now - Math.floor(r() * 70) * 60000 : now + Math.floor(20 + r() * 72 * 60) * 60000;
        const ev = { id: `demo-${++n}`, sport: lg.sport, sportKey: lg.key, league: lg.title, home: teams[i], away: teams[i + 1], commence: new Date(commence).toISOString(), live };
        if (lg.sport === 'futbol') {
          ev.lh = 0.8 + r() * 1.3;
          ev.la = 0.6 + r() * 1.2;
        } else {
          ev.ps = 0.3 + r() * 0.4;
          ev.pace = (r() - 0.5) * 10;
          // Líneas de puntos fijas para todo el partido, alrededor de la media esperada.
          const mid = Math.round(volleyExpectedPoints(ev.ps) + ev.pace);
          ev.lines = [mid - 7.5, mid - 0.5, mid + 6.5];
        }
        const marketIds = Object.keys(this._trueProbs(ev));
        ev.books = BOOKS.filter(() => r() < 0.85).map((b) => ({ ...b, quoted: null, errors: {} }));
        if (!ev.books.find((b) => b.key === 'bet365')) ev.books.push({ ...BOOKS[2], quoted: null, errors: {} });
        // Cada casa ofrece casi todos los mercados; el resultado exacto, menos casas.
        for (const b of ev.books) b.offers = marketIds.filter((m) => m === 'h2h' || r() < (m === 'cs' ? 0.6 : 0.85));
        this.events.push(ev);
      }
    }
    this.events.forEach((ev) => this._quoteAll(ev, true));
    // Calentamiento: el mercado arranca ya con movimientos y algún error activo.
    for (let i = 0; i < 40; i++) this._step();
  }

  _step() {
    this.tickCount++;
    for (const ev of this.events) {
      this._drift(ev);
      this._quoteAll(ev, false);
      this._injectErrors(ev);
    }
  }

  _trueProbs(ev) {
    return ev.sport === 'futbol' ? footballMarkets(ev.lh, ev.la) : volleyMarkets(ev.ps, ev.pace, ev.lines);
  }

  _quoteAll(ev, force) {
    const probs = this._trueProbs(ev);
    for (const b of ev.books) {
      if (!force && this.r() > b.lag) continue; // casa lenta: aún no actualiza
      b.quoted = {};
      b.bias = b.bias || {};
      for (const m of b.offers) {
        b.quoted[m] = priceMarket(probs[m], marginFor(m, b.margin), b.noise, this.r, (b.bias[m] = b.bias[m] || {}));
      }
      b.updated = Date.now();
    }
  }

  _drift(ev) {
    const r = this.r;
    const speed = ev.live ? 3 : 1;
    if (ev.sport === 'futbol') {
      ev.lh = Math.min(3.2, Math.max(0.3, ev.lh * (1 + (r() - 0.5) * 0.015 * speed)));
      ev.la = Math.min(3, Math.max(0.25, ev.la * (1 + (r() - 0.5) * 0.015 * speed)));
      if (r() < 0.01 * speed) ev.lh *= r() < 0.5 ? 0.85 : 1.18; // noticia (lesión, alineación…)
    } else {
      ev.ps = Math.min(0.85, Math.max(0.15, ev.ps + (r() - 0.5) * 0.005 * speed));
      ev.pace = Math.min(8, Math.max(-8, ev.pace + (r() - 0.5) * 0.4 * speed));
      if (r() < 0.01 * speed) ev.ps = Math.min(0.85, Math.max(0.15, ev.ps + (r() < 0.5 ? -0.05 : 0.05)));
    }
  }

  _injectErrors(ev) {
    const r = this.r;
    for (const b of ev.books) {
      for (const [k, e] of Object.entries(b.errors)) if (--e.ttl <= 0) delete b.errors[k];
      if (b.key === 'pinnacle' || b.key.startsWith('betfair')) continue;
      if (r() < 0.0008) {
        const markets = Object.keys(b.quoted);
        const m = markets[Math.floor(r() * markets.length)];
        const sels = Object.keys(b.quoted[m]);
        const s = sels[Math.floor(r() * sels.length)];
        const kind = r();
        // 0-0.7: cuota algo inflada (valor); 0.7-0.92: error grande (palpable); resto: cuotas invertidas
        const factor = kind < 0.7 ? 1.06 + r() * 0.1 : kind < 0.92 ? 1.3 + r() * 0.9 : null;
        b.errors[`${m}|${s}`] = { m, s, factor, swap: factor === null, ttl: 12 + Math.floor(r() * 50) }; // entre 1 y 5 minutos
      }
    }
  }

  tick() {
    const now = Date.now();
    const steps = Math.min(30, Math.floor((now - this.lastTick) / TICK_MS));
    for (let i = 0; i < steps; i++) this._step();
    if (steps > 0) this.lastTick = now;
  }

  sports() {
    return LEAGUES.map((l) => ({ key: l.key, title: l.title, sport: l.sport, group: l.sport === 'futbol' ? 'Fútbol' : 'Voleibol' }));
  }

  snapshot(sportKeys) {
    this.tick();
    const wanted = sportKeys && sportKeys.length ? new Set(sportKeys) : null;
    return this.events
      .filter((ev) => !wanted || wanted.has(ev.sportKey))
      .map((ev) => ({
        id: ev.id, sport: ev.sport, sportKey: ev.sportKey, league: ev.league, home: ev.home, away: ev.away,
        commence: ev.commence, live: ev.live,
        books: ev.books.map((b) => {
          const markets = {};
          for (const [m, out] of Object.entries(b.quoted)) {
            const o = { ...out };
            for (const e of Object.values(b.errors)) {
              if (e.m !== m) continue;
              if (e.swap) {
                const ks = Object.keys(o);
                const a = ks[0], z = ks[ks.length - 1];
                [o[a], o[z]] = [o[z], o[a]];
              } else if (o[e.s]) o[e.s] = roundOdds(o[e.s] * e.factor);
            }
            markets[m] = { label: marketLabel(m, ev.sport, ev.home, ev.away), outcomes: o };
          }
          return { key: b.key, title: b.title, updated: b.updated, markets };
        }),
      }));
  }
}

function volleyExpectedPoints(ps) {
  const p = ps, q = 1 - ps;
  const n3 = p ** 3 + q ** 3, n4 = 3 * p ** 3 * q + 3 * q ** 3 * p, n5 = 1 - n3 - n4;
  return n3 * VB_POINTS[3][0] + n4 * VB_POINTS[4][0] + n5 * VB_POINTS[5][0];
}

const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

function marketLabel(m, sport, home = 'Local', away = 'Visitante') {
  const fb = sport === 'futbol';
  const [k, v] = m.split(':');
  switch (k) {
    case 'h2h': return fb ? '1X2' : 'Ganador del partido';
    case 'dc': return 'Doble oportunidad';
    case 'dnb': return 'Empate no apuesta';
    case 'btts': return 'Ambos equipos marcan';
    case 'totals': return `Más/Menos ${v} ${fb ? 'goles' : 'puntos'}`;
    case 'htotal': return `Goles de ${home}: más/menos ${v}`;
    case 'atotal': return `Goles de ${away}: más/menos ${v}`;
    case 'spreads': return `Hándicap ${fb ? 'asiático' : 'de sets'} ${home} ${signed(Number(v))}`;
    case 'sets': return `Más/Menos ${v} sets`;
    case 'set1': return 'Ganador del 1.er set';
    case 'cs': return fb ? 'Resultado exacto' : 'Resultado exacto en sets';
    case 'ht': return 'Resultado al descanso';
    case 'eh': return `Hándicap europeo ${home} ${signed(Number(v))}`;
    case 'corners': return `Córners: más/menos ${v}`;
    case 'hcorners': return `Córners de ${home}: más/menos ${v}`;
    case 'acorners': return `Córners de ${away}: más/menos ${v}`;
    case 'cspread': return `Hándicap de córners ${home} ${signed(Number(v))}`;
    case 'cards': return `Tarjetas: más/menos ${v}`;
    case 'hcards': return `Tarjetas de ${home}: más/menos ${v}`;
    case 'acards': return `Tarjetas de ${away}: más/menos ${v}`;
    case 'sot': return `Disparos a puerta: más/menos ${v}`;
    case 'hsot': return `Disparos a puerta de ${home}: más/menos ${v}`;
    case 'asot': return `Disparos a puerta de ${away}: más/menos ${v}`;
    default: return m;
  }
}

module.exports = { DemoMarket, footballProbs, footballMarkets, volleyMarkets, poissonPmf, marketLabel };
