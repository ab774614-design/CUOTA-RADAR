'use strict';
// Noticias recientes de cada equipo desde Google Noticias (RSS público, sin clave), que agrupa medios
// deportivos como Marca, AS, Mundo Deportivo, Relevo, ESPN o BBC. Se marcan los titulares que
// hablan de bajas, lesiones, sanciones o cambios de entrenador: son avisos de riesgo, no cambian el cálculo.

const TTL_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 4 * 24 * 3600 * 1000;
const cache = new Map(); // equipo|deporte -> { t, items }

const FLAGS = [
  ['lesión', /lesi[oó]n|lesionad|se rompe|rotura|molestias|injur/i],
  ['baja', /\bbaja(s)?\b|no jugar[aá]|se pierde|descartad|ruled out|will miss|out for/i],
  ['duda', /\bduda\b|en duda|doubt|fitness test/i],
  ['sanción', /sanci[oó]n|sancionad|expulsi[oó]n|suspend|tarjeta roja|red card/i],
  ['entrenador', /destitu|cesad|despid|nuevo entrenador|sacked|interim/i],
  ['rotaciones', /rotacion|rotation|reservas|suplentes|once alternativo/i],
];

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decode(r[1]) : ''; };
    const title = get('title');
    const source = get('source');
    items.push({
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title,
      link: get('link'),
      source,
      date: Date.parse(get('pubDate')) || 0,
    });
  }
  return items;
}

function flagsOf(title) {
  return FLAGS.filter(([, re]) => re.test(title)).map(([name]) => name);
}

async function teamNews(team, sport) {
  const key = `${team}|${sport}`;
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL_MS) return c.items;
  const q = `"${team}" ${sport === 'voleibol' ? 'voleibol' : 'fútbol'}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es&gl=ES&ceid=ES:es`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 CuotaRadar' } });
  if (!res.ok) throw new Error(`Noticias ${res.status}`);
  const now = Date.now();
  const items = parseRss(await res.text())
    .filter((it) => now - it.date < MAX_AGE_MS)
    .sort((a, b) => b.date - a.date)
    .slice(0, 8)
    .map((it) => ({ ...it, flags: flagsOf(it.title) }));
  cache.set(key, { t: now, items });
  return items;
}

// teams: [{ name, sport }] → { [name]: items[] }. Pocas peticiones a la vez para no saturar.
async function newsFor(teams) {
  const out = {};
  const queue = [...teams];
  const errors = [];
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      try { out[t.name] = await teamNews(t.name, t.sport); } catch (e) { out[t.name] = []; errors.push(`${t.name}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { news: out, errors };
}

module.exports = { newsFor, parseRss, flagsOf };
