'use strict';
// bet365 (PulseScore): traducción de mercados, emparejamiento de partidos y modelo de referencia del voleibol.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeB365 } = require('../lib/pulsescore');
const { matchEvents, similarity } = require('../lib/match');
const { volleyModelBook, setProbFromMatch } = require('../lib/b365model');
const { volleyMarkets } = require('../lib/demo');
const A = require('../lib/analysis');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sel = (canonicalOutcome, rawName, odds, line) => ({ canonicalOutcome, rawName, odds, line, isActive: true });

test('fútbol: traduce 1X2, doble oportunidad, más/menos y hándicap (solo medias líneas)', () => {
  const e = normalizeB365({
    eventId: 1, league: 'Europe||Netherlands Eredivisie', home: 'FC Twente', away: 'Ajax', startTime: '2026-11-08T13:30:00Z', live: false,
    markets: [
      { canonicalMarket: 'MATCH_RESULT', period: 'FULL_TIME', rawName: 'Full Time Result', selections: [sel('HOME', 'FC Twente', 2.15), sel('DRAW', 'Draw', 3.9), sel('AWAY', 'Ajax', 2.8)] },
      { canonicalMarket: 'DOUBLE_CHANCE', period: 'FULL_TIME', rawName: 'Double Chance', selections: [sel('HOME_DRAW', 'x', 1.4), sel('DRAW_AWAY', 'x', 1.6667), sel('HOME_AWAY', 'x', 1.25)] },
      { canonicalMarket: 'OVER_UNDER', period: 'FULL_TIME', rawName: 'Goals Over/Under', selections: [sel('OVER', 'Over', 1.4, 2.5), sel('UNDER', 'Under', 2.875, 2.5)] },
      { canonicalMarket: 'OVER_UNDER', period: 'FULL_TIME', rawName: 'Goal Line', selections: [sel('OVER', 'Over', 1.8, 3.25), sel('UNDER', 'Under', 2, 3.25)] },
      { canonicalMarket: 'ASIAN_HANDICAP', period: 'FULL_TIME', rawName: 'Alt', selections: [sel('HOME', 'FC Twente', 3.7, -1.5), sel('AWAY', 'Ajax', 1.26, 1.5), sel('HOME', 'FC Twente', 1.95, -0.25), sel('AWAY', 'Ajax', 1.85, 0.25)] },
      { canonicalMarket: 'OVER_UNDER', period: 'FIRST_HALF', rawName: '1st half', selections: [sel('OVER', 'Over', 1.5, 0.5), sel('UNDER', 'Under', 2.5, 0.5)] },
    ],
  }, 'futbol');
  const m = e.books[0].markets;
  assert.deepEqual(m.h2h.outcomes, { '1': 2.15, X: 3.9, '2': 2.8 });
  assert.deepEqual(m.dc.outcomes, { '1X': 1.4, X2: 1.6667, '12': 1.25 });
  assert.deepEqual(m['totals:2.5'].outcomes, { 'Más 2.5': 1.4, 'Menos 2.5': 2.875 });
  assert.deepEqual(m['spreads:-1.5'].outcomes, { '1': 3.7, '2': 1.26 });
  assert.ok(!m['totals:3.25'] && !m['spreads:-0.25'] && !m['totals:0.5']); // sin líneas asiáticas ni 1.ª parte
  assert.equal(e.league, 'Netherlands Eredivisie');
});

test('voleibol: el resultado exacto del visitante se da la vuelta (Al Ahli 3-1 → 1-3)', () => {
  const e = normalizeB365({
    eventId: 2, league: 'Qatar League', home: 'Police Club', away: 'Al Ahli', startTime: '2026-11-02T13:00:00Z',
    markets: [
      { canonicalMarket: 'MATCH_RESULT', period: 'FULL_TIME', selections: [sel('HOME', 'Police Club', 1.25), sel('AWAY', 'Al Ahli', 3.75)] },
      { canonicalMarket: 'SET_BETTING', period: 'FULL_TIME', selections: [sel('OTHER', 'Police Club 3-0', 2.4, 3), sel('OTHER', 'Al Ahli 3-1', 10, 3)] },
      { canonicalMarket: 'SET_HANDICAP', period: 'FULL_TIME', selections: [sel('HOME', 'Police Club', 1.5333, -1.5), sel('AWAY', 'Al Ahli', 2.375, 1.5)] },
      { canonicalMarket: 'SET_WINNER', period: 'FIRST_SET', selections: [sel('HOME', 'Police Club', 1.4), sel('AWAY', 'Al Ahli', 2.75)] },
    ],
  }, 'voleibol');
  const m = e.books[0].markets;
  assert.deepEqual(m.cs.outcomes, { '3-0': 2.4, '1-3': 10 });
  assert.deepEqual(m['spreads:-1.5'].outcomes, { '1': 1.5333, '2': 2.375 });
  assert.deepEqual(m.set1.outcomes, { '1': 1.4, '2': 2.75 });
});

test('emparejar equipos con nombres distintos y misma hora', () => {
  assert.ok(similarity('FC Twente', 'Twente') >= 0.9);
  assert.ok(similarity('Real Madrid', 'Real Sociedad') < 0.5);
  const base = [{ id: 'a', home: 'FC Twente', away: 'AFC Ajax', commence: '2026-11-08T13:30:00Z' }, { id: 'b', home: 'Real Madrid', away: 'Valencia', commence: '2026-11-08T20:00:00Z' }];
  const others = [{ id: 'x', home: 'Twente', away: 'Ajax', commence: '2026-11-08T13:30:00Z' }, { id: 'y', home: 'Real Sociedad', away: 'Valencia', commence: '2026-11-10T20:00:00Z' }];
  const p = matchEvents(base, others);
  assert.equal(p.get('a').id, 'x');
  assert.ok(!p.has('b')); // otro equipo y otro día
});

test('modelo de voleibol: la probabilidad por set reproduce la del partido', () => {
  const ps = setProbFromMatch(0.75);
  close(volleyMarkets(ps, 0, []).h2h['1'], 0.75, 1e-6);
});

test('modelo de voleibol: detecta un hándicap de sets de bet365 mal pagado y no lo usa para apostar', () => {
  const ev = {
    id: 'v', sport: 'voleibol', league: 'Liga', home: 'A', away: 'B', commence: new Date().toISOString(),
    books: [{ key: 'bet365', title: 'bet365', updated: Date.now(), markets: {
      h2h: { label: 'Ganador', outcomes: { '1': 1.5, '2': 2.6 } },
      'spreads:-1.5': { label: 'Hándicap', outcomes: { '1': 2.6, '2': 1.45 } },
      cs: { label: 'Sets', outcomes: { '3-0': 9, '3-1': 4.2, '3-2': 5.5, '0-3': 9, '1-3': 8, '2-3': 8 } },
    } }],
  };
  const model = volleyModelBook(ev);
  assert.ok(!model.markets.cs); // el resultado exacto no se modela (desviación sistemática)
  ev.books.push(model);
  const r = A.analyze([ev]);
  const o = r.opportunities.find((x) => x.market === 'spreads:-1.5' && x.selection === '1');
  assert.ok(o, 'debería ver valor en A -1.5 a cuota 2.6');
  assert.equal(o.book, 'bet365');
  assert.equal(o.confidence, 'baja');
  assert.ok(!r.opportunities.some((x) => x.book === 'modelo' || (x.legs || []).some((l) => l.book === 'modelo')));
});
