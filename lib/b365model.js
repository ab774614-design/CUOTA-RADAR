'use strict';
// Referencia para el voleibol de bet365 (no hay Pinnacle de voleibol en los proveedores gratuitos):
// a partir del ganador del partido en bet365, sin margen, se calcula la probabilidad de ganar cada set y
// con ella lo que deberían pagar el hándicap de sets, el resultado exacto y el primer set.
// Si bet365 paga más que eso en otro mercado, su propio precio no cuadra: posible error de cuota.
const { devig } = require('./analysis');
const { volleyMarkets } = require('./demo');

// Probabilidad de ganar un set que reproduce la probabilidad de ganar el partido.
function setProbFromMatch(pMatch) {
  let lo = 0.01, hi = 0.99;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (volleyMarkets(mid, 0, []).h2h['1'] < pMatch) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Devuelve una «casa» de referencia (sin margen y solo para comparar) o null si no hay ganador del partido.
function volleyModelBook(ev) {
  const b = ev.books.find((x) => x.key === 'bet365');
  const h2h = b && b.markets.h2h && b.markets.h2h.outcomes;
  if (!h2h || !(h2h['1'] > 1 && h2h['2'] > 1)) return null;
  const [p1] = devig([h2h['1'], h2h['2']], 'potencia');
  const ps = setProbFromMatch(p1);
  const fair = volleyMarkets(ps, 0, []);
  const markets = {};
  const odds = (o) => Object.fromEntries(Object.entries(o).map(([k, p]) => [k, +(1 / Math.max(p, 1e-4)).toFixed(3)]));
  // El resultado exacto en sets no se usa: con datos reales el modelo (sets independientes) se desvía
  // de forma sistemática y daba falsas oportunidades del 13-21 % en casi todos los partidos.
  for (const id of ['spreads:-1.5', 'spreads:1.5', 'set1', 'sets:3.5', 'sets:4.5']) {
    if (b.markets[id]) markets[id] = { label: b.markets[id].label, outcomes: odds(fair[id]) };
  }
  return { key: 'modelo', title: 'Modelo (según el ganador en bet365)', updated: Date.now(), refOnly: true, markets };
}

module.exports = { setProbFromMatch, volleyModelBook };
