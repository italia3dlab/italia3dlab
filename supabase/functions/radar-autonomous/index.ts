const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SEARCH = 'https://makerworld.com/api/v1/search-service/select/design2';
const DETAIL = 'https://api.bambulab.com/v1/design-service/design/';
const SORTS = ['score', 'likeCount', 'downloadCount'];

const TARGETS = [
  {
    category: 'Personaggi', target: 4,
    queries: ['bust', 'figurine', 'character statue', 'anime figure'],
    must: /bust|figurine|figure|statue|sculpt|character|anime|chibi|creature|monster|hero|dragon|dinosaur/i,
    exclude: /keychain|key ring|keyring|bookmark|organizer|holder|lamp|lightbox|decor set|wall decor/i,
  },
  {
    category: 'Portachiavi', target: 3,
    queries: ['keychain', 'key ring'],
    must: /keychain|keyring|key ring|key fob|keytag/i,
    exclude: /gun|weapon/i,
  },
  {
    category: 'Lampade', target: 3,
    queries: ['lamp', 'lightbox', 'night light'],
    must: /lamp|lightbox|light box|night light|lantern|led light/i,
    exclude: /keychain/i,
  },
  {
    category: 'Accessori per la casa', target: 3,
    queries: ['home decor', 'wall decor', 'vase', 'kitchen organizer'],
    must: /home|decor|organizer|holder|storage|vase|planter|basket|coaster|kitchen|bathroom|tray|rack|wall/i,
    exclude: /desk|desktop|office|phone|cable|pencil|pen holder|keychain|headphone|monitor/i,
  },
  {
    category: 'Scrivania', target: 3,
    queries: ['desk organizer', 'phone stand', 'cable organizer'],
    must: /desk|desktop|office|pen|pencil|phone stand|cable|headphone|monitor|stationery/i,
    exclude: /keychain/i,
  },
  {
    category: 'Varie', target: 3,
    queries: ['fidget', 'useful gadget', 'travel gadget', 'bookmark'],
    must: /fidget|gadget|tool|travel|clip|hook|bookmark|toy|puzzle|game|utility|mount|adapter|case|stand|holder/i,
    exclude: /keychain|lightbox|lamp|desk organizer|phone stand/i,
  },
];

const BLOCKED = /\b(gun|firearm|pistol|rifle|shotgun|grenade|ammo|ammunition|switchblade|dagger)\b/i;
const IP_RISK = /\b(marvel|disney|pokemon|pokémon|nintendo|star wars|spider[- ]?man|batman|superman|dragon ball|one piece|minecraft|fortnite|ferrari|mercedes|audi|nike|adidas|f1|formula 1)\b/i;

type Hit = Record<string, any>;
type Candidate = { hit: Hit; category: string; baseScore: number; sourceRanks: Record<string, number>; newestRank: number; hotRank: number; old: boolean };

function clamp(n: number, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function rankScore(rank: number | undefined, step = 2.2) { return rank == null ? 35 : clamp(100 - rank * step); }
function textOf(hit: Hit) { return `${hit.title || ''} ${(hit.tags || []).join(' ')}`; }
function fmt(n: number) { if (!Number.isFinite(n)) return '0'; if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`; return String(Math.round(n)); }

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

async function sb(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers || {});
  h.set('apikey', SB_KEY);
  h.set('authorization', `Bearer ${SB_KEY}`);
  if (init.body) h.set('content-type', 'application/json');
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: h });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function mwSearch(keyword: string, orderBy: string) {
  const u = new URL(SEARCH);
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('orderBy', orderBy);
  u.searchParams.set('designType', '0');
  u.searchParams.set('isFromSearchList', 'false');
  u.searchParams.set('offset', '0');
  u.searchParams.set('limit', '40');
  const payload = await fetchJson(u.toString(), {
    referer: `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(keyword)}`,
    origin: 'https://makerworld.com',
    'user-agent': 'Mozilla/5.0',
    accept: 'application/json',
  });
  if (!Array.isArray(payload?.hits)) throw new Error(`MakerWorld risposta inattesa per ${keyword}/${orderBy}`);
  return payload.hits as Hit[];
}

async function existingUrls() {
  const rows = await sb('trending_models?select=makerworld_url,checked_at&order=checked_at.desc&limit=200').catch(() => []);
  return new Set<string>((rows || []).map((r: any) => r.makerworld_url));
}

async function upcomingEvents() {
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 86400000);
  const a = now.toISOString().slice(0, 10);
  const b = end.toISOString().slice(0, 10);
  return await sb(`market_events?select=title,event_date,priority&event_date=gte.${a}&event_date=lte.${b}&order=priority.desc&limit=40`).catch(() => []);
}

function words(s: string) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'new', 'film', 'movie', 'game', 'season', 'part', 'edition', 'model', 'print', '2026']);
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !stop.has(w));
}

function matchEvent(title: string, events: any[]) {
  const tw = new Set(words(title));
  let best = null, score = 0;
  for (const e of events) {
    const n = words(e.title || '').filter(w => tw.has(w)).length;
    if (n > score) { score = n; best = e; }
  }
  return score > 0 ? best : null;
}

function computePool(category: string, cfg: any, groups: { order: string, hits: Hit[] }[], oldUrls: Set<string>) {
  const map = new Map<number, { hit: Hit, ranks: Record<string, number> }>();
  for (const g of groups) {
    g.hits.forEach((hit, idx) => {
      if (!hit?.id || hit.nsfw || hit.is_printable === false) return;
      const t = textOf(hit);
      if (BLOCKED.test(t) || !cfg.must.test(t) || cfg.exclude?.test(t)) return;
      const cur = map.get(hit.id) || { hit, ranks: {} };
      cur.hit = hit;
      cur.ranks[g.order] = Math.min(cur.ranks[g.order] ?? 999, idx);
      map.set(hit.id, cur);
    });
  }
  const items = [...map.values()];
  const newest = [...items].sort((a, b) => Date.parse(b.hit.createTime || '1970-01-01') - Date.parse(a.hit.createTime || '1970-01-01'));
  const hot = [...items].sort((a, b) => Number(b.hit.hotScore || 0) - Number(a.hit.hotScore || 0));
  const newRank = new Map(newest.map((x, i) => [x.hit.id, i]));
  const hotRank = new Map(hot.map((x, i) => [x.hit.id, i]));
  return items.map(x => {
    const nr = newRank.get(x.hit.id) ?? 99;
    const hr = hotRank.get(x.hit.id) ?? 99;
    let base = 0.27 * rankScore(x.ranks.score) + 0.22 * rankScore(x.ranks.likeCount) + 0.22 * rankScore(x.ranks.downloadCount) + 0.14 * rankScore(nr, 1.8) + 0.15 * rankScore(hr, 1.8);
    const url = `https://makerworld.com/en/models/${x.hit.id}${x.hit.slug ? '-' + x.hit.slug : ''}`;
    const old = oldUrls.has(url);
    base += old ? -5 : 5;
    if (x.hit.isStaffPicked) base += 3;
    return { hit: x.hit, category, baseScore: clamp(base), sourceRanks: x.ranks, newestRank: nr, hotRank: hr, old } as Candidate;
  }).sort((a, b) => b.baseScore - a.baseScore);
}

function deepHasA1_04(x: any): boolean {
  if (!x || typeof x !== 'object') return false;
  if (x.devProductName === 'A1' && Math.abs(Number(x.nozzleDiameter) - 0.4) < 0.001) return true;
  if (Array.isArray(x)) return x.some(deepHasA1_04);
  return Object.values(x).some(deepHasA1_04);
}

function a1Profile(detail: any) {
  const instances = Array.isArray(detail?.instances) ? detail.instances : [];
  for (const inst of instances) {
    if (!deepHasA1_04(inst)) continue;
    const plates = inst?.extention?.modelInfo?.plates || [];
    const sec = plates.reduce((s: number, p: any) => s + Number(p?.prediction || 0), 0);
    const weight = Number(inst?.weight || plates.reduce((s: number, p: any) => s + Number(p?.weight || 0), 0)) || null;
    return { weight, hours: sec > 0 ? sec / 3600 : null, title: inst.title || '' };
  }
  return null;
}

function licenseInfo(hit: Hit, detail: any) {
  const lic = String(detail?.license || hit.license || 'Da verificare');
  const lower = lic.toLowerCase();
  const summary = String(detail?.summary || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  const commercialMention = /commercial licen[cs]e|sell (physical )?prints|right to sell/.test(summary);
  if (/public domain|cc0/.test(lower)) return { status: `${lic}: uso commerciale consentito`, score: 100, action: 'VENDIBILE' };
  if (/noncommercial|by-nc|\bnc\b/.test(lower)) return { status: `${lic}: uso commerciale vietato`, score: 5, action: 'ISPIRAZIONE / NON VENDERE' };
  if (/by-sa|cc by-sa/.test(lower)) return { status: `${lic}: uso commerciale consentito con attribuzione e ShareAlike`, score: 88, action: 'VENDIBILE CON ATTRIBUZIONE' };
  if (/by-nd|cc by-nd/.test(lower)) return { status: `${lic}: uso commerciale consentito solo senza modifiche, con attribuzione`, score: 78, action: 'VENDIBILE CON CONDIZIONI' };
  if (/^by$|cc by|creative commons attribution/.test(lower)) return { status: `${lic}: uso commerciale consentito con attribuzione`, score: 90, action: 'VENDIBILE CON ATTRIBUZIONE' };
  if (/standard digital file license/.test(lower)) {
    if (commercialMention) return { status: 'Standard Digital File License: vendita vietata senza licenza separata; il creator segnala una licenza commerciale', score: 60, action: 'POTENZIALE / LICENZA COMMERCIALE' };
    return { status: 'Standard Digital File License: vendita delle stampe vietata senza permesso/licenza commerciale', score: 5, action: 'ISPIRAZIONE / NON VENDERE' };
  }
  if (/exclusive/.test(lower)) {
    if (commercialMention) return { status: `${lic}: il creator segnala una possibile licenza commerciale; verificare termini`, score: 60, action: 'POTENZIALE / LICENZA COMMERCIALE' };
    return { status: `${lic}: vendita commerciale non confermata; verificare i diritti del creator`, score: 35, action: 'VERIFICA LICENZA COMMERCIALE' };
  }
  return { status: `${lic}: verificare prima di vendere`, score: 40, action: 'VERIFICA LICENZA' };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function enrich(c: Candidate, events: any[]) {
  let detail: any;
  try { detail = await fetchJson(`${DETAIL}${c.hit.id}`, { 'user-agent': 'Bambu Handy/3', accept: 'application/json' }); }
  catch { return null; }
  const profile = a1Profile(detail);
  if (!profile) return null;
  if ((profile.weight && profile.weight > 1200) || (profile.hours && profile.hours > 40)) return null;
  const lic = licenseInfo(c.hit, detail);
  const event = matchEvent(c.hit.title || '', events);
  const ageDays = Math.max(0, (Date.now() - Date.parse(c.hit.createTime || '1970-01-01')) / 86400000);
  let trend = 55 + c.baseScore * 0.4 + (event ? Math.min(8, Number(event.priority || 5)) : 0) + (ageDays <= 14 ? 3 : 0);
  trend = clamp(trend);
  const easy = (!profile.weight || profile.weight <= 350) && (!profile.hours || profile.hours <= 12);
  const tags: string[] = [];
  if (trend >= 86) tags.push('🔥 Trend forte');
  if (easy && c.category !== 'Personaggi') tags.push('💰 Facile da vendere');
  if (c.category === 'Personaggi') tags.push('🎨 Bello da pitturare');
  if (IP_RISK.test(textOf(c.hit))) tags.push('⚠️ Verifica IP');
  const personalization = /custom|personal|name|parametric|modular|interchangeable|initial/i.test(textOf(c.hit)) ? 90 : 60;
  const printScore = easy ? 90 : ((!profile.hours || profile.hours <= 20) ? 75 : 58);
  const marginScore = easy ? 85 : 65;
  const seasonalScore = event ? clamp(55 + Number(event.priority || 5) * 5) : (ageDays <= 30 ? 75 : 60);
  let action = lic.action;
  if (IP_RISK.test(textOf(c.hit)) && !action.includes('NON VENDERE')) action = 'VERIFICA IP + LICENZA';
  let why = `MakerWorld: ${fmt(Number(c.hit.likeCount || 0))} like, ${fmt(Number(c.hit.downloadCount || 0))} download e ${fmt(Number(c.hit.printCount || 0))} stampe; profilo A1 0,4 mm rilevato.`;
  if (ageDays <= 14) why = `Modello recente (${Math.round(ageDays)} giorni) con ${fmt(Number(c.hit.likeCount || 0))} like e ${fmt(Number(c.hit.downloadCount || 0))} download: buona finestra per testarlo presto.`;
  if (event) why = `Collegato all'evento “${event.title}” del ${event.event_date}; dati MakerWorld attuali: ${fmt(Number(c.hit.likeCount || 0))} like e ${fmt(Number(c.hit.downloadCount || 0))} download.`;
  return {
    title: c.hit.title,
    category: c.category,
    makerworld_url: `https://makerworld.com/en/models/${c.hit.id}${c.hit.slug ? '-' + c.hit.slug : ''}`,
    image_url: c.hit.cover || null,
    trend_score: Math.round(trend),
    license_status: lic.status,
    estimated_filament_g: profile.weight ? Math.round(profile.weight) : null,
    estimated_print_hours: profile.hours ? Math.round(profile.hours * 10) / 10 : null,
    suggested_price_eur: null,
    notes: tags.slice(0, 3).join(' · ') || 'A1 0,4 mm',
    makerworld_score: Math.round(c.baseScore),
    seasonal_score: Math.round(seasonalScore),
    margin_score: marginScore,
    print_score: printScore,
    personalization_score: personalization,
    license_score: lic.score,
    radar_action: action,
    why_today: why,
    last_seen_at: new Date().toISOString(),
  };
}

async function buildRadar() {
  const [oldUrls, events] = await Promise.all([existingUrls(), upcomingEvents()]);
  const pools: Record<string, Candidate[]> = {};
  for (const cfg of TARGETS) {
    const jobs = cfg.queries.flatMap(q => SORTS.map(order => ({ q, order })));
    const results = await Promise.all(jobs.map(async j => ({ order: j.order, hits: await mwSearch(j.q, j.order).catch(() => []) })));
    pools[cfg.category] = computePool(cfg.category, cfg, results, oldUrls).slice(0, cfg.target + 12);
  }
  const allCandidates = TARGETS.flatMap(cfg => pools[cfg.category]);
  const dedup = new Map<number, Candidate>();
  for (const c of allCandidates) {
    const old = dedup.get(c.hit.id);
    if (!old || c.baseScore > old.baseScore) dedup.set(c.hit.id, c);
  }
  const dedupValues = [...dedup.values()];
  const enrichedList = await mapLimit(dedupValues, 8, c => enrich(c, events));
  const enrichedById = new Map<number, any>();
  dedupValues.forEach((c, i) => { if (enrichedList[i]) enrichedById.set(c.hit.id, enrichedList[i]); });

  const selected: any[] = [];
  const used = new Set<number>();
  for (const cfg of TARGETS) {
    let n = 0;
    for (const c of pools[cfg.category]) {
      if (n >= cfg.target) break;
      if (used.has(c.hit.id)) continue;
      const e = enrichedById.get(c.hit.id);
      if (!e) continue;
      used.add(c.hit.id);
      selected.push(e);
      n++;
    }
  }
  return selected;
}

async function replaceRadar(rows: any[]) {
  if (rows.length < 12) throw new Error(`Solo ${rows.length} modelli A1 validi: mantengo il Radar precedente`);
  const checked = new Date().toISOString();
  const payload = rows.map(r => ({ ...r, checked_at: checked, last_seen_at: checked }));
  await sb('trending_models', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
  await sb(`trending_models?checked_at=lt.${encodeURIComponent(checked)}`, { method: 'DELETE' });
  return { checked_at: checked, count: rows.length };
}

function romeParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, hour: Number(v.hour) };
}

Deno.serve(async (req) => {
  const started = Date.now();
  try {
    if (req.method === 'GET') return Response.json({ ok: true, service: 'radar-autonomous', mode: 'health' });
    if (req.method !== 'POST') return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 });

    const rp = romeParts();
    if (rp.hour !== 8) return Response.json({ ok: true, skipped: true, reason: 'Fuori dalla finestra delle 08:00 Europe/Rome', rome: rp });

    const latest = await sb('trending_models?select=checked_at&order=checked_at.desc&limit=1').catch(() => []);
    if (latest?.[0]?.checked_at) {
      const lastDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(latest[0].checked_at));
      if (lastDate === rp.date) return Response.json({ ok: true, skipped: true, reason: 'Radar già aggiornato oggi', date: rp.date });
    }

    const rows = await buildRadar();
    const write = await replaceRadar(rows);
    return Response.json({ ok: true, mode: 'scheduled', ms: Date.now() - started, ...write, categories: Object.fromEntries(TARGETS.map(t => [t.category, rows.filter(r => r.category === t.category).length])) });
  } catch (e) {
    console.error('radar-autonomous', e);
    return Response.json({ ok: false, error: String(e), ms: Date.now() - started }, { status: 500 });
  }
});