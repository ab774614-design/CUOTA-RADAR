'use strict';
// Empareja partidos de proveedores distintos (The Odds API y bet365/PulseScore), que escriben
// los nombres de los equipos de forma diferente («FC Twente» / «Twente», «Ath Bilbao» / «Athletic Club»).

const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'cd', 'ud', 'sd', 'rcd', 'club', 'de', 'la', 'el', 'fk', 'sk', 'if', 'bk', 'calcio', 'football', 'futbol', 'the', 'and', 'cp', 'sv', 'vfl', 'vfb', 'tsg', '1', 'w', 'women']);

function tokens(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

// Parecido entre dos nombres de 0 a 1.
function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const ja = ta.join(''), jb = tb.join('');
  if (ja === jb) return 1;
  if (ja.length >= 4 && jb.length >= 4 && (ja.includes(jb) || jb.includes(ja))) return 0.9;
  // Las palabras muy repetidas en nombres de clubes («Real», «United»…) cuentan menos.
  const w = (t) => (WEAK.has(t) ? 0.35 : 1);
  let common = 0;
  for (const t of ta) if (tb.some((u) => u === t || (t.length >= 4 && u.length >= 4 && (u.startsWith(t) || t.startsWith(u))))) common += w(t);
  const total = Math.max(ta.reduce((a, t) => a + w(t), 0), tb.reduce((a, t) => a + w(t), 0));
  return common / total;
}

const WEAK = new Set(['real', 'united', 'city', 'atletico', 'athletic', 'sporting', 'inter', 'deportivo', 'union', 'racing', 'dynamo', 'dinamo', 'olympique', 'borussia', 'st', 'saint', 'santa', 'san', 'nacional', 'independiente', 'universidad', 'town', 'rovers', 'wanderers', 'albion', 'county', 'u19', 'u21', 'u23', 'ii', 'b']);

// Busca para cada evento de `base` su pareja en `others` (misma hora ± 3 h y equipos parecidos).
function matchEvents(base, others) {
  const pairs = new Map();
  const used = new Set();
  for (const e of base) {
    const t = Date.parse(e.commence);
    let best = null;
    for (const o of others) {
      if (used.has(o.id)) continue;
      if (Math.abs(Date.parse(o.commence) - t) > 3 * 3600e3) continue;
      const sh = similarity(e.home, o.home), sa = similarity(e.away, o.away);
      const score = Math.min(sh, sa) * 0.6 + Math.max(sh, sa) * 0.4;
      if ((Math.min(sh, sa) >= 0.5 || (Math.max(sh, sa) >= 0.9 && Math.min(sh, sa) >= 0.3)) && (!best || score > best.score)) best = { o, score };
    }
    if (best) { pairs.set(e.id, best.o); used.add(best.o.id); }
  }
  return pairs;
}

module.exports = { similarity, matchEvents, tokens };
