'use strict';
// Reparto del presupuesto entre las oportunidades detectadas y cálculo del riesgo.
// Funciona en el navegador (window.Portfolio) y en Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Portfolio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // kelly/maxBet/maxExposure/maxCover*: modo prudente (guarda reserva).
  // coverShare/maxShare: modo «todo el presupuesto» (parte para surebets y peso máximo de una apuesta).
  // minProb / maxProb: probabilidad de acierto de las apuestas simples que admite cada plan.
  const PROFILES = {
    seguro: {
      label: 'Seguro', icon: '🛡️', kelly: 0.2, maxBet: 0.02, maxExposure: 0.2, maxCoverEach: 0.1, maxCover: 0.3, maxBets: 8,
      coverShare: 0.7, maxShare: 0.25, minProb: 0.5, maxProb: 1,
      combos: [{ legs: 2, minP: 0.62, share: 0.1 }],
      types: ['valor', 'desfasada', 'surebet', 'bajo'], minConf: ['alta', 'media'],
      help: 'Prioriza surebets (70 % si las hay) y apuestas con más del 50 % de acierto, con referencia fiable.',
    },
    moderado: {
      label: 'Moderado', icon: '⚖️', kelly: 0.3, maxBet: 0.04, maxExposure: 0.4, maxCoverEach: 0.15, maxCover: 0.4, maxBets: 12,
      coverShare: 0.4, maxShare: 0.35, minProb: 0.3, maxProb: 1,
      combos: [{ legs: 3, minP: 0.5, share: 0.2 }],
      types: ['valor', 'desfasada', 'surebet', 'bajo'], minConf: ['alta', 'media', 'baja'],
      help: '40 % a surebets y el resto a apuestas de valor con al menos un 30 % de acierto.',
    },
    arriesgado: {
      label: 'Arriesgado', icon: '🔥', kelly: 0.5, maxBet: 0.06, maxExposure: 0.7, maxCoverEach: 0.2, maxCover: 0.5, maxBets: 20,
      coverShare: 0.15, maxShare: 0.5, minProb: 0, maxProb: 0.6,
      combos: [{ legs: 3, minP: 0.45, share: 0.15 }, { legs: 5, minP: 0.3, maxP: 0.7, share: 0.15 }],
      types: ['valor', 'desfasada', 'surebet', 'interno', 'palpable', 'bajo'], minConf: ['alta', 'media', 'baja'],
      help: 'Busca cuotas altas (menos del 60 % de acierto) y errores palpables: más ganancia posible y más riesgo.',
    },
  };
  // Nombres antiguos de los perfiles
  const ALIAS = { conservador: 'seguro', equilibrado: 'moderado', agresivo: 'arriesgado' };

  // Probabilidad estimada de que la casa anule la apuesta (se devuelve el dinero).
  const VOID_PROB = { valor: 0.02, desfasada: 0.03, surebet: 0.02, interno: 0.5, palpable: 0.6, bajo: 0.02 };

  const round2 = (x) => Math.round(x * 100) / 100;
  // Redondeo hacia abajo a múltiplos de `step` sin errores de coma flotante.
  const floorTo = (x, step) => round2(Math.floor(x / step + 1e-9) * step);

  // Escalón de los importes según el presupuesto: céntimos de 10 en presupuestos pequeños.
  function stakeStep(budget) {
    if (budget < 100) return 0.1;
    if (budget < 1000) return 0.5;
    return 1;
  }

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Reparte `total` entre las patas de una cobertura para cobrar lo mismo salga lo que salga.
  function coverLegs(legs, total, step = 0.1) {
    const inv = legs.map((l) => 1 / l.price);
    const s = inv.reduce((a, b) => a + b, 0);
    const out = legs.map((l, i) => ({ ...l, stake: floorTo(total * inv[i] / s, step) }));
    const spent = round2(out.reduce((a, l) => a + l.stake, 0));
    const payout = Math.min(...out.map((l) => l.stake * l.price));
    return { legs: out, stake: spent, guaranteed: round2(payout - spent) };
  }

  const kellyFull = (o) => Math.max(0, (o.fairProb * o.price - 1) / (o.price - 1));
  // Peso para repartir: Kelly si hay ventaja; si no (EV bajo o negativo), un peso pequeño que favorece las más probables.
  const weightOf = (o) => kellyFull(o) || 0.004 * o.fairProb;

  // Pesos proporcionales con un tope por apuesta (lo que sobra se reparte entre las demás).
  function cappedWeights(raw, cap) {
    const n = raw.length;
    if (!n) return [];
    if (n * cap <= 1) return raw.map(() => 1 / n);
    const w = new Array(n).fill(0);
    const fixed = new Array(n).fill(false);
    let left = 1;
    for (let iter = 0; iter < n; iter++) {
      const free = raw.reduce((a, x, i) => a + (fixed[i] ? 0 : x), 0);
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        w[i] = free > 0 ? (raw[i] / free) * left : left / raw.filter((_, j) => !fixed[j]).length;
        if (w[i] > cap) { w[i] = cap; fixed[i] = true; left -= cap; changed = true; }
      }
      if (!changed) break;
    }
    return w;
  }

  // Convierte cantidades ideales en importes redondeados que suman exactamente `total`
  // (método del resto mayor).
  function roundToTotal(amounts, total, step) {
    const floors = amounts.map((a) => floorTo(a, step));
    let left = Math.round((total - floors.reduce((a, b) => a + b, 0)) / step);
    const order = amounts.map((a, i) => [a - floors[i], i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; left > 0 && order.length; k++, left--) {
      const i = order[k % order.length][1];
      floors[i] = round2(floors[i] + step);
    }
    return floors;
  }

  const SUSPECT_COVER = 0.1;
  const MIN_ODDS = 1.15; // cuota mínima de cualquier apuesta suelta o selección de combinada
  const isSuspectCover = (o) => !!o.legs && o.ev > SUSPECT_COVER;

  function pickUsable(opportunities, P) {
    // Nada de apuestas a cuota casi 1: arriesgan dinero para no ganar prácticamente nada
    return opportunities.filter((o) => P.types.includes(o.type) && (o.legs || o.price >= MIN_ODDS) &&
      // Una surebet de más del 10 % casi siempre es un error de la casa: solo entra en el plan arriesgado.
      (o.legs ? !(isSuspectCover(o) && !P.types.includes('palpable'))
        : P.minConf.includes(o.confidence) && o.fairProb >= P.minProb && o.fairProb <= P.maxProb));
  }

  // ---- Modo «todo el presupuesto»: se apuesta el 100 % repartido entre las mejores opciones ----
  function allocateFull(usable, budget, P, step, minStake) {
    const usedEvents = new Set();
    const covers = usable.filter((o) => o.legs).sort((a, b) => b.ev - a.ev);
    const simplesAll = usable.filter((o) => !o.legs && o.fairProb > 0).sort((a, b) => b.ev - a.ev);

    // Con poco dinero, pocas apuestas: 10 € → 5, 100 € → 15 (luego manda el tope del perfil).
    const maxCount = Math.max(2, Math.round(Math.sqrt(budget) * 1.5));
    const maxCovers = Math.min(3, Math.max(1, Math.floor(maxCount / 3)));

    let coverPool = covers.length ? (simplesAll.length ? P.coverShare : 1) * budget : 0;
    const chosenCovers = [];
    for (const o of covers) {
      if (chosenCovers.length >= maxCovers || usedEvents.has(o.eventId)) continue;
      const share = coverPool / (chosenCovers.length + 1);
      if (share < o.legs.length * minStake * 2) break; // patas demasiado pequeñas
      chosenCovers.push(o);
      usedEvents.add(o.eventId);
    }
    if (!chosenCovers.length) coverPool = 0;

    let simples = [];
    const maxSimples = Math.max(1, Math.min(P.maxBets, maxCount - chosenCovers.length));
    for (const o of simplesAll) {
      if (simples.length >= maxSimples) break;
      if (usedEvents.has(o.eventId)) continue;
      usedEvents.add(o.eventId);
      simples.push(o);
    }
    if (!simples.length && chosenCovers.length) coverPool = budget;
    let simplePool = round2(budget - coverPool);

    // Cuántas apuestas simples caben con el mínimo por apuesta.
    let amounts = [];
    while (simples.length) {
      simples = simples.slice(0, Math.max(1, Math.min(simples.length, Math.floor(simplePool / minStake))));
      const w = cappedWeights(simples.map(weightOf), P.maxShare);
      amounts = roundToTotal(w.map((x) => x * simplePool), simplePool, step);
      const small = amounts.findIndex((a) => a < minStake);
      if (small < 0) break;
      // Se quita la apuesta con menos peso y se vuelve a repartir.
      const minI = w.indexOf(Math.min(...w));
      simples.splice(minI, 1);
    }
    if (!simples.length && chosenCovers.length) { coverPool = budget; simplePool = 0; }

    const bets = [];
    // Coberturas: reparto proporcional a su beneficio.
    if (chosenCovers.length) {
      const evs = chosenCovers.map((o) => o.ev);
      const tot = evs.reduce((a, b) => a + b, 0);
      const shares = roundToTotal(evs.map((e) => (coverPool * e) / tot), round2(coverPool), step);
      chosenCovers.forEach((o, i) => {
        const c = coverLegs(o.legs, shares[i], step);
        if (c.guaranteed > 0 && c.legs.every((l) => l.stake >= minStake)) {
          bets.push({ kind: 'cobertura', opp: o, legs: c.legs, stake: c.stake, guaranteed: c.guaranteed });
        }
      });
    }
    simples.forEach((o, i) => bets.push({ kind: 'simple', opp: o, stake: amounts[i], price: o.price, winProb: o.fairProb }));

    // Lo que sobre por redondear las patas de las coberturas va a la mejor apuesta simple.
    const left = floorTo(budget - bets.reduce((a, b) => a + b.stake, 0), step);
    if (left > 0) {
      const top = bets.find((b) => b.kind === 'simple');
      if (top) top.stake = round2(top.stake + left);
    }
    return bets;
  }

  // ---- Modo prudente: Kelly fraccional, se guarda una reserva ----
  function allocatePrudent(usable, budget, P, step, minStake) {
    const usedEvents = new Set();
    const bets = [];
    let coverSpent = 0;
    for (const o of usable.filter((x) => x.legs).sort((a, b) => b.ev - a.ev)) {
      if (usedEvents.has(o.eventId)) continue;
      const room = Math.min(P.maxCoverEach * budget, P.maxCover * budget - coverSpent);
      if (room < minStake * o.legs.length) break;
      const c = coverLegs(o.legs, room, step);
      if (c.guaranteed <= 0 || c.legs.some((l) => l.stake < minStake)) continue;
      coverSpent += c.stake;
      usedEvents.add(o.eventId);
      bets.push({ kind: 'cobertura', opp: o, legs: c.legs, stake: c.stake, guaranteed: c.guaranteed });
    }
    let raw = [];
    for (const o of usable.filter((x) => !x.legs).sort((a, b) => b.ev - a.ev)) {
      if (raw.length >= P.maxBets) break;
      if (usedEvents.has(o.eventId)) continue;
      // Sin ventaja no hay Kelly: se apuesta una cantidad fija pequeña (media apuesta máxima)
      let frac = kellyFull(o) > 0 ? Math.min(kellyFull(o) * P.kelly, P.maxBet) : o.type === 'bajo' ? P.maxBet / 2 : 0;
      if (o.type === 'palpable') frac *= 0.5; // riesgo de anulación: se apuesta la mitad
      if (frac <= 0) continue;
      usedEvents.add(o.eventId);
      raw.push({ o, amount: frac * budget });
    }
    const exposure = raw.reduce((a, r) => a + r.amount, 0);
    const cap = Math.min(P.maxExposure * budget, budget - coverSpent);
    if (exposure > cap) raw = raw.map((r) => ({ ...r, amount: (r.amount * cap) / exposure }));
    for (const r of raw) {
      const stake = floorTo(r.amount, step);
      if (stake < minStake) continue;
      bets.push({ kind: 'simple', opp: r.o, stake, price: r.o.price, winProb: r.o.fairProb });
    }
    return bets;
  }

  function buildPlan(opportunities, budget, profileKey = 'moderado', opts = {}) {
    profileKey = ALIAS[profileKey] || profileKey;
    const P = PROFILES[profileKey] || PROFILES.moderado;
    const full = opts.full !== false;
    const step = opts.step || stakeStep(budget);
    const minStake = Math.max(opts.minStake || 0.1, step);
    const voidProb = { ...VOID_PROB, ...(opts.voidProb || {}) };
    let usable = pickUsable(opportunities, P);

    // 1) Combinadas del perfil (una parte del presupuesto), con partidos que luego no se repiten en sueltas
    const combos = [];
    if (opts.combos !== false) {
      const usedEv = new Set();
      for (const cfg of P.combos || []) {
        const pool = usable.filter((o) => !o.legs && !usedEv.has(o.eventId));
        const t = buildTicket(pool, { label: `Combinada de ${cfg.legs}`, legs: cfg.legs, minP: cfg.minP, maxP: cfg.maxP || 1 }, 0, opts.book || null);
        const stake = floorTo(budget * cfg.share, step);
        if (!t.ok || stake < minStake) continue;
        const tk = ticketFrom(t.legs, stake);
        t.legs.forEach((o) => usedEv.add(o.eventId));
        combos.push({
          kind: 'combinada', legs: t.legs, stake, price: tk.odds, winProb: tk.prob,
          opp: { type: 'combinada', ev: tk.ev, eventId: `combo-${combos.length}`, legs: t.legs },
        });
      }
      usable = usable.filter((o) => !usedEv.has(o.eventId));
    }
    // 2) El resto del dinero, a apuestas sueltas (y surebets)
    const rest = round2(budget - combos.reduce((a, c) => a + c.stake, 0));
    const singles = full ? allocateFull(usable, rest, P, step, minStake) : allocatePrudent(usable, rest, P, step, minStake);
    const bets = [...singles, ...combos];

    const warnings = [];
    if (!bets.length) warnings.push('Ahora mismo no hay ninguna apuesta con valor que encaje con este perfil.');
    if (bets.some((b) => b.opp.type === 'palpable' || b.opp.type === 'interno' || isSuspectCover(b.opp))) {
      warnings.push('El plan incluye errores palpables o arbitrajes internos: es muy probable que la casa anule esas apuestas.');
    }
    const negative = bets.filter((b) => b.kind === 'simple' && b.opp.ev < 0);
    if (negative.length) {
      warnings.push(`${negative.length} apuesta${negative.length > 1 ? 's tienen' : ' tiene'} EV negativo: la cuota paga algo menos de lo justo, así que a la larga se pierde de media. Entran porque has pedido apostar aunque el EV sea bajo.`);
    }
    if (full && bets.length === 1 && bets[0].kind === 'simple') {
      warnings.push('Todo el presupuesto va a una sola apuesta: si falla, lo pierdes entero.');
    }

    for (const b of bets) {
      b.voidProb = isSuspectCover(b.opp) ? Math.max(0.5, voidProb[b.opp.type] || 0) : voidProb[b.opp.type] || 0;
      if (b.kind === 'combinada') b.voidProb = 0.03;
      if (b.kind === 'simple' || b.kind === 'combinada') {
        b.profitIfWin = round2(b.stake * (b.price - 1));
        b.expected = round2((b.winProb * b.price - 1) * b.stake * (1 - b.voidProb));
      } else {
        b.expected = round2(b.guaranteed * (1 - b.voidProb));
      }
    }

    const total = round2(bets.reduce((a, b) => a + b.stake, 0));
    return {
      profile: profileKey, budget, full, step, minStake, bets, total, reserve: round2(budget - total), warnings,
      stats: simulate(bets, budget, opts.sims || 20000, opts.seed || 12345),
    };
  }

  // Simulación Monte Carlo: los partidos son independientes (una apuesta por partido).
  function simulate(bets, budget, n = 20000, seed = 12345) {
    const r = rng(seed);
    const results = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let pnl = 0;
      for (const b of bets) {
        if (r() < b.voidProb) continue; // anulada: se devuelve el dinero
        if (b.kind === 'cobertura') pnl += b.guaranteed;
        else pnl += r() < b.winProb ? b.profitIfWin : -b.stake;
      }
      results[i] = pnl;
    }
    const sorted = Array.from(results).sort((a, b) => a - b);
    const pct = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];
    const expected = bets.reduce((a, b) => a + b.expected, 0);
    // Las combinadas se comportan como una apuesta suelta: ganan o pierden entera
    const simple = bets.filter((b) => b.kind !== 'cobertura');
    const covers = bets.filter((b) => b.kind === 'cobertura');
    const coverProfit = covers.reduce((a, b) => a + b.guaranteed, 0);
    const best = coverProfit + simple.reduce((a, b) => a + b.profitIfWin, 0);
    // Peor caso: fallan todas las simples y se anulan las coberturas que pueden anularse.
    const worst = covers.reduce((a, b) => a + (b.voidProb > 0 ? 0 : b.guaranteed), 0) - simple.reduce((a, b) => a + b.stake, 0);
    const pWorst = simple.length
      ? simple.reduce((a, b) => a * (1 - b.winProb * (1 - b.voidProb)), 1) * covers.reduce((a, b) => a * (b.voidProb > 0 ? b.voidProb : 1), 1)
      : 0;
    const atRisk = simple.reduce((a, b) => a + b.stake, 0);

    // Histograma de 24 barras
    const bins = 24;
    const lo = sorted[0], hi = sorted[n - 1];
    const width = (hi - lo) / bins || 1;
    const hist = new Array(bins).fill(0);
    for (const v of sorted) hist[Math.min(bins - 1, Math.floor((v - lo) / width))]++;

    return {
      expected: round2(expected),
      expectedPct: budget ? expected / budget : 0,
      pLoss: sorted.filter((v) => v < -0.005).length / n,
      pProfit: sorted.filter((v) => v > 0.005).length / n,
      p10: round2(pct(0.1)), p50: round2(pct(0.5)), p90: round2(pct(0.9)),
      best: round2(best), worst: round2(worst), pWorst,
      atRisk: round2(atRisk), atRiskPct: budget ? atRisk / budget : 0,
      hist: { lo, hi, width, counts: hist, n },
    };
  }

  // Los tres planes a la vez (seguro, moderado y arriesgado).
  function buildAllPlans(opportunities, budget, opts = {}) {
    const out = {};
    for (const k of Object.keys(PROFILES)) out[k] = buildPlan(opportunities, budget, k, opts);
    return out;
  }

  // ---- Apuesta combinada (varias selecciones en un solo boleto) ----
  // Nivel de riesgo: número de selecciones, probabilidad mínima de cada una y parte del presupuesto.
  const TICKETS = {
    moderado: { label: 'Riesgo moderado', icon: '🟢', legs: 2, minP: 0.6, maxP: 1, stakeShare: 0.2, help: '2 selecciones muy probables (más del 60 % cada una).' },
    medio: { label: 'Riesgo medio', icon: '🟡', legs: 3, minP: 0.45, maxP: 1, stakeShare: 0.1, help: '3 selecciones con al menos un 45 % de acierto cada una.' },
    alto: { label: 'Riesgo alto', icon: '🔴', legs: 5, minP: 0.3, maxP: 0.65, stakeShare: 0.05, help: '5 selecciones con cuotas más altas: poca probabilidad, premio grande.' },
  };

  // Familia de cada mercado, para elegir qué tipos de apuesta entran en una combinada.
  function familyOf(o) {
    if (o.sport === 'voleibol') return 'voleibol';
    const k = String(o.market).split(':')[0];
    if (/corners|cspread/.test(k)) return 'corners';
    if (/cards/.test(k)) return 'tarjetas';
    if (/sot/.test(k)) return 'disparos';
    if (k === 'spreads' || k === 'eh') return 'handicap';
    if (k === 'totals' || k === 'htotal' || k === 'atotal' || k === 'btts') return 'goles';
    return 'resultado';
  }

  // Elige las selecciones (una por partido, todas de la misma casa) y calcula el boleto.
  // `level` es un nivel de TICKETS o una configuración propia { label, legs, minP, maxP, families }.
  function buildTicket(candidates, level, stake, book = null) {
    const T = typeof level === 'string' ? TICKETS[level] : level;
    let pool = candidates.filter((o) => !o.legs && o.fairProb >= T.minP && o.fairProb <= Math.min(T.maxP, 0.9) && o.price >= MIN_ODDS &&
      (!T.families || T.families.includes(familyOf(o))));
    // Una combinada se hace en una sola casa: la indicada o la que más selecciones válidas tenga.
    if (!book) {
      const count = {};
      for (const o of pool) count[o.book] = (count[o.book] || 0) + 1;
      book = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
    pool = pool.filter((o) => o.book === book).sort((a, b) => b.ev - a.ev || b.fairProb - a.fairProb);
    const legs = [];
    const used = new Set();
    for (const o of pool) {
      if (legs.length >= T.legs) break;
      if (used.has(o.eventId)) continue; // partidos distintos: resultados independientes
      used.add(o.eventId);
      legs.push(o);
    }
    if (legs.length < T.legs) return { level, legs, ok: false, book, reason: `Solo hay ${legs.length} selección${legs.length === 1 ? '' : 'es'} que encajen en «${T.label}» (hacen falta ${T.legs}).` };
    return ticketFrom(legs, stake, { level, book });
  }

  // Calcula un boleto a partir de sus selecciones (también para las que añades a mano).
  function ticketFrom(legs, stake, extra = {}) {
    const odds = round2(legs.reduce((a, o) => a * o.price, 1));
    const prob = legs.reduce((a, o) => a * o.fairProb, 1);
    const ev = prob * odds - 1;
    stake = round2(stake);
    return {
      ...extra, legs, ok: legs.length >= 2, odds, prob, ev, stake,
      profitIfWin: round2(stake * (odds - 1)),
      expected: round2(stake * ev),
      lossProb: 1 - prob,
    };
  }

  // Cuota mínima a la que la apuesta sigue teniendo valor (EV ≥ 0): 1 / probabilidad justa, redondeada hacia arriba.
  const minOdds = (p) => Math.ceil((1 / p) * 100) / 100;

  return { TICKETS, buildTicket, ticketFrom, familyOf, PROFILES, ALIAS, VOID_PROB, buildPlan, buildAllPlans, simulate, coverLegs, cappedWeights, roundToTotal, stakeStep, minOdds };
});
