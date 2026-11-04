'use strict';
// Motor de análisis: quita el margen, calcula probabilidades justas y detecta cuotas a favor del usuario.
// Formato de evento normalizado (lo producen demo.js y oddsapi.js):
// { id, sport: 'futbol'|'voleibol', sportKey, league, home, away, commence (ISO), live,
//   books: [{ key, title, updated (ms), markets: { [marketId]: { label, outcomes: { [sel]: cuota } } } }] }

// 'modelo' es una referencia calculada (voleibol de bet365): se usa solo si no hay ninguna casa sharp.
const SHARP_DEFAULT = ['pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'matchbook', 'smarkets', 'modelo'];
// Comisión sobre la ganancia neta en los exchanges.
const EXCHANGE_FEE = { betfair_ex_eu: 0.05, betfair_ex_uk: 0.05, matchbook: 0.02, smarkets: 0.02 };

// ---------- Matemática básica ----------

function implied(odds) {
  return odds.map((o) => 1 / o);
}

function overround(odds) {
  return implied(odds).reduce((a, b) => a + b, 0);
}

function devigMultiplicative(odds) {
  const q = implied(odds);
  const s = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / s);
}

function devigAdditive(odds) {
  const q = implied(odds);
  const s = q.reduce((a, b) => a + b, 0);
  const n = q.length;
  const p = q.map((x) => x - (s - 1) / n);
  // Con favoritos muy claros el método aditivo puede dar negativos: se recorta y renormaliza.
  if (p.some((x) => x <= 0)) return devigMultiplicative(odds);
  return p;
}

// Método potencia: busca k tal que sum(q_i^k) = 1.
function devigPower(odds) {
  const q = implied(odds);
  const sum = (k) => q.reduce((a, x) => a + Math.pow(x, k), 0);
  let lo = 0.01, hi = 20;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const p = q.map((x) => Math.pow(x, k));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / s);
}

// Método de Shin: modela una fracción z de apostadores con información privilegiada.
function devigShin(odds) {
  const q = implied(odds);
  const S = q.reduce((a, b) => a + b, 0);
  if (S <= 1) return devigMultiplicative(odds);
  const probs = (z) => q.map((x) => (Math.sqrt(z * z + 4 * (1 - z) * x * x / S) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const s = probs(mid).reduce((a, b) => a + b, 0);
    if (s > 1) lo = mid; else hi = mid;
  }
  const p = probs((lo + hi) / 2);
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / s);
}

const DEVIG = {
  multiplicativo: devigMultiplicative,
  aditivo: devigAdditive,
  potencia: devigPower,
  shin: devigShin,
};

// `total` es lo que suman las probabilidades reales del mercado: 1 normalmente, 2 en la doble
// oportunidad (cada opción cubre dos de los tres resultados). Si no es 1 se usa el método potencia.
function devig(odds, method = 'potencia', total = 1) {
  if (total === 1) return (DEVIG[method] || devigPower)(odds);
  const q = implied(odds);
  const sum = (k) => q.reduce((a, x) => a + Math.pow(x, k), 0);
  let lo = 0.01, hi = 20;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > total) lo = mid; else hi = mid;
  }
  const p = q.map((x) => Math.pow(x, (lo + hi) / 2));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => (x * total) / s);
}

const marketTotal = (mId) => (mId === 'dc' ? 2 : 1);

function expectedValue(p, odds) {
  return p * odds - 1;
}

// Fracción de Kelly completa: (p·cuota − 1) / (cuota − 1). Negativa → no apostar.
function kelly(p, odds) {
  return (p * odds - 1) / (odds - 1);
}

// Reparto de stakes en un arbitraje para ganar lo mismo salga lo que salga.
function arbitrageStakes(odds, total) {
  const inv = implied(odds);
  const s = inv.reduce((a, b) => a + b, 0);
  const stakes = inv.map((x) => (total * x) / s);
  return { sum: s, profitPct: 1 / s - 1, stakes, payout: total / s };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------- Histórico para detectar líneas desfasadas ----------

class History {
  constructor(maxAgeMs = 60 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs;
    this.fair = new Map(); // clave evento|mercado|sel -> [{t, p}]
    this.price = new Map(); // clave evento|mercado|casa|sel -> [{t, o}]
  }
  _push(map, key, item) {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    const last = arr[arr.length - 1];
    if (last && item.t - last.t < 1000) arr[arr.length - 1] = item; else arr.push(item);
    while (arr.length && item.t - arr[0].t > this.maxAgeMs) arr.shift();
  }
  recordFair(key, t, p) { this._push(this.fair, key, { t, p }); }
  recordPrice(key, t, o) { this._push(this.price, key, { t, o }); }
  // Valor más antiguo dentro de la ventana [now - windowMs, now].
  oldestWithin(map, key, now, windowMs) {
    const arr = map.get(key);
    if (!arr) return null;
    for (const it of arr) if (now - it.t <= windowMs) return it;
    return null;
  }
  // ¿La cuota de la casa sigue igual desde hace al menos `sinceT`?
  priceUnchangedSince(key, sinceT, current) {
    const arr = this.price.get(key);
    if (!arr || !arr.length || arr[0].t > sinceT) return false;
    for (const it of arr) if (it.t >= sinceT && Math.abs(it.o - current) > 1e-9) return false;
    return true;
  }
}

// ---------- Análisis ----------

const DEFAULTS = {
  method: 'potencia',
  minEV: 0.02,
  palpable: 0.25,
  minBooks: 3,
  sharp: SHARP_DEFAULT,
  kellyFraction: 0.25,
  maxStakePct: 0.05,
  bankroll: 100,
  maxAgeMin: 30,
  staleWindowMin: 10,
  staleMovePP: 0.02,
};

function marketReference(books, sels, opts, total = 1) {
  // 1) Casa sharp disponible → su precio sin margen.
  for (const key of opts.sharp) {
    const b = books.find((x) => x.key === key);
    if (b) {
      const fair = devig(sels.map((s) => b.prices[s]), opts.method, total);
      if (b.key === 'modelo') return { kind: 'modelo', bookKey: b.key, label: b.title, fair, nBooks: books.length };
      return { kind: 'sharp', bookKey: b.key, label: `${b.title} sin margen`, fair, nBooks: books.length };
    }
  }
  // 2) Consenso: mediana de las probabilidades sin margen de todas las casas.
  if (books.length >= opts.minBooks) {
    const per = books.map((b) => devig(sels.map((s) => b.prices[s]), opts.method, total));
    const med = sels.map((_, i) => median(per.map((p) => p[i])));
    const s = med.reduce((a, c) => a + c, 0);
    return { kind: 'consenso', bookKey: null, label: `Consenso de ${books.length} casas`, fair: med.map((x) => (x * total) / s), nBooks: books.length };
  }
  // 3) Una sola casa (p. ej. córners o tarjetas de bet365): su propio precio sin margen. Nunca da «valor»
  //    (siempre sale EV negativo) pero permite calcular el riesgo y el EV aproximado de esas apuestas.
  const own = books.filter((b) => !b.refOnly);
  if (own.length === 1 && books.length === 1) {
    const b = own[0];
    return { kind: 'propia', bookKey: b.key, label: `${b.title} sin su margen (sin referencia externa)`, fair: devig(sels.map((s) => b.prices[s]), opts.method, total), nBooks: 1 };
  }
  return null;
}

function confidence(ref, ageMin) {
  if (!ref) return 'baja';
  if (ageMin > 15) return 'baja';
  if (ref.kind === 'sharp') return 'alta';
  if (ref.kind === 'modelo' || ref.kind === 'propia') return 'baja';
  return ref.nBooks >= 6 ? 'media' : 'baja';
}

function analyze(events, userOpts = {}, history = null, now = Date.now()) {
  const opts = { ...DEFAULTS, ...userOpts };
  const opportunities = [];
  const details = [];

  for (const ev of events) {
    const marketIds = new Set();
    for (const b of ev.books) for (const m of Object.keys(b.markets)) marketIds.add(m);
    const evDetail = { ...ev, markets: [] };

    for (const mId of marketIds) {
      // Conjunto de selecciones más habitual del mercado.
      const counts = new Map();
      let label = mId;
      for (const b of ev.books) {
        const m = b.markets[mId];
        if (!m) continue;
        label = m.label || label;
        const sig = Object.keys(m.outcomes).sort().join('|');
        counts.set(sig, (counts.get(sig) || 0) + 1);
      }
      const sig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const sels = sortSelections(sig.split('|'));
      if (sels.length < 2) continue;

      const books = [];
      for (const b of ev.books) {
        const m = b.markets[mId];
        if (!m) continue;
        if (!sels.every((s) => m.outcomes[s] > 1)) continue;
        const ageMin = (now - (b.updated || now)) / 60000;
        if (ageMin > opts.maxAgeMin) continue; // cuota demasiado vieja: no se usa
        // En los exchanges se cobra comisión sobre la ganancia: para apostar se usa la cuota neta.
        const fee = EXCHANGE_FEE[b.key] || 0;
        const net = {};
        for (const s of sels) net[s] = fee ? +(1 + (m.outcomes[s] - 1) * (1 - fee)).toFixed(3) : m.outcomes[s];
        books.push({ key: b.key, title: b.title, prices: m.outcomes, net, fee, ageMin, refOnly: !!b.refOnly });
      }
      if (!books.length) continue;

      const total = marketTotal(mId);
      const ref = marketReference(books, sels, opts, total);
      const best = sels.map((s) => {
        let top = null;
        for (const b of books) if (!b.refOnly && (!top || b.net[s] > top.price)) top = { price: b.net[s], book: b.key, title: b.title };
        return top;
      });

      evDetail.markets.push({
        id: mId,
        label,
        sels,
        selLabels: sels.map((s) => selectionLabel(s, ev, mId)),
        fair: ref ? ref.fair : null,
        reference: ref ? ref.label : null,
        refKind: ref ? ref.kind : null,
        best,
        books: books.map((b) => ({
          key: b.key, title: b.title, prices: sels.map((s) => b.prices[s]), net: b.fee ? sels.map((s) => b.net[s]) : undefined,
          margin: +(overround(sels.map((s) => b.prices[s])) - total).toFixed(4), ageMin: +b.ageMin.toFixed(1),
        })),
      });

      const base = {
        eventId: ev.id, sport: ev.sport, league: ev.league, home: ev.home, away: ev.away,
        commence: ev.commence, live: !!ev.live, market: mId, marketLabel: label,
      };

      // Histórico (líneas desfasadas)
      if (history && ref) {
        sels.forEach((s, i) => history.recordFair(`${ev.id}|${mId}|${s}`, now, ref.fair[i]));
      }

      // --- Valor, desfasadas y error palpable ---
      if (ref) {
        for (const b of books) {
          if (b.refOnly || ((ref.kind === 'sharp' || ref.kind === 'propia') && b.key === ref.bookKey)) continue;
          sels.forEach((s, i) => {
            const price = b.net[s];
            const p = ref.fair[i];
            const ev_ = expectedValue(p, price);
            const priceKey = `${ev.id}|${mId}|${b.key}|${s}`;
            let type = null;
            let note = '';
            if (ev_ >= opts.palpable) {
              type = 'palpable';
              note = 'Cuota muy alejada del mercado: alto riesgo de anulación por error palpable.';
            } else if (ev_ >= opts.minEV) {
              type = 'valor';
              if (history) {
                const old = history.oldestWithin(history.fair, `${ev.id}|${mId}|${s}`, now, opts.staleWindowMin * 60000);
                if (old && p - old.p >= opts.staleMovePP && history.priceUnchangedSince(priceKey, old.t, price)) {
                  type = 'desfasada';
                  note = `La probabilidad justa ha subido ${((p - old.p) * 100).toFixed(1)} pp en ${Math.round((now - old.t) / 60000)} min y ${b.title} no ha movido su cuota.`;
                }
              }
            }
            if (type) {
              const k = Math.max(0, kelly(p, price)) * opts.kellyFraction;
              const stakePct = Math.min(k, opts.maxStakePct);
              opportunities.push({
                ...base,
                id: `${type}|${ev.id}|${mId}|${s}|${b.key}`,
                type,
                selection: s,
                selectionLabel: selectionLabel(s, ev, mId),
                book: b.key,
                bookTitle: b.title,
                price,
                fairProb: p,
                fairOdds: 1 / p,
                ev: ev_,
                stakePct,
                stake: +(opts.bankroll * stakePct).toFixed(2),
                reference: ref.label,
                ageMin: b.ageMin,
                confidence: confidence(ref, b.ageMin),
                risk: type === 'palpable' ? 'alto' : ev_ > 0.1 ? 'medio' : 'bajo',
                note: b.fee ? `${note ? note + ' ' : ''}Cuota ${b.prices[s].toFixed(2)} menos ${Math.round(b.fee * 100)} % de comisión.` : note,
              });
            }
            if (history) history.recordPrice(priceKey, now, price);
          });
        }
      }

      // --- Surebet entre casas ---
      const arb = arbitrageStakes(best.map((x) => x.price), opts.bankroll);
      const distinct = new Set(best.map((x) => x.book));
      if (total === 1 && arb.sum < 1 && distinct.size > 1) {
        opportunities.push({
          ...base,
          id: `surebet|${ev.id}|${mId}|${best.map((x) => x.book + x.price).join(',')}`,
          type: 'surebet',
          ev: arb.profitPct,
          legs: sels.map((s, i) => ({ selection: s, selectionLabel: selectionLabel(s, ev, mId), book: best[i].book, bookTitle: best[i].title, price: best[i].price, stake: +arb.stakes[i].toFixed(2) })),
          payout: +arb.payout.toFixed(2),
          reference: ref ? ref.label : 'Mejores cuotas',
          confidence: 'media',
          risk: arb.profitPct > 0.1 ? 'alto' : arb.profitPct > 0.05 ? 'medio' : 'bajo',
          note: arb.profitPct > 0.1
            ? 'Beneficio demasiado alto: casi seguro una cuota errónea que la casa anulará.'
            : 'Cubre todos los resultados repartiendo el stake entre casas.',
        });
      }

      // --- Arbitraje dentro de una sola casa ---
      for (const b of books) {
        if (b.refOnly) continue;
        const odds = sels.map((s) => b.net[s]);
        const a = arbitrageStakes(odds, opts.bankroll);
        if (total === 1 && a.sum < 1) {
          opportunities.push({
            ...base,
            id: `interno|${ev.id}|${mId}|${b.key}`,
            type: 'interno',
            ev: a.profitPct,
            book: b.key,
            bookTitle: b.title,
            legs: sels.map((s, i) => ({ selection: s, selectionLabel: selectionLabel(s, ev, mId), book: b.key, bookTitle: b.title, price: odds[i], stake: +a.stakes[i].toFixed(2) })),
            payout: +a.payout.toFixed(2),
            reference: `Margen de ${b.title} negativo`,
            confidence: 'alta',
            risk: 'alto',
            note: 'La propia casa paga más de lo que cobra en este mercado: casi seguro un error y puede anularse.',
          });
        }
      }
    }
    opportunities.push(...ladderOpportunities(ev, opts, now));
    details.push(evDetail);
  }

  opportunities.sort((a, b) => b.ev - a.ev);
  return { opportunities, events: details };
}

// ---------- Líneas incoherentes dentro de una misma casa ----------
// «Más de 9.5» siempre es al menos tan probable como «más de 10.5», así que debe pagar igual o menos.
// Si paga más, es un error claro de la casa (no hace falta ninguna referencia externa). Igual con «menos».
const LADDERS = ['totals', 'htotal', 'atotal', 'corners', 'hcorners', 'acorners', 'cards', 'hcards', 'acards', 'sot', 'hsot', 'asot'];

function ladderOpportunities(ev, opts, now) {
  const out = [];
  for (const b of ev.books) {
    if (b.refOnly) continue;
    for (const fam of LADDERS) {
      const lines = Object.keys(b.markets).filter((id) => id.startsWith(`${fam}:`)).map((id) => Number(id.split(':')[1])).sort((x, y) => x - y);
      for (let i = 0; i + 1 < lines.length; i++) {
        const lo = lines[i], hi = lines[i + 1];
        const mLo = b.markets[`${fam}:${lo}`].outcomes, mHi = b.markets[`${fam}:${hi}`].outcomes;
        const checks = [
          // más de la línea baja frente a más de la alta
          { better: mLo[`Más ${lo}`], worse: mHi[`Más ${hi}`], line: lo, sel: `Más ${lo}`, vs: `más de ${hi}` },
          // menos de la línea alta frente a menos de la baja
          { better: mHi[`Menos ${hi}`], worse: mLo[`Menos ${lo}`], line: hi, sel: `Menos ${hi}`, vs: `menos de ${lo}` },
        ];
        for (const c of checks) {
          if (!(c.better > 1 && c.worse > 1) || c.better <= c.worse * 1.02) continue;
          // Probabilidad al menos la de la otra línea (quitando un 5 % de margen): estimación prudente
          const p = Math.min(0.97, 0.95 / c.worse);
          const evv = p * c.better - 1;
          if (evv < opts.minEV) continue;
          const mId = `${fam}:${c.line}`;
          const k = Math.max(0, kelly(p, c.better)) * opts.kellyFraction;
          const stakePct = Math.min(k, opts.maxStakePct);
          out.push({
            eventId: ev.id, sport: ev.sport, league: ev.league, home: ev.home, away: ev.away, commence: ev.commence, live: !!ev.live,
            market: mId, marketLabel: b.markets[mId].label,
            id: `palpable|${ev.id}|${mId}|${c.sel}|${b.key}|ladder`, type: 'palpable', selection: c.sel,
            selectionLabel: selectionLabel(c.sel, ev, mId), book: b.key, bookTitle: b.title, price: c.better,
            fairProb: p, fairOdds: 1 / p, ev: evv, stakePct, stake: +(opts.bankroll * stakePct).toFixed(2),
            reference: `La propia ${b.title}: «${c.vs}» paga ${c.worse.toFixed(2)}`, ageMin: (now - (b.updated || now)) / 60000,
            confidence: 'media', risk: 'alto',
            note: `Línea incoherente: es al menos igual de probable que «${c.vs}» y paga más (${c.better.toFixed(2)} frente a ${c.worse.toFixed(2)}). Posible error que la casa puede anular.`,
          });
        }
      }
    }
  }
  return out;
}

const SEL_ORDER = ['1', 'X', '2', '1X', '12', 'X2', 'Sí', 'No'];
function sortSelections(sels) {
  return sels.sort((a, b) => {
    const ia = SEL_ORDER.indexOf(a), ib = SEL_ORDER.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    if (a.startsWith('Más') && b.startsWith('Menos')) return -1;
    if (a.startsWith('Menos') && b.startsWith('Más')) return 1;
    if (a === 'Otro') return 1;
    if (b === 'Otro') return -1;
    return a.localeCompare(b, 'es', { numeric: true });
  });
}

const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

// Texto claro de la selección según el mercado (lo que hay que buscar en la casa).
function selectionLabel(sel, ev, marketId = 'h2h') {
  const [k, v] = marketId.split(':');
  if (k === 'spreads' || k === 'cspread') {
    const L = Number(v);
    const unit = k === 'cspread' ? ' córners' : '';
    return sel === '1' ? `${ev.home} ${signed(L)}${unit}` : `${ev.away} ${signed(-L)}${unit}`;
  }
  if (k === 'eh') {
    const L = Number(v);
    return sel === '1' ? `${ev.home} (${signed(L)})` : sel === '2' ? `${ev.away} (${signed(-L)})` : `Empate con hándicap (${signed(L)})`;
  }
  const UNITS = { corners: 'córners', hcorners: 'córners', acorners: 'córners', cards: 'tarjetas', hcards: 'tarjetas', acards: 'tarjetas', sot: 'disparos a puerta', hsot: 'disparos a puerta', asot: 'disparos a puerta' };
  if (UNITS[k]) {
    const who = k[0] === 'h' ? `${ev.home}: ` : k[0] === 'a' ? `${ev.away}: ` : '';
    return `${who}${sel} ${UNITS[k]}`;
  }
  if (k === 'ht') return sel === '1' ? `${ev.home} gana al descanso` : sel === '2' ? `${ev.away} gana al descanso` : 'Empate al descanso';
  if (k === 'cs') return sel === 'Otro' ? 'Otro resultado' : `${sel} (${ev.home} - ${ev.away})`;
  if (k === 'set1') return sel === '1' ? `${ev.home} gana el 1.er set` : `${ev.away} gana el 1.er set`;
  if (k === 'htotal') return `${ev.home}: ${sel} goles`;
  if (k === 'atotal') return `${ev.away}: ${sel} goles`;
  if (k === 'btts') return sel === 'Sí' ? 'Ambos marcan: Sí' : 'Ambos marcan: No';
  if (k === 'sets') return `${sel} sets`;
  if (sel === '1') return ev.home;
  if (sel === '2') return ev.away;
  if (sel === 'X') return 'Empate';
  if (sel === '1X') return `${ev.home} o empate`;
  if (sel === '12') return `${ev.home} o ${ev.away}`;
  if (sel === 'X2') return `Empate o ${ev.away}`;
  return sel;
}

module.exports = {
  implied, overround, devig, devigMultiplicative, devigAdditive, devigPower, devigShin,
  expectedValue, kelly, arbitrageStakes, median, History, analyze, DEFAULTS, SHARP_DEFAULT, selectionLabel,
};
