'use strict';
// Champions/LaLiga: mercados especiales de bet365, Pinnacle (PS3838), referencia propia, líneas incoherentes,
// combinadas a medida y planes que mezclan sueltas y combinadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeB365, normalizePs3838 } = require('../lib/pulsescore');
const A = require('../lib/analysis');
const P = require('../public/portfolio');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sel = (canonicalOutcome, rawName, odds, line, HD) => ({ canonicalOutcome, rawName, odds, line, isActive: true, moreInfo: HD ? { HD } : {} });
const mk = (canonicalMarket, rawName, selections, period = 'FULL_TIME') => ({ canonicalMarket, rawName, period, selections });

const leipzig = () => normalizeB365({
  eventId: 9, league: 'UEFA Competitions||UEFA Champions League', home: 'RB Leipzig', away: 'Man City', startTime: '2026-11-04T20:00:00Z',
  markets: [
    mk('MATCH_RESULT', 'Full Time Result', [sel('HOME', 'RB Leipzig', 5.25), sel('DRAW', 'Draw', 4.75), sel('AWAY', 'Man City', 1.53)]),
    mk('CORNERS_OVER_UNDER', 'Corners 2-Way', [sel('OVER', 'Over', 1.7273, 9.5), sel('UNDER', 'Under', 2, 9.5)]),
    mk('CORNERS_OVER_UNDER', 'Alternative Corners', [sel('OVER', 'Over', 2.4, 10.5), sel('UNDER', 'Under', 1.55, 10.5), sel('OVER', 'Over', 1.6, 8.5), sel('UNDER', 'Under', 2.25, 8.5)]),
    mk('HOME_CORNERS_OVER_UNDER', 'Team Corners — RB Leipzig', [sel('OVER', 'Over 3.5', 1.8333, 3.5), sel('UNDER', 'Under 3.5', 1.8333, 3.5)]),
    mk('CORNERS_HANDICAP', 'Asian Handicap Corners', [sel('HOME', 'RB Leipzig', 1.8, 2.5), sel('AWAY', 'Man City', 2, -2.5)]),
    mk('OTHER', 'Number of Cards In Match', [sel('OVER', 'Over', 1.6154, 2.5), sel('UNDER', 'Under', 2.2, 2.5)]),
    mk('OTHER', 'Team Cards', [sel('HOME', 'RB Leipzig', 1.7273, 1.5, 'Over 1.5'), sel('HOME', 'RB Leipzig', 2, 1.5, 'Under 1.5'), sel('AWAY', 'Man City', 2.5, 1.5, 'Over 1.5'), sel('AWAY', 'Man City', 1.5, 1.5, 'Under 1.5')]),
    mk('OTHER', 'Match Shots on Target', [sel('OVER', 'Over', 1.9091, 10.5), sel('UNDER', 'Under', 1.8, 10.5)]),
    mk('TEAM_SHOTS_ON_TARGET', 'Team Shots on Target', [sel('HOME', 'RB Leipzig', 1.6667, 3.5, 'Over 3.5'), sel('HOME', 'RB Leipzig', 2.1, 3.5, 'Under 3.5')]),
    mk('EUROPEAN_HANDICAP', 'Handicap Result', [sel('HOME', 'RB Leipzig', 2.375, 1), sel('DRAW', 'Tie', 4.3333, 1), sel('AWAY', 'Man City', 2.25, 1)]),
    mk('HALF_TIME_RESULT', 'Half Time Result', [sel('HOME', 'RB Leipzig', 5), sel('DRAW', 'Draw', 2.9), sel('AWAY', 'Man City', 2)], 'FIRST_HALF'),
  ],
}, 'futbol');

test('bet365: córners, tarjetas, disparos a puerta, hándicap europeo y descanso', () => {
  const m = leipzig().books[0].markets;
  assert.deepEqual(m['corners:9.5'].outcomes, { 'Más 9.5': 1.7273, 'Menos 9.5': 2 });
  assert.deepEqual(m['hcorners:3.5'].outcomes, { 'Más 3.5': 1.8333, 'Menos 3.5': 1.8333 });
  assert.deepEqual(m['cspread:2.5'].outcomes, { '1': 1.8, '2': 2 });
  assert.deepEqual(m['cards:2.5'].outcomes, { 'Más 2.5': 1.6154, 'Menos 2.5': 2.2 });
  assert.deepEqual(m['hcards:1.5'].outcomes, { 'Más 1.5': 1.7273, 'Menos 1.5': 2 });
  assert.deepEqual(m['acards:1.5'].outcomes, { 'Más 1.5': 2.5, 'Menos 1.5': 1.5 });
  assert.deepEqual(m['sot:10.5'].outcomes, { 'Más 10.5': 1.9091, 'Menos 10.5': 1.8 });
  assert.deepEqual(m['hsot:3.5'].outcomes, { 'Más 3.5': 1.6667, 'Menos 3.5': 2.1 });
  assert.deepEqual(m['eh:1'].outcomes, { '1': 2.375, X: 4.3333, '2': 2.25 });
  assert.deepEqual(m.ht.outcomes, { '1': 5, X: 2.9, '2': 2 });
  assert.equal(A.selectionLabel('1', { home: 'RB Leipzig', away: 'Man City' }, 'eh:1'), 'RB Leipzig (+1)');
  assert.equal(A.selectionLabel('Más 2.5', { home: 'RB Leipzig', away: 'Man City' }, 'cards:2.5'), 'Más 2.5 tarjetas');
});

test('PS3838: se presenta como Pinnacle y solo con medias líneas', () => {
  const e = normalizePs3838({
    eventId: 1, league: 'UEFA - Champions League', home: 'RB Leipzig', away: 'Manchester City', startTime: '2026-11-04T20:00:00Z',
    markets: [
      mk('MATCH_RESULT', 'Match Result', [sel('HOME', 'Home', 5.46), sel('AWAY', 'Away', 1.546), sel('DRAW', 'Draw', 4.95)]),
      mk('OVER_UNDER', 'Over/Under 3.5', [sel('OVER', 'Over', 1.8, 3.5), sel('UNDER', 'Under', 2.12, 3.5)]),
      mk('OVER_UNDER', 'Over/Under 3.5-4', [sel('OVER', 'Over', 1.961, 3.75), sel('UNDER', 'Under', 1.892, 3.75)]),
      mk('ASIAN_HANDICAP', 'AH 0.75', [sel('HOME', 'Home', 2.35, 0.75), sel('AWAY', 'Away', 1.645, -0.75)]),
    ],
  });
  assert.equal(e.books[0].key, 'pinnacle');
  assert.deepEqual(Object.keys(e.books[0].markets).sort(), ['h2h', 'totals:3.5']);
});

test('referencia propia: un mercado que solo tiene bet365 da EV negativo, nunca «valor»', () => {
  const r = A.analyze([leipzig()]);
  const corners = r.events[0].markets.find((m) => m.id === 'corners:9.5');
  assert.equal(corners.refKind, 'propia');
  close(corners.fair[0] + corners.fair[1], 1);
  assert.ok(!r.opportunities.some((o) => o.market === 'corners:9.5' && o.type === 'valor'));
});

test('líneas incoherentes: «más de 9.5» pagando más que «más de 10.5» es un error', () => {
  const ev = leipzig();
  ev.books[0].markets['corners:9.5'].outcomes['Más 9.5'] = 2.6; // más probable que más de 10.5 (2.4) y paga más
  const r = A.analyze([ev]);
  const o = r.opportunities.find((x) => x.market === 'corners:9.5' && x.type === 'palpable');
  assert.ok(o, 'debería marcarlo');
  assert.equal(o.selection, 'Más 9.5');
  assert.match(o.note, /incoherente/);
  // Sin el error, no hay aviso
  assert.ok(!A.analyze([leipzig()]).opportunities.some((x) => x.id.endsWith('|ladder')));
});

const opp = (id, e, price, p, market = 'h2h', sport = 'futbol') => ({ id, eventId: e, type: 'bajo', price, fairProb: p, ev: p * price - 1, confidence: 'alta', book: 'bet365', bookTitle: 'bet365', market, sport, home: 'A' + e, away: 'B' + e });

test('combinada a medida: respeta selecciones, acierto mínimo y tipos de mercado', () => {
  const pool = [opp('a', 'e1', 1.5, 0.66, 'corners:9.5'), opp('b', 'e2', 1.6, 0.62, 'cards:2.5'), opp('c', 'e3', 1.4, 0.7, 'h2h'), opp('d', 'e4', 1.7, 0.57, 'totals:2.5'), opp('e', 'e5', 2.5, 0.38, 'corners:10.5')];
  const t = P.buildTicket(pool, { label: 'A mi gusto', legs: 2, minP: 0.55, maxP: 1, families: ['corners', 'tarjetas'] }, 2, 'bet365');
  assert.ok(t.ok);
  assert.deepEqual(t.legs.map((o) => o.id).sort(), ['a', 'b']);
  assert.equal(P.familyOf(pool[0]), 'corners');
  assert.equal(P.familyOf(pool[3]), 'goles');
});

test('planes: mezclan apuestas sueltas y combinadas, suman el presupuesto y no repiten partido', () => {
  const pool = Array.from({ length: 14 }, (_, i) => opp(`o${i}`, `e${i}`, 1.4 + i * 0.12, Math.max(0.3, 0.7 - i * 0.03)));
  const plans = P.buildAllPlans(pool, 20);
  for (const [k, pl] of Object.entries(plans)) {
    const combos = pl.bets.filter((b) => b.kind === 'combinada');
    assert.ok(combos.length >= 1, `${k} sin combinada`);
    close(pl.total, 20, 0.1 + 1e-9);
    const evs = pl.bets.flatMap((b) => (b.kind === 'combinada' ? b.legs.map((l) => l.eventId) : [b.opp.eventId]));
    assert.equal(new Set(evs).size, evs.length, `${k} repite partido`);
    for (const c of combos) close(c.winProb, c.legs.reduce((a, l) => a * l.fairProb, 1));
  }
  assert.equal(plans.arriesgado.bets.filter((b) => b.kind === 'combinada').length, 2);
});
