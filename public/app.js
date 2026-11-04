'use strict';
// Interfaz de CuotaRadar: elige competiciones, lanza análisis periódicos y muestra las oportunidades.

const TYPES = {
  valor: { label: 'Valor (EV+)', color: 'var(--valor)', help: 'La cuota paga más que la probabilidad justa del mercado.' },
  desfasada: { label: 'Línea desfasada', color: 'var(--desfasada)', help: 'El mercado se ha movido y esta casa aún no.' },
  surebet: { label: 'Surebet', color: 'var(--surebet)', help: 'Combinando casas se gana salga lo que salga.' },
  interno: { label: 'Arbitraje interno', color: 'var(--interno)', help: 'Una sola casa con margen negativo.' },
  palpable: { label: 'Error palpable', color: 'var(--palpable)', help: 'Cuota absurda: mucho valor pero alto riesgo de anulación.' },
  bajo: { label: 'EV bajo', color: 'var(--muted)', help: 'Cuota cercana a la justa: poca o ninguna ventaja; entra porque has pedido apostar aunque el EV sea bajo.' },
};

const PREFS_KEY = 'cuotaradar:prefs';
const MAX_LEAGUES = 20; // ligas a la vez en modo real (igual que en el servidor)
const $ = (s) => document.querySelector(s);
const fmtPct = (x, d = 1) => `${(x * 100).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
const fmtOdds = (o) => o.toFixed(2);
const tz = 'Europe/Madrid';
const fmtTime = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtClock = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
// Fecha (AAAA-MM-DD) en hora de Madrid, para saber si un partido se juega hoy.
const madridDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const isToday = (iso) => madridDay.format(new Date(iso)) === madridDay.format(new Date());
const todayOnly = () => state.prefs.todayOnly !== false;
// Con PulseScore en modo real, la Champions y LaLiga se buscan siempre aunque no haya ligas marcadas.
const alwaysOn = () => state.config && state.config.mode === 'real' && state.config.hasPsKey;
const inDay = (o) => !todayOnly() || isToday(o.commence);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  config: null,
  sports: [],
  scan: null,
  seen: new Set(),
  firstSeen: new Map(), // id -> timestamp en que apareció
  nextAt: 0,
  loading: false,
  plan: null,
  planAt: 0,
  prefs: loadPrefs(),
};

function loadPrefs() {
  const def = { selected: {}, sport: 'all', types: Object.keys(TYPES), book: '', evMin: 2, time: 'all', sound: false, sort: 'ev', budget: null, profile: 'equilibrado', tab: 'opps', full: true, minStake: 0.1, auto: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch {}
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- Competiciones ----------

function selectedKeys() {
  const mode = state.config.mode;
  const sel = state.prefs.selected[mode];
  if (!sel) return mode === 'demo' ? state.sports.map((s) => s.key) : [];
  return sel.filter((k) => state.sports.some((s) => s.key === k));
}

function setSelected(keys) {
  state.prefs.selected[state.config.mode] = keys;
  savePrefs();
}

function renderLeagues() {
  const q = $('#leagueSearch').value.trim().toLowerCase();
  const sel = new Set(selectedKeys());
  const counts = {};
  for (const o of state.scan?.opportunities || []) {
    const ev = state.scan.events.find((e) => e.id === o.eventId);
    if (ev) counts[ev.sportKey] = (counts[ev.sportKey] || 0) + 1;
  }
  const groups = {};
  for (const s of state.sports) {
    if (state.prefs.sport !== 'all' && s.sport !== state.prefs.sport) continue;
    if (q && !s.title.toLowerCase().includes(q)) continue;
    (groups[s.group] = groups[s.group] || []).push(s);
  }
  let html = '';
  for (const [g, list] of Object.entries(groups)) {
    html += `<div class="grp">${esc(g)}</div>`;
    for (const s of list) {
      const sc = state.scout && state.scout.byKey[s.key];
      const badge = sc ? `<span class="cnt" title="Rastreo: ${sc.opps} oportunidades, mejor EV ${fmtPct(sc.bestEv)}">${sc.score > 0 ? `★ ${fmtPct(sc.bestEv, 0)}` : '—'}</span>` : counts[s.key] ? `<span class="cnt">${counts[s.key]}</span>` : '';
      html += `<label><input type="checkbox" value="${esc(s.key)}" ${sel.has(s.key) ? 'checked' : ''}> ${esc(s.title)}${badge}</label>`;
    }
  }
  $('#leagueList').innerHTML = html || '<p class="hint">No hay competiciones disponibles ahora mismo.</p>';
  const hint = $('#leagueHint');
  if (state.config.mode === 'real') {
    hint.textContent = `${sel.size} seleccionadas (máx. ${MAX_LEAGUES}). Cada liga gasta unos 3 créditos al actualizarse.`;
  } else {
    hint.textContent = `${sel.size} seleccionadas.`;
  }
}

// ---------- Análisis ----------

// Si ya hay un análisis en marcha, se devuelve ese mismo (para poder esperarlo).
function runScan() {
  if (!state.loading) state.scanPromise = doScan();
  return state.scanPromise;
}

async function doScan() {
  const keys = selectedKeys();
  state.loading = true;
  $('#liveText').textContent = 'analizando…';
  try {
    if (!keys.length && !alwaysOn()) {
      state.scan = { opportunities: [], events: [], errors: [], at: Date.now() };
      setLive('err', 'elige competiciones');
    } else {
      const data = await api(`/api/scan?sports=${encodeURIComponent(keys.join(','))}`);
      const fresh = [];
      for (const o of data.opportunities) {
        if (!state.firstSeen.has(o.id)) {
          // En la primera carga nada es «nuevo».
          state.firstSeen.set(o.id, state.scan ? Date.now() : 0);
          if (state.scan) fresh.push(o);
        }
      }
      state.scan = data;
      if (!state.plan && state.prefs.budget) buildPlan();
      setLive('ok', `actualizado ${fmtClock.format(new Date(data.at))}`);
      showErrors(data.errors);
      if (data.psUsage) updatePsPill(data.psUsage);
      if (data.credits && data.credits.remaining !== null) {
        $('#credits').textContent = `${data.credits.remaining} créditos`;
        $('#credits').classList.remove('hidden');
      }
      const visibleFresh = fresh.filter(passesFilters);
      if (visibleFresh.length) {
        toast(`${visibleFresh.length} oportunidad${visibleFresh.length > 1 ? 'es' : ''} nueva${visibleFresh.length > 1 ? 's' : ''}`);
        if (state.prefs.sound) beep();
      }
    }
  } catch (e) {
    setLive('err', 'error');
    showErrors([e.message]);
  } finally {
    state.loading = false;
    scheduleNext();
    render();
    updateEstimate();
  }
}

// ---------- Ahorro de créditos ----------

// Créditos que costaría la próxima búsqueda (lo que está en caché no se paga).
async function updateEstimate() {
  if (state.config.mode !== 'real') { state.estimate = null; return; }
  try {
    const keys = selectedKeys();
    state.estimate = keys.length ? (await api(`/api/estimate?sports=${encodeURIComponent(keys.join(','))}`)).credits : 0;
  } catch { state.estimate = null; }
}

// En modo real, marcar ligas no busca al momento (gastaría créditos en cada clic): solo recalcula el coste.
function afterSelectionChange() {
  if (state.config.mode === 'real') { updateEstimate(); renderLeagues(); }
  else runScan();
}

// Búsqueda pedida por el usuario: si va a gastar bastante, lo pregunta antes.
async function manualScan() {
  if (state.config.mode === 'real') {
    await updateEstimate();
    const left = state.config.credits?.remaining ?? state.scan?.credits?.remaining;
    if (state.estimate > 15 && !(await askConfirm(`Esta búsqueda gastará unos <b>${state.estimate} créditos</b>${left != null ? ` de los ${left} que te quedan` : ''}. ¿Seguimos?`, 'Buscar'))) return false;
  }
  await runScan();
  return true;
}

function updatePsPill(u) {
  const p = $('#psPill');
  if (!u || state.config.mode !== 'real') { p.classList.add('hidden'); return; }
  p.textContent = `bet365: ${u.used}/${u.total} peticiones este mes`;
  p.classList.remove('hidden');
}

function askConfirm(html, okText = 'Aceptar') {
  return new Promise((resolve) => {
    const d = $('#confirmDlg');
    $('#confirmMsg').innerHTML = html;
    $('#confirmOk').textContent = okText;
    const done = (v) => { d.close(); resolve(v); };
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
    d.onclose = () => resolve(false);
    d.showModal();
  });
}

// Rastreo barato de todas las ligas y selección automática de las más rentables.
async function scoutFlow() {
  const days = $('#scoutDays').value === 'hoy' ? 'hoy' : Number($('#scoutDays').value) || 3;
  const top = Number($('#scoutTop').value) || 5;
  const btn = $('#scoutBtn');
  btn.disabled = true;
  try {
    if (state.config.mode === 'real') {
      btn.textContent = 'Mirando calendario (gratis)…';
      const dry = await api('/api/scout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days, top, dryRun: true }) });
      if (dry.noCredits) {
        // Sin créditos: se busca lo que no los necesita (Champions, LaLiga y voleibol por PulseScore)
        await askConfirm('The Odds API se ha quedado <b>sin créditos</b> este mes, así que no puedo rastrear otras ligas.<br><br>Sí busco con PulseScore (gratis): <b>todos los partidos de la Champions y LaLiga</b> con todos sus mercados, y el voleibol de bet365.', 'Buscar eso');
        const keep = selectedKeys().filter((k) => k.startsWith('fav_') || k === 'b365_volleyball');
        setSelected(keep.length ? keep : ['fav_ucl', 'fav_laliga', 'b365_volleyball']);
        await runScan(); buildPlan(); setTab('plan');
        return;
      }
      const left = dry.credits?.remaining;
      const ok = await askConfirm(`Hay <b>${dry.leaguesWithMatches}</b> ligas con partidos ${days === 'hoy' ? '<b>hoy</b>' : days === 1 ? 'en las próximas 24 horas' : `en los próximos ${days} días`}.<br><br>
        1️⃣ Rastreo de las <b>${dry.candidates}</b> con más partidos (solo 1X2): <b>${dry.cost} créditos</b>${dry.cost === 0 ? ' (ya están en caché)' : ''}.<br>
        2️⃣ Búsqueda completa de las <b>${top}</b> mejores: unos <b>${dry.fullCost} créditos</b> más.<br>
        ${dry.psUsage ? `3️⃣ Cuotas de bet365 (PulseScore): unas <b>${dry.psCost} peticiones</b> de las ${dry.psUsage.left} que te quedan este mes.<br>` : ''}<br>
        Total aproximado: <b>${dry.cost + dry.fullCost}</b>${left != null ? ` de los ${left} que te quedan` : ''} (tope de ${dry.cap} por búsqueda, se cambia en ⚙ Ajustes). Buscar en todas las ligas a la vez costaría unas ${dry.leaguesWithMatches * 3}.`, 'Rastrear');
      if (!ok) return;
    }
    btn.textContent = 'Rastreando ligas…';
    const r = await api('/api/scout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days, top }) });
    state.scout = { at: Date.now(), byKey: Object.fromEntries(r.ranking.map((x) => [x.key, x])) };
    if (r.errors?.length) showErrors(r.errors.slice(0, 3));
    if (!r.recommended.length) { toast('El rastreo no ha encontrado valor en ninguna liga ahora mismo.'); renderLeagues(); return; }
    setSelected(r.recommended);
    const names = r.recommended.map((k) => state.scout.byKey[k].title).join(', ');
    btn.textContent = 'Buscando las mejores…';
    await runScan();
    buildPlan();
    setTab('plan');
    toast(`He marcado ${r.recommended.length} ligas: ${names}`);
  } catch (e) {
    showErrors([e.message]);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔎 Elegir las ligas más rentables';
    updateEstimate();
  }
}

function setLive(cls, text) {
  const p = $('#livePill');
  p.classList.remove('ok', 'err');
  p.classList.add(cls);
  $('#liveText').textContent = text;
}

function showErrors(errs) {
  const b = $('#errorBanner');
  if (errs && errs.length) { b.innerHTML = errs.map(esc).join('<br>'); b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function refreshSec() {
  return state.config.mode === 'real' ? state.config.refreshRealSec : state.config.refreshDemoSec;
}

function scheduleNext() {
  state.nextAt = Date.now() + refreshSec() * 1000;
}

setInterval(() => {
  if (!state.config) return;
  // Sin actualización automática todo se queda fijo hasta que el usuario pulse buscar o recalcular.
  if (!state.prefs.auto) {
    const left = state.scan?.credits?.remaining ?? state.config.credits?.remaining;
    const cost = state.config.mode !== 'real' || state.estimate == null ? ''
      : left != null && left <= 1 && state.estimate > 0 ? ' · sin créditos (solo PulseScore)'
        : ` · ${state.estimate ? `~${state.estimate} créditos` : 'gratis (en caché)'}`;
    $('#countdown').textContent = state.loading ? 'buscando…' : `Buscar ahora${cost}`;
    return;
  }
  const left = Math.max(0, Math.round((state.nextAt - Date.now()) / 1000));
  $('#countdown').textContent = state.loading ? '…' : `${left}s`;
  if (left === 0 && !state.loading && !document.hidden) runScan();
}, 1000);

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch {}
}

// ---------- Filtros y lista ----------

function passesFilters(o) {
  const p = state.prefs;
  if (p.sport !== 'all' && o.sport !== p.sport) return false;
  if (!inDay(o)) return false;
  if (!p.types.includes(o.type)) return false;
  // El EV mínimo es para apuestas sueltas; un arbitraje siempre se muestra.
  if (!o.legs && o.ev * 100 < p.evMin) return false;
  if (p.time === 'live' && !o.live) return false;
  if (p.time === 'pre' && o.live) return false;
  if (p.book) {
    const books = o.legs ? o.legs.map((l) => l.book) : [o.book];
    if (!books.includes(p.book)) return false;
  }
  const q = $('#search').value.trim().toLowerCase();
  if (q) {
    const hay = [o.home, o.away, o.league, o.bookTitle, ...(o.legs || []).map((l) => l.bookTitle)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function render() {
  renderLeagues();
  renderChips();
  renderBooks();
  if (state.prefs.tab === 'plan') renderPlan();
  const scan = state.scan;
  if (!scan) return;
  const opps = scan.opportunities.filter(passesFilters);
  const sort = state.prefs.sort;
  if (sort === 'time') opps.sort((a, b) => new Date(a.commence) - new Date(b.commence));
  else if (sort === 'new') opps.sort((a, b) => state.firstSeen.get(b.id) - state.firstSeen.get(a.id));

  $('#kOpps').textContent = opps.length;
  $('#kBest').textContent = opps.length ? fmtPct(Math.max(...opps.map((o) => o.ev))) : '—';
  $('#kArbs').textContent = opps.filter((o) => o.type === 'surebet' || o.type === 'interno').length;
  $('#kEvents').textContent = scan.events.filter(inDay).length;
  $('#kPrices').textContent = scan.events.reduce((a, e) => a + e.markets.reduce((b, m) => b + m.books.length * m.sels.length, 0), 0).toLocaleString('es-ES');

  const list = $('#list');
  if (!selectedKeys().length && !alwaysOn()) {
    list.innerHTML = `<div class="empty">Elige una o varias competiciones en el panel de la izquierda para empezar a analizar.</div>`;
    return;
  }
  if (!opps.length) {
    list.innerHTML = `<div class="empty">Ninguna cuota a tu favor con estos filtros ahora mismo.<br>${state.prefs.auto ? `El análisis se repite solo cada ${refreshSec()} s.` : 'Pulsa «⟳ Buscar ahora» para volver a buscar.'}</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = opps.slice(0, 200).map((o) => card(o, now - state.firstSeen.get(o.id) < 60000)).join('');
}

function whenText(o) {
  if (o.live) return '<span class="livebadge">● EN VIVO</span>';
  return esc(fmtTime.format(new Date(o.commence)));
}

function card(o, isNew) {
  const t = TYPES[o.type];
  const head = `<div class="meta"><span class="tag">${t.label}</span>${isNew ? '<span class="new">NUEVO</span>' : ''}
    <span>${o.sport === 'futbol' ? '⚽' : '🏐'} ${esc(o.league)}</span><span>·</span><span>${whenText(o)}</span></div>
    <div class="match">${esc(o.home)} <span style="color:var(--muted)">vs</span> ${esc(o.away)}</div>`;
  if (o.legs) {
    const legs = o.legs.map((l) => `<div class="leg">${esc(l.selectionLabel)} · <b>${fmtOdds(l.price)}</b> en ${esc(l.bookTitle)}<br><span class="sub">Apostar ${l.stake.toFixed(2)} €</span></div>`).join('');
    return `<div class="card t-${o.type}" data-ev="${esc(o.eventId)}" data-id="${esc(o.id)}">
      <div>${head}<div class="pick">${esc(o.marketLabel)}</div><div class="legs">${legs}</div>
      <div class="sub">${esc(o.note)} Con ${state.config.bankroll} € cobras ${o.payout.toFixed(2)} € pase lo que pase.</div></div>
      <div class="nums"><div class="num big"><span>Beneficio</span><b>${fmtPct(o.ev, 2)}</b></div>
      <div class="num"><span>Riesgo</span><b class="risk-${o.risk}">${o.risk}</b></div></div></div>`;
  }
  return `<div class="card t-${o.type}" data-ev="${esc(o.eventId)}" data-id="${esc(o.id)}">
    <div>${head}
      <div class="pick">${esc(o.marketLabel)} → <b>${esc(o.selectionLabel)}</b> en <span class="book">${esc(o.bookTitle)}</span></div>
      <div class="sub">Referencia: ${esc(o.reference)} · prob. justa ${fmtPct(o.fairProb)} · cuota actualizada hace ${Math.max(0, Math.round(o.ageMin))} min${o.note ? ' · ' + esc(o.note) : ''}</div>
      <button class="btn ghost add-combo" data-add="${esc(o.id)}">➕ Combinada</button>
    </div>
    <div class="nums">
      <div class="num"><span>Cuota</span><b>${fmtOdds(o.price)}</b></div>
      <div class="num"><span>Justa</span><b class="strike">${fmtOdds(o.fairOdds)}</b></div>
      <div class="num big"><span>EV</span><b>+${fmtPct(o.ev)}</b></div>
      <div class="num"><span>Stake</span><b>${o.stake.toFixed(2)} €</b></div>
      <div class="num"><span>Confianza</span><b class="lvl-${o.confidence}">${o.confidence}</b></div>
      <div class="num"><span>Riesgo anul.</span><b class="risk-${o.risk}">${o.risk}</b></div>
    </div></div>`;
}

function renderChips() {
  $('#typeChips').innerHTML = Object.entries(TYPES).map(([k, t]) =>
    `<button class="chip ${state.prefs.types.includes(k) ? 'on' : ''}" data-t="${k}" style="--c:${t.color}" title="${esc(t.help)}"><i></i>${t.label}</button>`).join('');
}

function renderBooks() {
  const sel = $('#bookFilter');
  const books = new Map();
  for (const ev of state.scan?.events || []) for (const m of ev.markets) for (const b of m.books) books.set(b.key, b.title);
  const cur = state.prefs.book;
  if (cur && !books.has(cur)) books.set(cur, cur);
  const opts = ['<option value="">Todas</option>', ...[...books.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`)].join('');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
  sel.value = cur;
}

// ---------- Detalle del partido ----------

function openDetail(eventId, oppId) {
  const ev = state.scan.events.find((e) => e.id === eventId);
  if (!ev) return;
  const opp = state.scan.opportunities.find((o) => o.id === oppId);
  $('#dTitle').textContent = `${ev.home} vs ${ev.away}`;
  let html = `<p class="sub">${ev.sport === 'futbol' ? '⚽' : '🏐'} ${esc(ev.league)} · ${ev.live ? 'EN VIVO' : esc(fmtTime.format(new Date(ev.commence)))} (hora de Madrid)</p>`;
  if (opp) html += `<p class="sub" style="color:var(--text)">${esc(TYPES[opp.type].help)}</p>`;
  for (const m of ev.markets) {
    const labels = m.id === 'cs' ? m.sels : m.selLabels || m.sels;
    html += `<div class="mkt"><h4>${esc(m.label)} <small>${m.reference ? 'Referencia: ' + esc(m.reference) : 'Sin referencia fiable'}</small></h4><div class="tbl-wrap"><table>
      <tr><th>Casa</th>${labels.map((l) => `<th>${esc(l)}</th>`).join('')}<th>Margen</th></tr>`;
    if (m.fair) html += `<tr class="fair"><td>Cuota justa</td>${m.fair.map((p) => `<td>${fmtOdds(1 / p)} <span class="m">${fmtPct(p)}</span></td>`).join('')}<td>0 %</td></tr>`;
    const rows = [...m.books].sort((a, b) => a.margin - b.margin);
    for (const b of rows) {
      html += `<tr><td>${esc(b.title)}</td>${b.prices.map((p, i) => {
        const isBest = m.best[i].book === b.key;
        const isValue = m.fair && p * m.fair[i] - 1 >= state.config.minEV;
        return `<td class="${isBest ? 'best' : ''} ${isValue ? 'value' : ''}">${fmtOdds(p)}</td>`;
      }).join('')}<td style="color:${b.margin < 0 ? 'var(--interno)' : 'var(--muted)'}">${fmtPct(b.margin)}</td></tr>`;
    }
    html += `</table></div></div>`;
  }
  html += `<p class="hint">Verde: mejor cuota de cada resultado. Borde naranja: cuota con EV por encima del mínimo. Margen negativo = la casa paga más de lo que cobra.</p>`;
  html += `<div class="mkt"><h4>Noticias de los equipos <small>Google Noticias: Marca, AS, Mundo Deportivo, Relevo, ESPN…</small></h4><div id="dNews" class="sub">Buscando noticias…</div></div>`;
  $('#dBody').innerHTML = html;
  $('#detail').showModal();
  const fillNews = () => { const el = $('#dNews'); if (el) el.innerHTML = newsBadge(ev).replace('<details class="news">', '<details class="news" open>'); };
  if (ev.home in state.news && ev.away in state.news) fillNews();
  else api('/api/news', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teams: [{ name: ev.home, sport: ev.sport }, { name: ev.away, sport: ev.sport }] }) })
    .then((d) => { Object.assign(state.news, d.news); fillNews(); }).catch(() => { const el = $('#dNews'); if (el) el.textContent = 'No se han podido cargar las noticias.'; });
}

// ---------- Presupuesto y plan de apuestas ----------

const fmtEur = (x) => `${x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const fmtEurSigned = (x) => (x > 0 ? '+' : '') + fmtEur(x);

function updateBudgetLabel() {
  const b = state.prefs.budget;
  $('#budgetLabel').textContent = b ? fmtEur(b).replace(',00', '') : 'Presupuesto';
}

function openBudget() {
  const f = $('#budgetForm');
  f.budget.value = state.prefs.budget || '';
  f.full.checked = state.prefs.full;
  f.onlyB365.checked = onlyB365();
  f.planMinEV.value = String(planMinEv());
  f.minStake.value = state.prefs.minStake;
  $('#budgetDlg').showModal();
  setTimeout(() => f.budget.focus(), 50);
}

const profileKey = () => {
  const k = Portfolio.ALIAS[state.prefs.profile] || state.prefs.profile;
  return Portfolio.PROFILES[k] ? k : 'moderado';
};

async function saveBudget(e) {
  e.preventDefault();
  const f = $('#budgetForm');
  const budget = Number(f.budget.value);
  if (!(budget >= 1)) { toast('Indica un presupuesto de al menos 1 €.'); return; }
  state.prefs.budget = budget;
  state.prefs.onlyB365 = f.onlyB365.checked;
  state.prefs.planMinEV = Number(f.planMinEV.value);
  state.prefs.full = f.full.checked;
  state.prefs.minStake = Math.max(0.1, Number(f.minStake.value) || 0.1);
  savePrefs();
  updateBudgetLabel();
  $('#budgetDlg').close();
  // El stake de las tarjetas también usa este presupuesto.
  try {
    state.config = await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bankroll: budget }) });
  } catch {}
  buildPlan();
  setTab('plan');
}

// Por defecto, con clave de PulseScore los planes solo usan bet365.
const onlyB365 = () => (state.prefs.onlyB365 == null ? !!state.config.hasPsKey : state.prefs.onlyB365);
const isB365 = (o) => (o.legs ? o.legs.every((l) => l.book === 'bet365') : o.book === 'bet365');

// EV mínimo de las apuestas del plan (por defecto −3 %: apostar aunque el EV sea bajo).
const planMinEv = () => (state.prefs.planMinEV == null ? -0.03 : Number(state.prefs.planMinEV));

// Apuestas candidatas con poca o ninguna ventaja: todas las cuotas analizadas cuyo EV frente a la cuota
// justa esté entre `minEv` y el mínimo de «valor». Se descartan las cuotas muy largas (menos del 8 % de acierto).
function lowEvCandidates(existing, minEv) {
  const have = new Set(existing.filter((o) => !o.legs).map((o) => `${o.eventId}|${o.market}|${o.selection}|${o.book}`));
  const out = [];
  for (const e of state.scan.events) for (const m of e.markets) {
    if (!m.fair || !inDay(e)) continue;
    const conf = /Modelo|sin referencia/.test(m.reference || '') ? 'baja' : /Consenso/.test(m.reference || '') ? 'media' : 'alta';
    for (const b of m.books) {
      if (b.key === 'modelo' || (onlyB365() && b.key !== 'bet365')) continue;
      // La propia casa de referencia no cuenta (su cuota sin margen es la justa)
      if (m.refKind === 'sharp' && m.reference && m.reference.startsWith(b.title)) continue;
      m.sels.forEach((s, i) => {
        const price = (b.net || b.prices)[i];
        const p = m.fair[i];
        const ev = p * price - 1;
        // Fuera las cuotas muy largas (< 8 %) y las casi seguras que no ganan nada (cuota < 1,15 o > 90 %)
        if (ev < minEv || ev >= state.config.minEV || p < 0.08 || p > 0.9 || price < 1.15) return;
        if (have.has(`${e.id}|${m.id}|${s}|${b.key}`)) return;
        out.push({
          id: `bajo|${e.id}|${m.id}|${s}|${b.key}`, type: 'bajo', eventId: e.id, sport: e.sport, league: e.league,
          home: e.home, away: e.away, commence: e.commence, live: !!e.live, market: m.id, marketLabel: m.label,
          selection: s, selectionLabel: m.selLabels[i], book: b.key, bookTitle: b.title, price, fairProb: p, fairOdds: 1 / p,
          ev, reference: m.reference, ageMin: b.ageMin, confidence: conf, risk: 'bajo', note: '',
        });
      });
    }
  }
  return out;
}

function buildPlan() {
  if (!state.scan || !state.prefs.budget) return;
  // Los planes usan fútbol y voleibol siempre (el filtro de deporte del panel es solo para la lista).
  const opps = state.scan.opportunities.filter((o) => (!onlyB365() || isB365(o)) && inDay(o));
  const planMinEV = planMinEv();
  if (planMinEV < state.config.minEV) opps.push(...lowEvCandidates(opps, planMinEV));
  state.plans = Portfolio.buildAllPlans(opps, state.prefs.budget, { full: state.prefs.full, minStake: state.prefs.minStake });
  state.plan = state.plans[profileKey()];
  state.planAt = Date.now();
  loadNewsForPlans();
}

function selectPlan(k) {
  state.prefs.profile = k;
  savePrefs();
  if (state.plans) state.plan = state.plans[k];
  render();
}

function setTab(tab) {
  state.prefs.tab = tab;
  savePrefs();
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#planView').classList.toggle('hidden', tab !== 'plan');
  $('#oppsView').classList.toggle('hidden', tab !== 'opps');
  if (tab === 'plan' && !state.plan) buildPlan();
  render();
}

// ¿Sigue mereciendo la pena la apuesta con las cuotas del último análisis?
// 'ok' = igual o mejor · 'worse' = la cuota ha bajado pero aún tiene valor · 'gone' = ya no tiene valor.
function betStatus(b) {
  const o = b.opp;
  const ev = state.scan?.events.find((e) => e.id === o.eventId);
  const m = ev && ev.markets.find((x) => x.id === o.market);
  if (!m) return 'gone';
  const netOf = (book, sel) => {
    const bk = m.books.find((x) => x.key === book);
    const i = m.sels.indexOf(sel);
    if (!bk || i < 0) return null;
    return (bk.net || bk.prices)[i];
  };
  if (b.kind === 'cobertura') {
    const prices = o.legs.map((l) => netOf(l.book, l.selection));
    if (prices.some((p) => !p)) return 'gone';
    const sum = prices.reduce((a, p) => a + 1 / p, 0);
    if (sum >= 1) return 'gone';
    return prices.some((p, i) => p < o.legs[i].price) ? 'worse' : 'ok';
  }
  const price = netOf(o.book, o.selection);
  if (!price || !m.fair) return 'gone';
  const curEv = m.fair[m.sels.indexOf(o.selection)] * price - 1;
  // Ya no vale si ha bajado del EV mínimo elegido para el plan (0 % o el EV bajo que hayas aceptado)
  if (curEv < Math.min(0, planMinEv())) return 'gone';
  return price < b.price ? 'worse' : 'ok';
}

function riskWord(p) {
  if (p < 0.1) return ['Muy bajo', 'pos'];
  if (p < 0.25) return ['Bajo', 'pos'];
  if (p < 0.4) return ['Moderado', 'lvl-media'];
  if (p < 0.55) return ['Alto', 'neg'];
  return ['Muy alto', 'neg'];
}

function histogramSvg(h) {
  const W = 480, H = 120, n = h.counts.length;
  const max = Math.max(...h.counts) || 1;
  const bw = W / n;
  let bars = '';
  h.counts.forEach((c, i) => {
    const x0 = h.lo + i * h.width;
    const mid = x0 + h.width / 2;
    const bh = (c / max) * (H - 4);
    const color = mid < -0.005 ? 'var(--bad)' : mid > 0.005 ? 'var(--accent)' : 'var(--muted)';
    bars += `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}" opacity=".85"><title>${fmtEur(x0)} a ${fmtEur(x0 + h.width)}: ${((c / h.n) * 100).toFixed(1)} %</title></rect>`;
  });
  let zero = '', zeroLabel = '';
  if (h.lo < 0 && h.lo + h.width * n > 0) {
    const zx = ((0 - h.lo) / (h.width * n)) * W;
    zero = `<line x1="${zx.toFixed(1)}" x2="${zx.toFixed(1)}" y1="0" y2="${H}" stroke="var(--text)" stroke-dasharray="3 3" opacity=".6"/>`;
    const pct = (zx / W) * 100;
    if (pct > 12 && pct < 88) zeroLabel = `<span class="zero" style="left:${pct.toFixed(1)}%">0 €</span>`;
  }
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${zero}</svg>
    <div class="hist-legend"><span>${fmtEur(h.lo)}</span>${zeroLabel}<span>${fmtEur(h.lo + h.width * n)}</span></div>`;
}

// ---------- Crear una apuesta combinada (pestaña Oportunidades) ----------

// `minEv`: EV mínimo de cada selección. Las combinadas a medida admiten hasta −6 % porque córners, tarjetas y
// disparos solo tienen la referencia de bet365 (su margen deja el EV en torno a −4 %).
function ticketCandidates(minEv = planMinEv()) {
  const opps = (state.scan?.opportunities || []).filter((o) => !o.legs && (!onlyB365() || isB365(o)) && inDay(o));
  return [...opps, ...lowEvCandidates(opps, minEv)];
}

// Combinada «a mi gusto»: número de selecciones, acierto mínimo de cada una y tipos de mercado.
function customCfg() {
  const legs = Math.min(10, Math.max(2, Number($('#tcLegs').value) || 3));
  const minP = Number($('#tcMinP').value) / 100;
  const families = [...document.querySelectorAll('#tcFams input:checked')].map((i) => i.value);
  const approx = Math.pow(minP, legs); // acierto máximo aproximado si todas rozan el mínimo
  return { label: 'A mi gusto', icon: '⚙️', legs, minP, maxP: 1, families, help: `${legs} selecciones con al menos un ${Math.round(minP * 100)} % de acierto cada una.`, stakeShare: approx >= 0.35 ? 0.2 : approx >= 0.12 ? 0.1 : 0.05, approx };
}

function updateCustomRisk() {
  const c = customCfg();
  $('#tcMinPVal').textContent = `${Math.round(c.minP * 100)} %`;
  const [w, cls] = riskWord(1 - c.approx);
  $('#tcRisk').innerHTML = `Factor de riesgo: <b class="${cls}">${w.toLowerCase()}</b> · acierto de la combinada en torno al <b>${fmtPct(c.approx, c.approx < 0.01 ? 2 : 1)}</b> o más · importe sugerido ${fmtPct(c.stakeShare, 0)} del presupuesto`;
}

function buildCustomTicket() {
  if (!state.scan) { toast('Primero busca cuotas (⟳ Buscar ahora).'); return; }
  const cfg = customCfg();
  if (!cfg.families.length) { toast('Marca al menos un tipo de mercado.'); return; }
  const stake = Math.max(0.1, Math.round((state.prefs.budget || 10) * cfg.stakeShare * 10) / 10);
  state.ticket = { ...Portfolio.buildTicket(ticketCandidates(Math.min(planMinEv(), -0.06)), cfg, stake, onlyB365() ? 'bet365' : null), cfg, at: Date.now() };
  renderTicket();
}

// Añadir una oportunidad a mano a la combinada
function addLeg(id) {
  const o = [...(state.scan?.opportunities || []), ...ticketCandidates()].find((x) => x.id === id);
  if (!o || o.legs) return;
  const cur = state.ticket && state.ticket.manual ? state.ticket.legs : [];
  if (cur.length && cur[0].book !== o.book) { toast(`Una combinada tiene que ser de una sola casa (${cur[0].bookTitle}).`); return; }
  if (cur.some((l) => l.eventId === o.eventId)) { toast('Ya hay una selección de ese partido: en una combinada cada partido va una vez.'); return; }
  setManualLegs([...cur, o]);
  toast(`Añadida a la combinada (${cur.length + 1} selecciones)`);
}

function setManualLegs(legs) {
  const stake = state.ticket && state.ticket.manual ? state.ticket.stake : Math.max(0.1, Math.round((state.prefs.budget || 10) * 0.1 * 10) / 10);
  state.ticket = { ...Portfolio.ticketFrom(legs, stake, { level: 'manual' }), manual: true, at: Date.now(),
    cfg: { label: 'Combinada a mano', icon: '✍️', help: 'Selecciones elegidas por ti.', stakeShare: 0.1 } };
  for (const b of document.querySelectorAll('#ticketBtns button')) b.classList.remove('on');
  renderTicket();
}

function makeTicket(level) {
  if (level === 'custom') {
    $('#ticketCustom').classList.toggle('hidden');
    for (const b of document.querySelectorAll('#ticketBtns button')) b.classList.toggle('on', b.dataset.level === 'custom' && !$('#ticketCustom').classList.contains('hidden'));
    updateCustomRisk();
    return;
  }
  $('#ticketCustom').classList.add('hidden');
  if (!state.scan) { toast('Primero busca cuotas (⟳ Buscar ahora).'); return; }
  const T = Portfolio.TICKETS[level];
  const budget = state.prefs.budget || 10;
  const stake = Math.max(0.1, Math.round(budget * T.stakeShare * 10) / 10);
  // Queda fijo hasta que vuelvas a pulsar un botón
  state.ticket = { ...Portfolio.buildTicket(ticketCandidates(), level, stake, onlyB365() ? 'bet365' : null), at: Date.now() };
  for (const b of document.querySelectorAll('#ticketBtns button')) b.classList.toggle('on', b.dataset.level === level);
  renderTicket();
}

function renderTicket() {
  const out = $('#ticketOut');
  const t = state.ticket;
  if (!t) { out.innerHTML = '<p class="hint">Elige un nivel de riesgo y te digo qué apuestas combinar, cuánto apostar, el riesgo y lo que puedes ganar.</p>'; return; }
  const T = t.cfg || Portfolio.TICKETS[t.level];
  const legsHtml = () => t.legs.map((o, i) => {
    const when = o.live ? 'EN VIVO' : fmtTime.format(new Date(o.commence));
    return `<li><b>${esc(o.home)} – ${esc(o.away)}</b> <span class="sub">(${o.sport === 'futbol' ? '⚽' : '🏐'} ${esc(o.league)}, ${esc(when)})</span>${t.manual ? ` <button class="link" data-rm="${i}">✖ quitar</button>` : ''}<br>
      ${esc(o.marketLabel)} → <b>${esc(o.selectionLabel)}</b> a cuota <b>${fmtOdds(o.price)}</b>
      <span class="sub">· acierto ${fmtPct(o.fairProb, 0)} · EV ${o.ev >= 0 ? '+' : ''}${fmtPct(o.ev)}</span></li>`;
  }).join('');
  if (t.manual && t.legs.length < 2) {
    out.innerHTML = `<div class="ticket"><p style="margin:0 0 8px"><b>✍️ Combinada a mano</b></p><ol>${legsHtml()}</ol><p class="hint">Añade al menos otra selección con «➕ Combinada».</p></div>`;
    bindTicketRemove();
    return;
  }
  if (!t.ok) {
    out.innerHTML = `<div class="ticket"><p class="warn">${esc(t.reason)} Prueba otro nivel, baja el acierto mínimo, marca más tipos de mercado, busca más ligas (🔎) o permite apuestas con EV bajo (💰).</p></div>`;
    return;
  }
  const legs = legsHtml();
  const [rw, rcls] = riskWord(t.lossProb);
  out.innerHTML = `<div class="ticket">
    <p style="margin:0 0 8px"><b>${T.icon} ${esc(T.label)}</b> <span class="sub">· ${esc(T.help)} Combinada en <b>${esc(t.legs[0].bookTitle)}</b> · calculada a las ${fmtClock.format(new Date(t.at))}</span></p>
    <ol>${legs}</ol>
    <div class="ticket-stake"><label for="ticketStake">Importe a apostar (€)</label><input id="ticketStake" class="input" type="number" min="0.1" step="0.1" value="${t.stake}"><span class="sub">Sugerido: ${fmtPct(T.stakeShare, 0)} de tu presupuesto</span></div>
    <div class="ticket-sum">
      <div class="kpi"><span>Cuota total</span><b>${fmtOdds(t.odds)}</b></div>
      <div class="kpi"><span>Probabilidad de acertar</span><b>${fmtPct(t.prob, 1)}</b></div>
      <div class="kpi"><span>Riesgo de perder</span><b class="${rcls}">${fmtPct(t.lossProb, 0)}</b><small class="sub">${rw.toLowerCase()}</small></div>
      <div class="kpi"><span>Beneficio esperado</span><b class="${t.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(t.expected)}</b><small class="sub">EV ${t.ev >= 0 ? '+' : ''}${fmtPct(t.ev)}</small></div>
      <div class="kpi"><span>Si aciertas todas</span><b class="pos">${fmtEurSigned(t.profitIfWin)}</b><small class="sub">cobras ${fmtEur(t.stake + t.profitIfWin)}</small></div>
      <div class="kpi"><span>Si falla una</span><b class="neg">${fmtEurSigned(-t.stake)}</b><small class="sub">pierdes lo apostado</small></div>
    </div>
    ${t.ev < 0 ? `<p class="warn">EV negativo: en una combinada la desventaja de cada selección se multiplica. A la larga se pierde de media un ${fmtPct(-t.ev)} de lo apostado.</p>` : ''}
    <p class="hint">Basta con que falle una selección para perder la apuesta. Comprueba las cuotas en la casa antes de apostar: algunas combinaciones de mercados no se pueden juntar en un boleto.</p>
    <button class="btn ghost" id="copyTicket">📋 Copiar apuesta</button>
  </div>`;
  $('#ticketStake').addEventListener('input', (e) => {
    const v = Math.max(0.1, Number(e.target.value) || 0.1);
    Object.assign(state.ticket, { stake: v, profitIfWin: Math.round(v * (t.odds - 1) * 100) / 100, expected: Math.round(v * t.ev * 100) / 100 });
    const pos = e.target.selectionStart;
    renderTicket();
    const inp = $('#ticketStake'); inp.focus(); try { inp.setSelectionRange(pos, pos); } catch {}
  });
  bindTicketRemove();
  $('#copyTicket').onclick = () => {
    const txt = `${T.label} · combinada en ${t.legs[0].bookTitle} · ${fmtEur(t.stake)} a cuota ${fmtOdds(t.odds)}\n` +
      t.legs.map((o, i) => `${i + 1}. ${o.home} – ${o.away}: ${o.marketLabel} → ${o.selectionLabel} @ ${fmtOdds(o.price)}`).join('\n') +
      `\nAcierto ${fmtPct(t.prob, 1)} · Si gana ${fmtEurSigned(t.profitIfWin)} · Beneficio esperado ${fmtEurSigned(t.expected)}`;
    navigator.clipboard.writeText(txt).then(() => toast('Apuesta copiada'), () => toast('No se ha podido copiar'));
  };
}

function bindTicketRemove() {
  for (const b of document.querySelectorAll('#ticketOut [data-rm]')) {
    b.onclick = () => { const legs = state.ticket.legs.filter((_, i) => i !== Number(b.dataset.rm)); legs.length ? setManualLegs(legs) : (state.ticket = null, renderTicket()); };
  }
}

// ---------- Noticias de los equipos del plan ----------

state.news = {};

async function loadNewsForPlans() {
  if (!state.plans) return;
  const teams = new Map();
  for (const pl of Object.values(state.plans)) for (const b of pl.bets) {
    for (const o of b.kind === 'combinada' ? b.legs : [b.opp]) {
      for (const name of [o.home, o.away]) if (name && !(name in state.news)) teams.set(name, { name, sport: o.sport });
    }
  }
  if (!teams.size) return;
  try {
    const data = await api('/api/news', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teams: [...teams.values()] }) });
    Object.assign(state.news, data.news);
    if (state.prefs.tab === 'plan') renderPlan();
  } catch {}
}

function newsItems(o) {
  return [o.home, o.away].flatMap((t) => (state.news[t] || []).map((it) => ({ ...it, team: t })));
}

// Avisos de noticias para una apuesta. Una baja en el equipo al que apuestas es una mala señal.
function newsBadge(o) {
  if (!(o.home in state.news)) return ' <span class="sub">📰 buscando noticias…</span>';
  const items = newsItems(o);
  if (!items.length) return ' <span class="sub">📰 sin noticias recientes</span>';
  const flagged = items.filter((it) => it.flags.length);
  const sum = flagged.length
    ? `<span class="lvl-media">⚠️ ${flagged.length} aviso${flagged.length > 1 ? 's' : ''} en noticias (${[...new Set(flagged.flatMap((f) => f.flags))].join(', ')})</span>`
    : `📰 ${items.length} noticia${items.length > 1 ? 's' : ''} recientes, sin avisos`;
  const list = items.sort((a, b) => b.flags.length - a.flags.length || b.date - a.date).slice(0, 6).map((it) =>
    `<li>${it.flags.length ? '⚠️ ' : ''}<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a> <span class="sub">${esc(it.source)} · ${esc(it.team)} · ${esc(fmtTime.format(new Date(it.date)))}</span></li>`).join('');
  return `<details class="news"><summary>${sum}</summary><ul>${list}</ul></details>`;
}

// Cuánto le falta a bet365 para tener una cuota con valor (mejor EV frente a la cuota justa).
function b365Gap() {
  let best = -Infinity, txt = '', n = 0;
  const margins = [];
  for (const e of state.scan?.events || []) for (const m of e.markets) {
    const b = m.books.find((x) => x.key === 'bet365');
    if (!b) continue;
    if (m.id === 'h2h') margins.push(b.margin);
    if (!m.fair) continue;
    m.sels.forEach((s, i) => {
      n++;
      const ev = m.fair[i] * (b.net || b.prices)[i] - 1;
      if (ev > best) { best = ev; txt = `${e.home} – ${e.away}, ${m.selLabels[i]} a ${fmtOdds(b.prices[i])}`; }
    });
  }
  return { n, best, txt, margin: margins.length ? margins.reduce((a, x) => a + x, 0) / margins.length : 0 };
}

function chosenCoverText(plan) {
  const cov = plan.bets.filter((b) => b.kind === 'cobertura').reduce((a, b) => a + b.stake, 0);
  return cov > 0 ? `${fmtEur(cov)} a surebets (beneficio casi seguro)` : 'ahora no hay surebets que encajen';
}

function renderPlan() {
  const body = $('#planBody');
  const P = Portfolio.PROFILES[profileKey()];
  if (!state.prefs.budget) {
    $('#planTitle').textContent = 'Mi plan de apuestas';
    $('#planSub').textContent = '';
    body.innerHTML = `<div class="empty">Dime cuánto presupuesto tienes y te propongo dónde y cuánto apostar.<br><br><button class="btn primary" id="planStart">💰 Indicar presupuesto</button></div>`;
    $('#planStart').onclick = openBudget;
    return;
  }
  if (!state.plan) { body.innerHTML = '<div class="empty">Esperando el primer análisis de cuotas…</div>'; return; }
  const plan = state.plan, s = plan.stats;
  $('#planTitle').textContent = `Tus 3 planes para ${fmtEur(plan.budget)}`;
  $('#planSub').textContent = `Planes fijos calculados a las ${fmtClock.format(new Date(state.planAt))} con fútbol y voleibol${todayOnly() ? ', solo partidos de hoy' : ''}. No cambian hasta que pulses «Recalcular». ${plan.full ? 'Cada plan reparte todo el presupuesto.' : 'Modo prudente: guardan una reserva.'} Confirma cada cuota en la casa antes de apostar.`;

  // Comparativa de los tres planes
  const cmp = `<div class="plan-cmp">${Object.entries(state.plans).map(([k, pl]) => {
    const pp = Portfolio.PROFILES[k], st = pl.stats;
    const [w, cls] = riskWord(st.pLoss);
    return `<button class="plan-card ${k === profileKey() ? 'on' : ''}" data-plan="${k}">
      <div class="pc-head"><span>${pp.icon} <b>Plan ${pp.label.toLowerCase()}</b></span><small>${pl.bets.length} apuesta${pl.bets.length === 1 ? '' : 's'}</small></div>
      <div class="pc-risk ${cls}">${fmtPct(st.pLoss, 0)} <small>riesgo de pérdidas · ${w.toLowerCase()}</small></div>
      <div class="pc-row"><span>Beneficio esperado</span><b class="${st.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(st.expected)}</b></div>
      <div class="pc-row"><span>Escenario bueno</span><b class="pos">${fmtEurSigned(st.p90)}</b></div>
      <div class="pc-row"><span>Escenario malo</span><b class="${st.p10 >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(st.p10)}</b></div>
      <div class="pc-row"><span>Ganancia máxima</span><b class="pos">${fmtEurSigned(st.best)}</b></div>
      <div class="pc-row"><span>Pérdida máxima</span><b class="neg">${fmtEurSigned(st.worst)}</b></div>
      <p class="pc-help">${esc(pp.help)}</p>
    </button>`;
  }).join('')}</div>`;

  if (!plan.bets.length) {
    const gap = onlyB365() ? b365Gap() : null;
    const extra = gap && gap.n
      ? `<br><br>He comparado <b>${gap.n} cuotas de bet365</b> con la cuota justa: la mejor está un <b>${fmtPct(gap.best)}</b> por encima (${esc(gap.txt)}), y el mínimo para considerarla error es un ${fmtPct(state.config.minEV, 0)}. bet365 cobra de margen un ${fmtPct(gap.margin)} de media en el 1X2.<br>Prueba con «🔎 Elegir las ligas más rentables», más tarde, o desmarca «Apostar solo en bet365» (💰).`
      : '<br>Prueba a recalcular dentro de un rato, elegir más competiciones o mirar otro plan.';
    body.innerHTML = cmp + `<div class="empty">${esc(plan.warnings[0] || 'Sin apuestas propuestas.')}${extra}</div>`;
    return;
  }

  // «Qué apostar»: una frase por apuesta, en el orden en que conviene hacerlas.
  const steps = plan.bets.map((b) => {
    const o = b.opp;
    if (b.kind === 'combinada') {
      const legs = b.legs.map((l) => `<li><b>${esc(l.home)} – ${esc(l.away)}</b> <span class="sub">(${esc(l.league)}, ${esc(l.live ? 'EN VIVO' : fmtTime.format(new Date(l.commence)))})</span>: ${esc(l.marketLabel)} → <b>${esc(l.selectionLabel)}</b> a <b>${fmtOdds(l.price)}</b> <span class="sub">· ${fmtPct(l.fairProb, 0)}</span></li>`).join('');
      return `<li>🎟️ <b>Combinada de ${b.legs.length}</b> en <b>${esc(b.legs[0].bookTitle)}</b>: apuesta <b class="pos">${fmtEur(b.stake)}</b> a cuota total <b>${fmtOdds(b.price)}</b>.
        <ul class="combo-legs">${legs}</ul>
        <div class="bet-nums"><span>Acierto <b>${fmtPct(b.winProb, 1)}</b></span><span>Si aciertas todas <b class="pos">${fmtEurSigned(b.profitIfWin)}</b></span><span>Si falla una <b class="neg">${fmtEurSigned(-b.stake)}</b></span><span>Valor esperado <b class="${b.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(b.expected)}</b></span><span>Riesgo <b class="neg">${fmtPct(1 - b.winProb, 0)} de perder</b></span></div></li>`;
    }
    const when = o.live ? 'EN VIVO' : fmtTime.format(new Date(o.commence));
    const match = `<b>${esc(o.home)} – ${esc(o.away)}</b> <span class="sub">(${o.sport === 'futbol' ? '⚽' : '🏐'} ${esc(o.league)}, ${esc(when)})</span>`;
    const news = newsBadge(o);
    if (b.kind === 'cobertura') {
      const legs = b.legs.map((l) => `<b>${fmtEur(l.stake)}</b> a «${esc(l.selectionLabel)}» en <b>${esc(l.bookTitle)}</b> a cuota <b>${fmtOdds(l.price)}</b>`).join(' + ');
      return `<li>${match}: surebet en ${esc(o.marketLabel)} → ${legs}. Cobras ${fmtEur(b.stake + b.guaranteed)} pase lo que pase (${fmtEurSigned(b.guaranteed)}).${news}</li>`;
    }
    return `<li>${match}: apuesta <b class="pos">${fmtEur(b.stake)}</b> a «<b>${esc(o.selectionLabel)}</b>» (${esc(o.marketLabel)}) en <b>${esc(o.bookTitle)}</b> a cuota <b>${fmtOdds(b.price)}</b>.
      ${b.opp.ev >= 0 ? `No la aceptes por debajo de <b>${fmtOdds(Portfolio.minOdds(b.winProb))}</b>.` : `<span class="lvl-media">EV ${fmtPct(b.opp.ev)}: paga algo menos de lo justo (${fmtOdds(Portfolio.minOdds(b.winProb))}).</span>`}
      <div class="bet-nums"><span>Acierto <b>${fmtPct(b.winProb, 0)}</b></span><span>Si gana <b class="pos">${fmtEurSigned(b.profitIfWin)}</b></span><span>Si pierde <b class="neg">${fmtEurSigned(-b.stake)}</b></span><span>Valor esperado <b class="${b.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(b.expected)}</b></span><span>Riesgo <b class="${b.winProb >= 0.6 ? 'pos' : b.winProb >= 0.4 ? 'lvl-media' : 'neg'}">${fmtPct(1 - b.winProb, 0)} de perder</b></span></div>${news}</li>`;
  }).join('');
  const summary = `<div class="box todo"><div class="row-between"><h3>${P.icon} Qué apostar con el plan ${P.label.toLowerCase()}</h3><button class="btn ghost" id="copyPlan">📋 Copiar</button></div><ol>${steps}</ol></div>`;

  const [rw, rcls] = riskWord(s.pLoss);
  const kpis = `<div class="plan-kpis">
    <div class="kpi"><span>A apostar</span><b>${fmtEur(plan.total)}</b><small>${fmtPct(plan.total / plan.budget, 0)} del presupuesto · ${fmtEur(plan.reserve)} en reserva</small></div>
    <div class="kpi"><span>Beneficio esperado</span><b class="${s.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(s.expected)}</b><small>${fmtPct(s.expectedPct, 2)} del presupuesto (media a largo plazo)</small></div>
    <div class="kpi"><span>Riesgo de pérdidas</span><b class="${rcls}">${fmtPct(s.pLoss, 1)}</b><small>Riesgo ${rw.toLowerCase()} · probabilidad de acabar perdiendo</small></div>
    <div class="kpi"><span>Beneficio posible</span><b class="pos">${fmtEurSigned(s.p90)}</b><small>en el 10 % de los mejores escenarios · máximo ${fmtEurSigned(s.best)}</small></div>
  </div>`;

  const riskBox = `<div class="box"><h3>Riesgo</h3>
    <div class="risk-big ${rcls}">${fmtPct(s.pLoss, 1)} <span style="font-size:15px;font-weight:600">${rw}</span></div>
    <div class="meter"><i style="left:${Math.min(100, s.pLoss * 100).toFixed(1)}%"></i></div>
    <div class="meter-labels"><span>0 %</span><span>50 %</span><span>100 %</span></div>
    <div class="scen" style="margin-top:14px">
      <span>Probabilidad de ganar dinero</span><b class="pos">${fmtPct(s.pProfit, 1)}</b>
      <span>Capital en riesgo (apuestas simples)</span><b>${fmtEur(s.atRisk)} · ${fmtPct(s.atRiskPct, 1)}</b>
      <span>Peor caso (fallan todas)</span><b class="neg">${fmtEurSigned(s.worst)}</b>
      <span>Probabilidad del peor caso</span><b>${s.pWorst < 0.0001 && s.pWorst > 0 ? '< 0,01 %' : fmtPct(s.pWorst, 2)}</b>
    </div></div>`;

  const scenBox = `<div class="box"><h3>Beneficios posibles (20.000 simulaciones)</h3>
    ${histogramSvg(s.hist)}
    <div class="scen" style="margin-top:12px">
      <span>Escenario malo (10 % peores)</span><b class="${s.p10 >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(s.p10)}</b>
      <span>Escenario típico (mediana)</span><b class="${s.p50 >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(s.p50)}</b>
      <span>Escenario bueno (10 % mejores)</span><b class="pos">${fmtEurSigned(s.p90)}</b>
      <span>Mejor caso (aciertan todas)</span><b class="pos">${fmtEurSigned(s.best)}</b>
    </div></div>`;

  const rows = plan.bets.map((b, i) => {
    const o = b.opp;
    if (b.kind === 'combinada') {
      const st = b.legs.map((l) => betStatus({ kind: 'simple', opp: l, price: l.price }));
      const status = st.includes('gone') ? 'gone' : st.includes('worse') ? 'worse' : 'ok';
      const statusTxt = status === 'gone' ? '<br><span class="neg">alguna selección ya no vale: no apostar</span>' : status === 'worse' ? '<br><span class="lvl-media">alguna cuota ha bajado</span>' : '';
      return `<tr class="${status === 'gone' ? 'gone' : ''}"><td data-l="#">${i + 1}</td><td data-l="Tipo" class="l"><span class="mini-tag" style="--c:var(--surebet)">Combinada</span></td>
        <td data-l="Partido" class="l">${b.legs.map((l) => `<b>${esc(l.home)} vs ${esc(l.away)}</b>`).join('<br>')}${statusTxt}</td>
        <td data-l="Apuesta" class="l">${b.legs.map((l) => `→ ${esc(l.selectionLabel)}`).join('<br>')}</td><td data-l="Casa" class="l">${esc(b.legs[0].bookTitle)}</td>
        <td data-l="Cuota">${b.legs.map((l) => fmtOdds(l.price)).join('<br>')}<br><b>= ${fmtOdds(b.price)}</b></td><td data-l="Cuota mínima">—</td>
        <td data-l="Importe"><span class="stake">${fmtEur(b.stake)}</span></td><td data-l="Prob. ganar">${fmtPct(b.winProb, 1)}</td>
        <td data-l="Si gana" class="pos">${fmtEurSigned(b.profitIfWin)}</td><td data-l="Benef. esperado" class="${b.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(b.expected)}</td></tr>`;
    }
    const t = TYPES[o.type];
    const st = betStatus(b);
    const when = o.live ? '<span class="livebadge">EN VIVO</span>' : esc(fmtTime.format(new Date(o.commence)));
    const statusTxt = st === 'gone' ? '<br><span class="neg">ya no tiene valor: no apostar</span>' : st === 'worse' ? '<br><span class="lvl-media">la cuota ha bajado (aún con valor)</span>' : '';
    const event = `<b>${esc(o.home)} vs ${esc(o.away)}</b><br><span class="sub">${o.sport === 'futbol' ? '⚽' : '🏐'} ${esc(o.league)} · ${when}</span>${statusTxt}`;
    if (b.kind === 'cobertura') {
      return `<tr class="${st === 'gone' ? 'gone' : ''}"><td data-l="#">${i + 1}</td><td data-l="Tipo" class="l"><span class="mini-tag" style="--c:${t.color}">${t.label}</span></td><td data-l="Partido" class="l">${event}</td>
        <td data-l="Apuesta" class="l">${esc(o.marketLabel)}<br>${b.legs.map((l) => `→ ${esc(l.selectionLabel)}`).join('<br>')}</td>
        <td data-l="Casa" class="l"><br>${b.legs.map((l) => esc(l.bookTitle)).join('<br>')}</td>
        <td data-l="Cuota"><br>${b.legs.map((l) => fmtOdds(l.price)).join('<br>')}</td><td data-l="Cuota mínima">—</td>
        <td data-l="Importe"><span class="stake">${fmtEur(b.stake)}</span><br>${b.legs.map((l) => fmtEur(l.stake)).join('<br>')}</td>
        <td data-l="Prob. ganar">100 %<br><span class="sub">cubre todo</span></td><td data-l="Si gana" class="pos">${fmtEurSigned(b.guaranteed)}</td><td data-l="Benef. esperado" class="pos">${fmtEurSigned(b.expected)}</td></tr>`;
    }
    return `<tr class="${st === 'gone' ? 'gone' : ''}"><td data-l="#">${i + 1}</td><td data-l="Tipo" class="l"><span class="mini-tag" style="--c:${t.color}">${t.label}</span></td><td data-l="Partido" class="l">${event}</td>
      <td data-l="Apuesta" class="l">${esc(o.marketLabel)}<br>→ <b>${esc(o.selectionLabel)}</b></td><td data-l="Casa" class="l">${esc(o.bookTitle)}</td><td data-l="Cuota">${fmtOdds(b.price)}</td><td data-l="Cuota mínima">${fmtOdds(Portfolio.minOdds(b.winProb))}</td>
      <td data-l="Importe"><span class="stake">${fmtEur(b.stake)}</span></td><td data-l="Prob. ganar">${fmtPct(b.winProb, 0)}</td><td data-l="Si gana" class="pos">${fmtEurSigned(b.profitIfWin)}</td><td data-l="Benef. esperado" class="${b.expected >= 0 ? 'pos' : 'neg'}">${fmtEurSigned(b.expected)}</td></tr>`;
  }).join('');

  const table = `<div class="box"><h3>Dónde y cuánto apostar (${plan.bets.length} apuestas)</h3><div class="tbl-wrap"><table class="plan-table">
    <tr><th>#</th><th>Tipo</th><th>Partido</th><th>Apuesta</th><th>Casa</th><th>Cuota</th><th>Cuota mínima</th><th>Importe</th><th>Prob. ganar</th><th>Si gana</th><th>Benef. esperado</th></tr>
    ${rows}</table></div>
    <p class="hint">Una sola apuesta por partido para que los resultados no dependan unos de otros. Importes en múltiplos de ${fmtEur(plan.step)} (mínimo ${fmtEur(plan.minStake)} por apuesta; comprueba el mínimo de cada casa). ${plan.full
      ? `Se reparte todo el presupuesto: ${chosenCoverText(plan, P)} y el resto entre las apuestas de valor según su ventaja (Kelly), sin que ninguna pase del ${fmtPct(P.maxShare, 0)} si hay suficientes.`
      : `Kelly fraccional (${P.kelly} Kelly, máx. ${fmtPct(P.maxBet, 0)} del presupuesto por apuesta).`} En las surebets reparte el importe entre las casas tal como se indica.</p>
    ${plan.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
    <p class="warn">Las cifras son estimaciones con las probabilidades justas del mercado. Las casas pueden anular apuestas, bajar cuotas o limitar tu cuenta; nunca apuestes dinero que no puedas permitirte perder.</p>
  </div>`;

  body.innerHTML = cmp + summary + kpis + `<div class="plan-grid">${riskBox}${scenBox}</div>` + table;
  $('#copyPlan').onclick = () => {
    const txt = `Plan ${P.label.toLowerCase()} · ${fmtEur(plan.budget)}\n` + [...body.querySelectorAll('.todo ol > li')].map((li, i) => `${i + 1}. ${li.innerText.replace(/\s+/g, ' ').trim()}`).join('\n');
    navigator.clipboard.writeText(txt).then(() => toast('Plan copiado'), () => toast('No se ha podido copiar'));
  };
}

// ---------- Ajustes ----------

function openSettings() {
  const f = $('#settingsForm');
  const c = state.config;
  for (const el of f.elements) {
    if (!el.name || el.name === 'apiKey') continue;
    el.value = el.dataset.pct !== undefined ? +(c[el.name] * 100).toFixed(2) : c[el.name];
  }
  f.apiKey.value = '';
  f.psKey.value = '';
  showKeyState();
  showPsState();
  f.dataset.mode = c.mode;
  markSeg('#modeSeg', c.mode);
  $('#settings').showModal();
}

// Estado de la clave guardada (se conserva en data/config.json aunque cierres la app o vuelvas a buscar).
function showKeyState(msg, cls) {
  const c = state.config;
  const el = $('#keyState');
  if (msg) { el.innerHTML = `<span class="${cls}">${esc(msg)}</span>`; return; }
  if (!c.hasKey) el.innerHTML = '<span class="lvl-media">Aún no hay ninguna clave guardada.</span>';
  else if (c.keyIssue) el.innerHTML = `<span class="neg">⚠️ La clave guardada (${esc(c.keyMasked)}) no es válida: ${esc(c.keyIssue)}</span>`;
  else el.innerHTML = `<span class="pos">✅ Clave guardada y comprobada (${esc(c.keyMasked)})${c.credits && c.credits.remaining !== null ? ` · ${c.credits.remaining} créditos` : ''}. Se conserva siempre; deja la casilla vacía para seguir usándola.</span>`;
}

function showPsState(msg, cls) {
  const c = state.config;
  const el = $('#psState');
  if (msg) { el.innerHTML = `<span class="${cls}">${esc(msg)}</span>`; return; }
  el.innerHTML = c.hasPsKey
    ? `<span class="pos">✅ Clave de PulseScore guardada y comprobada (${esc(c.psKeyMasked)}). Se conserva siempre; deja la casilla vacía para seguir usándola.</span>`
    : '<span class="lvl-media">Aún no hay clave de PulseScore: sin ella no hay cuotas de bet365.</span>';
}

// Mientras pegas la clave, cuenta los caracteres (deben ser 32).
function checkKeyInput() {
  const v = $('#settingsForm').apiKey.value.replace(/[\s"'`​-‍﻿]/g, '');
  if (!v) return showKeyState();
  if (!/^[0-9a-f]+$/i.test(v)) return showKeyState('Solo puede tener números y letras de la a a la f: parece que has copiado otro texto.', 'neg');
  if (v.length !== 32) return showKeyState(`${v.length} de 32 caracteres: ${v.length < 32 ? 'falta un trozo' : 'sobra algo'}.`, 'neg');
  showKeyState('32 caracteres: formato correcto. Pulsa «Guardar» y la comprobaré con The Odds API.', 'pos');
}

async function saveSettings(e) {
  e.preventDefault();
  const f = $('#settingsForm');
  const body = { mode: f.dataset.mode };
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.name === 'apiKey' || el.name === 'psKey') { if (el.value.trim()) body[el.name] = el.value.trim(); continue; }
    body[el.name] = el.dataset.pct !== undefined ? Number(el.value) / 100 : el.value;
  }
  if (body.mode === 'real' && !body.apiKey && (!state.config.hasKey || state.config.keyIssue)) {
    showKeyState('Para el modo real pega aquí tu clave de The Odds API (32 caracteres).', 'neg');
    f.apiKey.focus();
    return;
  }
  const modeChanged = body.mode !== state.config.mode;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  if (body.apiKey) showKeyState('Comprobando la clave con The Odds API…', 'sub');
  if (body.psKey) showPsState('Comprobando la clave con PulseScore…', 'sub');
  try {
    state.config = await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    // La clave anterior sigue guardada; se explica el problema junto a la casilla correspondiente.
    if (/PulseScore/.test(err.message)) { showPsState(err.message, 'neg'); f.psKey.focus(); }
    else { showKeyState(err.message, 'neg'); f.apiKey.focus(); }
    return;
  } finally {
    btn.disabled = false;
  }
  $('#settings').close();
  showErrors([]);
  applyMode();
  if (modeChanged || body.apiKey) await loadSports();
  if (!modeChanged && state.config.mode === 'real') {
    // En modo real no se vuelve a buscar solo (gastaría créditos): se mantiene lo que había.
    toast(body.psKey ? '✅ Clave de PulseScore correcta y guardada' : body.apiKey ? '✅ Clave correcta y guardada' : 'Ajustes guardados');
    updateEstimate();
    render();
    return;
  }
  state.scan = null;
  state.firstSeen.clear();
  state.seen.clear();
  toast(body.psKey ? '✅ Clave de PulseScore correcta y guardada' : body.apiKey ? '✅ Clave correcta y guardada' : 'Ajustes guardados');
  runScan();
}

function applyMode() {
  const real = state.config.mode === 'real';
  const pill = $('#modePill');
  pill.textContent = real ? 'REAL' : 'DEMO';
  pill.className = `pill ${real ? 'real' : 'demo'}`;
  $('#demoBanner').classList.toggle('hidden', real);
  updatePsPill(state.config.psUsage);
  if (real && state.config.keyIssue) showErrors([`La clave de The Odds API guardada no es válida: ${state.config.keyIssue} Ábrela en ⚙ Ajustes.`]);
  $('#credits').classList.toggle('hidden', !real || !$('#credits').textContent);
}

async function loadSports() {
  try {
    const data = await api('/api/sports');
    state.sports = data.sports;
    showErrors([]);
  } catch (e) {
    state.sports = [];
    showErrors([e.message]);
  }
}

function markSeg(sel, v) {
  for (const b of document.querySelectorAll(`${sel} button`)) b.classList.toggle('on', b.dataset.v === v);
}

// ---------- Eventos ----------

function bind() {
  $('#sportSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    state.prefs.sport = v; savePrefs(); markSeg('#sportSeg', v); render();
  });
  $('#timeSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    state.prefs.time = v; savePrefs(); markSeg('#timeSeg', v); render();
  });
  $('#modeSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    $('#settingsForm').dataset.mode = v; markSeg('#modeSeg', v);
  });
  $('#leagueList').addEventListener('change', (e) => {
    const keys = new Set(selectedKeys());
    if (e.target.checked) {
      if (state.config.mode === 'real' && keys.size >= MAX_LEAGUES) { e.target.checked = false; toast(`Máximo ${MAX_LEAGUES} competiciones en modo real.`); return; }
      keys.add(e.target.value);
    } else keys.delete(e.target.value);
    setSelected([...keys]);
    afterSelectionChange();
  });
  $('#leagueSearch').addEventListener('input', renderLeagues);
  $('#selAll').addEventListener('click', () => {
    const vis = state.sports.filter((s) => state.prefs.sport === 'all' || s.sport === state.prefs.sport).map((s) => s.key);
    if (state.config.mode === 'real' && vis.length > MAX_LEAGUES) { toast(`En modo real elige como máximo ${MAX_LEAGUES} (gastan créditos).`); setSelected(vis.slice(0, MAX_LEAGUES)); }
    else setSelected(vis);
    afterSelectionChange();
  });
  $('#selNone').addEventListener('click', () => { setSelected([]); afterSelectionChange(); });
  $('#scoutBtn').addEventListener('click', scoutFlow);
  $('#todayToggle').addEventListener('change', (e) => {
    state.prefs.todayOnly = e.target.checked; savePrefs();
    if (state.plans) buildPlan();
    state.ticket = null; renderTicket();
    for (const b of document.querySelectorAll('#ticketBtns button')) b.classList.remove('on');
    render();
    toast(e.target.checked ? 'Solo partidos de hoy' : 'Partidos de todos los días');
  });
  $('#ticketBtns').addEventListener('click', (e) => { const l = e.target.closest('button')?.dataset.level; if (l) makeTicket(l); });
  $('#typeChips').addEventListener('click', (e) => {
    const t = e.target.closest('.chip')?.dataset.t; if (!t) return;
    const set = new Set(state.prefs.types);
    set.has(t) ? set.delete(t) : set.add(t);
    state.prefs.types = [...set]; savePrefs(); render();
  });
  $('#bookFilter').addEventListener('change', (e) => { state.prefs.book = e.target.value; savePrefs(); render(); });
  $('#evMin').addEventListener('input', (e) => { state.prefs.evMin = Number(e.target.value); $('#evVal').textContent = `${e.target.value} %`; savePrefs(); render(); });
  $('#soundToggle').addEventListener('change', (e) => { state.prefs.sound = e.target.checked; savePrefs(); if (e.target.checked) beep(); });
  $('#search').addEventListener('input', render);
  $('#sortSel').addEventListener('change', (e) => { state.prefs.sort = e.target.value; savePrefs(); render(); });
  $('#refreshBtn').addEventListener('click', () => manualScan());
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#filtersBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#settingsForm').apiKey.addEventListener('input', checkKeyInput);
  $('#tabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) setTab(t); });
  $('#budgetBtn').addEventListener('click', openBudget);
  $('#planEdit').addEventListener('click', openBudget);
  // Recalcular = buscar cuotas nuevas y rehacer el plan; mientras no se pulse, el plan no cambia.
  $('#planRecalc').addEventListener('click', async () => {
    $('#planRecalc').disabled = true;
    const done = await manualScan();
    $('#planRecalc').disabled = false;
    if (!done) return;
    buildPlan();
    render();
    toast('Plan recalculado con cuotas recién buscadas');
  });
  $('#autoToggle').addEventListener('change', (e) => {
    state.prefs.auto = e.target.checked; savePrefs(); scheduleNext();
    toast(e.target.checked ? `Se buscará solo cada ${refreshSec()} s` : 'Búsqueda fija: solo se actualiza cuando pulses buscar o recalcular');
  });
  $('#budgetForm').addEventListener('submit', saveBudget);
  $('#budgetQuick').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) $('#budgetForm').budget.value = v; });
  $('#planBody').addEventListener('click', (e) => {
    const k = e.target.closest('.plan-card')?.dataset.plan; if (k) selectPlan(k);
  });
  $('#list').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { addLeg(add.dataset.add); $('.ticket-box').scrollIntoView({ behavior: 'smooth' }); return; }
    const c = e.target.closest('.card'); if (c) openDetail(c.dataset.ev, c.dataset.id);
  });
  for (const id of ['#tcLegs', '#tcMinP']) $(id).addEventListener('input', updateCustomRisk);
  $('#tcFams').addEventListener('change', updateCustomRisk);
  $('#tcBuild').addEventListener('click', buildCustomTicket);
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  }
}

// Recarga automática si cambian los archivos de la interfaz.
let version = null;
setInterval(async () => {
  try {
    const { v } = await api('/api/version');
    if (version && v !== version) location.reload();
    version = v;
  } catch {}
}, 3000);

async function init() {
  bind();
  markSeg('#sportSeg', state.prefs.sport);
  markSeg('#timeSeg', state.prefs.time);
  $('#evMin').value = state.prefs.evMin;
  $('#evVal').textContent = `${state.prefs.evMin} %`;
  $('#soundToggle').checked = state.prefs.sound;
  $('#autoToggle').checked = state.prefs.auto;
  $('#todayToggle').checked = todayOnly();
  $('#sortSel').value = state.prefs.sort;
  state.config = await api('/api/config');
  applyMode();
  updateBudgetLabel();
  renderTicket();
  await loadSports();
  setTab(state.prefs.tab);
  // En modo real, al abrir la app solo se analiza lo que ya está en caché (gratis); si no, espera a que pulses buscar.
  await updateEstimate();
  if (state.config.mode !== 'real' || state.estimate === 0) await runScan();
  else { setLive('err', 'pulsa buscar'); render(); }
  // La primera vez, la app pregunta el presupuesto.
  if (!state.prefs.budget) openBudget();
}

init();
