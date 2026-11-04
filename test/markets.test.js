'use strict';
// Mercados ampliados (fútbol y voleibol), los tres planes y las noticias.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/analysis');
const P = require('../public/portfolio');
const { footballMarkets, volleyMarkets, DemoMarket } = require('../lib/demo');
const { parseRss, flagsOf } = require('../lib/news');
const { cleanKey, keyProblem } = require('../lib/oddsapi');

test('The Odds API: solo se usan líneas de medio gol', () => {
  const { normalize } = require('../lib/oddsapi');
  const e = normalize({
    id: 'x', home_team: 'A', away_team: 'B', commence_time: '2026-11-08T20:00:00Z',
    bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: '2026-11-02T10:00:00Z', markets: [
      { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 2.5 }, { name: 'Under', price: 1.95, point: 2.5 },
        { name: 'Over', price: 1.8, point: 2.25 }, { name: 'Under', price: 2.0, point: 2.25 }] },
      { key: 'spreads', outcomes: [{ name: 'A', price: 1.9, point: -0.25 }, { name: 'B', price: 1.9, point: 0.25 }] },
    ] }],
  }, { key: 'soccer_x', title: 'Liga', sport: 'futbol' });
  assert.deepEqual(Object.keys(e.books[0].markets), ['totals:2.5']);
});

test('coste y caché por mercado: lo rastreado (1X2) no se vuelve a pagar', () => {
  const { OddsApi, costOf, mergeEvents } = require('../lib/oddsapi');
  assert.equal(costOf('h2h,totals,spreads', 'eu'), 3);
  assert.equal(costOf('h2h,totals,spreads', 'eu,uk'), 6);
  const api = new OddsApi();
  assert.equal(api.estimate(['a', 'b'], { regions: 'eu' }), 6);
  api.cache.set('a|eu|h2h', { t: Date.now(), events: [] });
  assert.equal(api.estimate(['a', 'b'], { regions: 'eu' }), 5);
  api.cache.set('a|eu|h2h', { t: Date.now() - 3600e3, events: [] }); // caducada
  assert.equal(api.estimate(['a'], { regions: 'eu', ttlSec: 900 }), 3);
  // Unir mercados de peticiones distintas
  const ev = (markets) => [{ id: 'e', books: [{ key: 'pin', updated: 1, markets }] }];
  const m = mergeEvents([ev({ h2h: { outcomes: {} } }), ev({ 'totals:2.5': { outcomes: {} } })]);
  assert.deepEqual(Object.keys(m[0].books[0].markets).sort(), ['h2h', 'totals:2.5']);
});

test('clave de The Odds API: limpia lo que se cuela al copiar y detecta claves cortadas', () => {
  const good = 'a'.repeat(16) + '0123456789abcdef';
  assert.equal(cleanKey(` "${good}"\n`), good);
  assert.equal(cleanKey(`${good}​`), good);
  assert.equal(keyProblem(good), null);
  assert.match(keyProblem(good.slice(0, 30)), /30 caracteres.*falta un trozo/);
  assert.match(keyProblem('hola, tu clave es'), /solo puede tener/);
  assert.equal(keyProblem(''), 'La clave está vacía.');
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('fútbol: todos los mercados suman 1 (la doble oportunidad suma 2)', () => {
  const m = footballMarkets(1.6, 1.1);
  for (const [id, out] of Object.entries(m)) close(sum(out), id === 'dc' ? 2 : 1, 1e-6);
  // Coherencia entre mercados
  close(m.dc['1X'], m.h2h['1'] + m.h2h.X);
  close(m.dnb['1'], m.h2h['1'] / (m.h2h['1'] + m.h2h['2']));
  assert.ok(m['spreads:-1.5']['1'] < m.h2h['1']); // ganar por 2+ es menos probable que ganar
  assert.ok(m['spreads:1.5']['1'] > m.dc['1X']); // perder solo por 1 también vale
});

test('voleibol: resultado exacto con ps = 0.5 → 3-0 = 1/8, 3-1 = 3/16, 3-2 = 3/16', () => {
  const m = volleyMarkets(0.5, 0, [180.5]);
  close(m.cs['3-0'], 0.125); close(m.cs['3-1'], 0.1875); close(m.cs['3-2'], 0.1875);
  close(m.h2h['1'], 0.5);
  close(m['sets:3.5']['Menos 3.5'], 0.25); // 3-0 o 0-3
  close(m['sets:4.5']['Más 4.5'], 0.375); // 3-2 o 2-3
  for (const out of Object.values(m)) close(sum(out), 1, 1e-6);
});

test('voleibol: el favorito por sets gana más a menudo el partido que un set', () => {
  const m = volleyMarkets(0.6, 0, [180.5]);
  assert.ok(m.h2h['1'] > m.set1['1']);
});

test('quitar margen a la doble oportunidad: las probabilidades suman 2', () => {
  const p = A.devig([1.25, 1.3, 1.6], 'potencia', 2);
  close(p.reduce((a, b) => a + b, 0), 2, 1e-9);
});

test('el simulador ofrece mercados de fútbol y de voleibol y el análisis los reconoce', () => {
  const evs = new DemoMarket(9).snapshot();
  const r = A.analyze(evs);
  const ids = (sport) => new Set(r.events.filter((e) => e.sport === sport).flatMap((e) => e.markets.map((m) => m.id.split(':')[0])));
  const fb = ids('futbol'), vb = ids('voleibol');
  for (const k of ['h2h', 'dc', 'dnb', 'btts', 'totals', 'spreads', 'cs', 'htotal']) assert.ok(fb.has(k), `fútbol sin ${k}`);
  for (const k of ['h2h', 'cs', 'sets', 'spreads', 'set1', 'totals']) assert.ok(vb.has(k), `voleibol sin ${k}`);
  // Ninguna surebet en doble oportunidad (no son resultados excluyentes)
  assert.ok(!r.opportunities.some((o) => o.market === 'dc' && o.legs));
});

test('textos de selección claros', () => {
  const ev = { home: 'Betis', away: 'Sevilla' };
  assert.equal(A.selectionLabel('1', ev, 'spreads:-1.5'), 'Betis -1.5');
  assert.equal(A.selectionLabel('2', ev, 'spreads:-1.5'), 'Sevilla +1.5');
  assert.equal(A.selectionLabel('X2', ev, 'dc'), 'Empate o Sevilla');
});

const opp = (id, eventId, price, fairProb) => ({ id, eventId, type: 'valor', price, fairProb, ev: fairProb * price - 1, confidence: 'alta' });

test('tres planes: el seguro arriesga menos que el arriesgado', () => {
  const opps = [
    opp('a', 'e1', 1.6, 0.66), opp('b', 'e2', 1.75, 0.6), opp('c', 'e3', 1.9, 0.55), opp('d', 'e4', 3.6, 0.3),
    opp('e', 'e5', 5.5, 0.2), opp('f', 'e6', 2.9, 0.37), opp('g', 'e7', 7, 0.16),
  ];
  const plans = P.buildAllPlans(opps, 50);
  assert.deepEqual(Object.keys(plans), ['seguro', 'moderado', 'arriesgado']);
  for (const pl of Object.values(plans)) close(pl.total, 50, 0.1 + 1e-9);
  assert.ok(plans.seguro.stats.pLoss < plans.arriesgado.stats.pLoss);
  assert.ok(plans.seguro.bets.every((b) => b.winProb >= 0.5));
  assert.ok(plans.arriesgado.stats.best > plans.seguro.stats.best);
});

test('una surebet del 370 % se trata como error: fuera del plan seguro', () => {
  const crazy = { id: 's', eventId: 'e1', type: 'surebet', ev: 3.7, legs: [{ price: 9.2, book: 'a' }, { price: 9.7, book: 'b' }] };
  const plans = P.buildAllPlans([crazy, opp('a', 'e2', 1.8, 0.6)], 10);
  assert.ok(!plans.seguro.bets.some((b) => b.kind === 'cobertura'));
  assert.ok(!plans.moderado.bets.some((b) => b.kind === 'cobertura'));
  const c = plans.arriesgado.bets.find((b) => b.kind === 'cobertura');
  assert.ok(c && c.voidProb >= 0.5);
});

test('EV bajo o negativo: los tres planes reparten igualmente el presupuesto y avisan', () => {
  const low = (id, e, price, p) => ({ ...opp(id, e, price, p), type: 'bajo', confidence: 'alta' });
  const opps = [low('a', 'e1', 1.5, 0.65), low('b', 'e2', 1.9, 0.51), low('c', 'e3', 2.9, 0.33), low('d', 'e4', 1.3, 0.75), low('e', 'e5', 4.2, 0.23)];
  const plans = P.buildAllPlans(opps, 10);
  for (const [k, pl] of Object.entries(plans)) {
    assert.ok(pl.bets.length >= 1, k);
    close(pl.total, 10, 0.1 + 1e-9);
    if (pl.bets.some((b) => b.opp.ev < 0)) assert.ok(pl.warnings.some((w) => /EV negativo/.test(w)), k);
  }
  // El seguro elige las más probables
  assert.ok(plans.seguro.bets.every((b) => b.winProb >= 0.5));
  // Con EV negativo, el beneficio esperado es negativo (y se muestra así)
  assert.ok(plans.seguro.stats.expected <= 0);
});

test('combinada: cuota y acierto se multiplican, una selección por partido y una sola casa', () => {
  const c = (id, e, price, p, book = 'bet365') => ({ ...opp(id, e, price, p), book, bookTitle: book });
  const pool = [c('a', 'e1', 1.5, 0.66), c('b', 'e1', 1.4, 0.7), c('c', 'e2', 1.6, 0.62), c('d', 'e3', 1.45, 0.68, 'otra'), c('e', 'e4', 2.1, 0.47), c('f', 'e5', 3.2, 0.31)];
  const t = P.buildTicket(pool, 'moderado', 2, 'bet365');
  assert.ok(t.ok);
  assert.equal(t.legs.length, 2);
  assert.equal(new Set(t.legs.map((o) => o.eventId)).size, 2);
  assert.ok(t.legs.every((o) => o.book === 'bet365'));
  const odds = t.legs.reduce((a, o) => a * o.price, 1), prob = t.legs.reduce((a, o) => a * o.fairProb, 1);
  close(t.odds, Math.round(odds * 100) / 100);
  close(t.prob, prob);
  close(t.profitIfWin, Math.round(2 * (t.odds - 1) * 100) / 100);
  close(t.lossProb, 1 - prob);
  // Riesgo alto pide 5 selecciones: con este grupo no llega y lo explica
  const hi = P.buildTicket(pool, 'alto', 1, 'bet365');
  assert.equal(hi.ok, false);
  assert.match(hi.reason, /hacen falta 5/);
});

test('cuota mínima = 1 / probabilidad, redondeada hacia arriba', () => {
  assert.equal(P.minOdds(0.5), 2);
  assert.equal(P.minOdds(0.3), 3.34);
});

test('noticias: lectura de RSS y avisos de bajas', () => {
  const xml = `<rss><channel><item><title>Vinícius, baja ante el Betis por lesión - MARCA</title><link>https://x/1</link>
    <pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><source url="https://marca.com">MARCA</source></item></channel></rss>`;
  const [it] = parseRss(xml);
  assert.equal(it.title, 'Vinícius, baja ante el Betis por lesión');
  assert.equal(it.source, 'MARCA');
  assert.deepEqual(flagsOf(it.title), ['lesión', 'baja']);
  assert.deepEqual(flagsOf('El Betis gana con claridad'), []);
});
