'use strict';
// Tests de la matemática con casos calculados a mano. Ejecutar: node --test test
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/analysis');
const { footballProbs, poissonPmf, DemoMarket } = require('../lib/demo');

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('probabilidades implícitas y margen de 2.00/3.50/4.00', () => {
  const q = A.implied([2, 3.5, 4]);
  close(q[0], 0.5); close(q[1], 0.285714); close(q[2], 0.25);
  close(A.overround([2, 3.5, 4]), 1.035714);
});

test('devig multiplicativo: 0.5 / 1.035714 = 0.48276', () => {
  const p = A.devigMultiplicative([2, 3.5, 4]);
  close(p[0], 0.482759);
  close(sum(p), 1);
});

test('EV y Kelly a cuota 2.20 con p = 0.48276', () => {
  const p = 0.5 / 1.0357142857;
  close(A.expectedValue(p, 2.2), 0.062069);
  close(A.kelly(p, 2.2), 0.051724); // 0.062069 / 1.2
});

test('Kelly negativo si no hay valor', () => {
  assert.ok(A.kelly(0.4, 2.0) < 0);
});

test('arbitraje 2.10 / 3.60 / 4.20 → 0.79 %', () => {
  const a = A.arbitrageStakes([2.1, 3.6, 4.2], 100);
  close(a.sum, 0.992063);
  close(a.profitPct, 0.008, 1e-4);
  // Mismo cobro salga lo que salga
  close(a.stakes[0] * 2.1, a.payout, 1e-9);
  close(a.stakes[1] * 3.6, a.payout, 1e-9);
  close(a.stakes[2] * 4.2, a.payout, 1e-9);
  close(sum(a.stakes), 100, 1e-9);
});

test('todos los métodos de devig suman 1 y respetan el orden', () => {
  const odds = [1.45, 4.6, 7.5];
  for (const m of ['multiplicativo', 'aditivo', 'potencia', 'shin']) {
    const p = A.devig(odds, m);
    close(sum(p), 1, 1e-9);
    assert.ok(p[0] > p[1] && p[1] > p[2], m);
  }
});

test('mercado sin margen no cambia con ningún método', () => {
  const odds = [2, 4, 4];
  for (const m of ['multiplicativo', 'aditivo', 'potencia', 'shin']) {
    const p = A.devig(odds, m);
    close(p[0], 0.5, 1e-6); close(p[1], 0.25, 1e-6); close(p[2], 0.25, 1e-6);
  }
});

test('potencia y Shin reparten más margen al favorito-perdedor (sesgo favorito/tapado)', () => {
  const odds = [1.25, 6, 12];
  const mult = A.devigMultiplicative(odds);
  const pow = A.devigPower(odds);
  assert.ok(pow[0] > mult[0]);
  assert.ok(pow[2] < mult[2]);
});

test('propiedad: devig de mercados aleatorios siempre suma 1', () => {
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const n = r() < 0.5 ? 2 : 3;
    const probs = Array.from({ length: n }, () => 0.05 + r());
    const tot = sum(probs);
    const margin = 1 + r() * 0.12;
    const odds = probs.map((p) => 1 / ((p / tot) * margin));
    if (odds.some((o) => o <= 1.01)) continue; // cuota imposible en una casa real
    for (const m of ['multiplicativo', 'aditivo', 'potencia', 'shin']) {
      const p = A.devig(odds, m);
      close(sum(p), 1, 1e-6);
      assert.ok(p.every((x) => x > 0 && x < 1));
    }
  }
});

test('Poisson λ = 1.5', () => {
  close(poissonPmf(0, 1.5), 0.223130);
  close(poissonPmf(1, 1.5), 0.334695);
  close(poissonPmf(2, 1.5), 0.251021);
});

test('1X2 de Poisson con equipos iguales es simétrico y suma 1', () => {
  const f = footballProbs(1.3, 1.3, 2.5);
  close(f.h2h['1'], f.h2h['2'], 1e-9);
  close(f.h2h['1'] + f.h2h.X + f.h2h['2'], 1, 1e-9);
  // P(más de 2.5) con λ total 2.6 = 1 − P(0..2) de Poisson(2.6)
  const under = poissonPmf(0, 2.6) + poissonPmf(1, 2.6) + poissonPmf(2, 2.6);
  close(f.over, 1 - under, 1e-6);
});

function ev(books) {
  return {
    id: 'e1', sport: 'futbol', sportKey: 'x', league: 'Liga', home: 'A', away: 'B', commence: new Date().toISOString(),
    books: books.map(([key, o1, oX, o2]) => ({ key, title: key, updated: Date.now(), markets: { h2h: { label: '1X2', outcomes: { '1': o1, X: oX, '2': o2 } } } })),
  };
}

test('detecta valor frente a Pinnacle', () => {
  const r = A.analyze([ev([['pinnacle', 2.0, 3.5, 4.0], ['bet365', 2.2, 3.3, 3.6]])], { method: 'multiplicativo' });
  const v = r.opportunities.find((o) => o.type === 'valor');
  assert.ok(v);
  assert.equal(v.book, 'bet365');
  assert.equal(v.selection, '1');
  close(v.ev, 0.062069);
  close(v.stakePct, 0.051724 / 4); // ¼ Kelly
});

test('marca error palpable cuando el EV supera el umbral', () => {
  const r = A.analyze([ev([['pinnacle', 2.0, 3.5, 4.0], ['bet365', 3.5, 3.3, 3.6]])], { method: 'multiplicativo' });
  const v = r.opportunities.find((o) => o.book === 'bet365' && o.selection === '1');
  assert.equal(v.type, 'palpable');
  assert.equal(v.risk, 'alto');
});

test('detecta surebet entre casas y arbitraje interno', () => {
  const r = A.analyze([ev([['pinnacle', 2.0, 3.5, 4.0], ['casaA', 2.1, 3.3, 3.6], ['casaB', 1.9, 3.6, 4.2]])]);
  const s = r.opportunities.find((o) => o.type === 'surebet');
  assert.ok(s);
  close(s.ev, 1 / (1 / 2.1 + 1 / 3.6 + 1 / 4.2) - 1);
  const r2 = A.analyze([ev([['casaA', 2.1, 3.6, 4.2], ['casaB', 2.0, 3.4, 3.8], ['casaC', 2.0, 3.4, 3.8]])]);
  assert.ok(r2.opportunities.find((o) => o.type === 'interno' && o.book === 'casaA'));
});

test('sin casa sharp usa el consenso solo con 3 o más casas', () => {
  const two = A.analyze([ev([['casaA', 2.0, 3.4, 3.8], ['casaB', 2.3, 3.4, 3.8]])]);
  assert.equal(two.opportunities.filter((o) => o.type === 'valor').length, 0);
  const four = A.analyze([ev([['casaA', 2.0, 3.4, 3.8], ['casaB', 2.0, 3.4, 3.8], ['casaC', 2.0, 3.4, 3.8], ['casaD', 2.3, 3.4, 3.8]])]);
  const v = four.opportunities.find((o) => o.type === 'valor');
  assert.equal(v.book, 'casaD');
  assert.match(v.reference, /Consenso/);
});

test('detecta línea desfasada con el histórico', () => {
  const h = new A.History();
  const t0 = 1_000_000_000;
  A.analyze([ev([['pinnacle', 2.2, 3.4, 3.4], ['bet365', 2.2, 3.3, 3.3]])], {}, h, t0);
  // Pinnacle baja la cuota del local (sube su probabilidad); bet365 sigue igual.
  const r = A.analyze([ev([['pinnacle', 1.9, 3.6, 4.2], ['bet365', 2.2, 3.3, 3.3]])], {}, h, t0 + 5 * 60000);
  const d = r.opportunities.find((o) => o.book === 'bet365' && o.selection === '1');
  assert.equal(d.type, 'desfasada');
});

test('en un exchange se descuenta la comisión: 2.20 con 5 % → 2.14 netos', () => {
  const r = A.analyze([ev([['pinnacle', 2.0, 3.5, 4.0], ['betfair_ex_uk', 2.2, 3.4, 3.9]])], { method: 'multiplicativo' });
  const v = r.opportunities.find((o) => o.book === 'betfair_ex_uk' && o.selection === '1');
  close(v.price, 2.14);
  close(v.ev, (0.5 / 1.0357142857) * 2.14 - 1);
});

test('descarta cuotas más viejas que el máximo', () => {
  const e = ev([['pinnacle', 2.0, 3.5, 4.0], ['bet365', 2.2, 3.3, 3.6]]);
  e.books[1].updated = Date.now() - 60 * 60000;
  const r = A.analyze([e], { maxAgeMin: 30 });
  assert.equal(r.opportunities.length, 0);
});

test('el simulador demo produce mercados completos de fútbol y voleibol', () => {
  const d = new DemoMarket(42);
  const evs = d.snapshot();
  assert.ok(evs.some((e) => e.sport === 'futbol'));
  assert.ok(evs.some((e) => e.sport === 'voleibol'));
  const r = A.analyze(evs);
  assert.ok(r.events.length === evs.length);
  for (const e of r.events) for (const m of e.markets) assert.ok(m.fair === null || Math.abs(sum(m.fair) - (m.id === 'dc' ? 2 : 1)) < 1e-9);
});
