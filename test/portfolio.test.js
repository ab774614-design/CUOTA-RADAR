'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/portfolio');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function value(id, eventId, price, fairProb, extra = {}) {
  return { id, eventId, type: 'valor', price, fairProb, ev: fairProb * price - 1, confidence: 'alta', ...extra };
}

test('cobertura: reparte para cobrar lo mismo y el beneficio garantizado es positivo', () => {
  const c = P.coverLegs([{ price: 2.1 }, { price: 3.6 }, { price: 4.2 }], 100);
  assert.ok(c.stake <= 100);
  assert.ok(c.guaranteed > 0);
  for (const l of c.legs) assert.ok(l.stake * l.price - c.stake >= c.guaranteed - 1e-9);
});

test('stake de valor = Kelly fraccional del presupuesto, en múltiplos de 0,50 €', () => {
  // p = 0.5, cuota 2.2 → Kelly = 0.1/1.2 = 8.33 %; conservador 0.2 Kelly = 1.67 % → 1000 € · 1.67 % = 16.67 → 16.5 €
  const plan = P.buildPlan([value('a', 'e1', 2.2, 0.5)], 1000, 'conservador', { full: false, step: 0.5, voidProb: { valor: 0 } });
  assert.equal(plan.bets.length, 1);
  assert.equal(plan.bets[0].stake, 16.5);
  close(plan.bets[0].profitIfWin, 19.8);
  close(plan.stats.expected, 16.5 * 0.1, 0.01);
});

test('modo prudente: respeta el máximo por apuesta y la exposición total del perfil', () => {
  const opps = Array.from({ length: 30 }, (_, i) => value(`v${i}`, `e${i}`, 3, 0.45));
  for (const k of Object.keys(P.PROFILES)) {
    const prof = P.PROFILES[k];
    const plan = P.buildPlan(opps, 1000, k, { full: false });
    assert.ok(plan.bets.length <= prof.maxBets, k);
    for (const b of plan.bets) assert.ok(b.stake <= prof.maxBet * 1000 + 1e-9, k);
    assert.ok(plan.total <= prof.maxExposure * 1000 + 1e-9, k);
  }
});

test('una sola apuesta por partido', () => {
  const plan = P.buildPlan([value('a', 'e1', 2.2, 0.5), value('b', 'e1', 3.0, 0.4), value('c', 'e2', 2.0, 0.55)], 500, 'equilibrado');
  const events = plan.bets.map((b) => b.opp.eventId);
  assert.equal(new Set(events).size, events.length);
});

test('el perfil conservador no incluye errores palpables', () => {
  const opps = [value('p', 'e1', 4, 0.4, { type: 'palpable' }), value('a', 'e2', 2.2, 0.5)];
  assert.ok(!P.buildPlan(opps, 500, 'conservador').bets.some((b) => b.opp.type === 'palpable'));
  assert.ok(P.buildPlan(opps, 500, 'agresivo').bets.some((b) => b.opp.type === 'palpable'));
});

test('simulación: una apuesta al 50 % a cuota 2 pierde la mitad de las veces', () => {
  const bets = [{ kind: 'simple', stake: 10, winProb: 0.5, profitIfWin: 10, voidProb: 0, expected: 0 }];
  const s = P.simulate(bets, 100, 40000, 7);
  close(s.pLoss, 0.5, 0.01);
  assert.equal(s.best, 10);
  assert.equal(s.worst, -10);
  close(s.pWorst, 0.5);
});

test('solo surebets → riesgo de pérdidas 0 %', () => {
  const sure = { id: 's', eventId: 'e1', type: 'surebet', ev: 0.008, legs: [{ price: 2.1 }, { price: 3.6 }, { price: 4.2 }] };
  const plan = P.buildPlan([sure], 1000, 'equilibrado');
  assert.equal(plan.bets[0].kind, 'cobertura');
  assert.equal(plan.stats.pLoss, 0);
  assert.ok(plan.stats.expected > 0);
});

const mixed = () => [
  value('a', 'e1', 2.2, 0.5), value('b', 'e2', 3.1, 0.36), value('c', 'e3', 1.8, 0.6), value('d', 'e4', 4.5, 0.25),
  value('e', 'e5', 2.05, 0.52), value('f', 'e6', 1.5, 0.7),
  { id: 's', eventId: 'e7', type: 'surebet', ev: 0.02, legs: [{ price: 2.1, book: 'x' }, { price: 2.0, book: 'y' }] },
];

test('todo el presupuesto: con 10 € se apuesta exactamente 10 € en múltiplos de 0,10 €', () => {
  for (const k of Object.keys(P.PROFILES)) {
    const plan = P.buildPlan(mixed(), 10, k);
    assert.ok(plan.bets.length >= 2, k);
    close(plan.total, 10, 0.1 + 1e-9);
    for (const b of plan.bets) {
      assert.ok(b.stake >= 0.1 - 1e-9, k);
      close(Math.round(b.stake * 10) / 10, b.stake, 1e-9);
      for (const l of b.legs || []) assert.ok(l.stake >= 0.1 - 1e-9);
    }
  }
});

test('con 10 € como mucho 5 apuestas', () => {
  const opps = Array.from({ length: 20 }, (_, i) => value(`v${i}`, `e${i}`, 2.2, 0.5));
  assert.ok(P.buildPlan(opps, 10, 'agresivo').bets.length <= 5);
});

test('todo el presupuesto: suma el presupuesto con 2 €, 37 €, 250 € y 5.000 €', () => {
  for (const budget of [2, 37, 250, 5000]) {
    const plan = P.buildPlan(mixed(), budget, 'equilibrado');
    assert.ok(plan.bets.length >= 1, String(budget));
    assert.ok(budget - plan.total < plan.step + 1e-9, `${budget}: ${plan.total}`);
    assert.ok(plan.total <= budget + 1e-9);
  }
});

test('todo el presupuesto: ninguna apuesta simple supera el peso máximo del perfil (si hay suficientes)', () => {
  const opps = Array.from({ length: 12 }, (_, i) => value(`v${i}`, `e${i}`, 2 + i * 0.3, 0.55 - i * 0.02));
  const plan = P.buildPlan(opps, 100, 'moderado');
  close(plan.total, 100, 0.1);
  for (const b of plan.bets) assert.ok(b.stake <= 100 * P.PROFILES.moderado.maxShare + 0.6);
});

test('todo el presupuesto con una sola oportunidad: va entera y avisa', () => {
  const plan = P.buildPlan([value('a', 'e1', 2.2, 0.5)], 10, 'equilibrado');
  assert.equal(plan.bets.length, 1);
  assert.equal(plan.bets[0].stake, 10);
  assert.ok(plan.warnings.some((w) => w.includes('una sola apuesta')));
});

test('pesos con tope: nadie pasa del tope y suman 1', () => {
  const w = P.cappedWeights([10, 1, 1, 1], 0.4);
  close(w.reduce((a, b) => a + b, 0), 1);
  assert.ok(w.every((x) => x <= 0.4 + 1e-9));
  close(w[0], 0.4);
});

test('redondeo al total: suma exacta', () => {
  const r = P.roundToTotal([3.333, 3.333, 3.334], 10, 0.1);
  close(r.reduce((a, b) => a + b, 0), 10, 1e-9);
});

test('sin oportunidades no propone nada y avisa', () => {
  const plan = P.buildPlan([], 300, 'equilibrado');
  assert.equal(plan.bets.length, 0);
  assert.equal(plan.total, 0);
  assert.ok(plan.warnings.length);
});
