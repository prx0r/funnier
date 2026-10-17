// Feeds: explicit, interpretable screening modes (X-algorithm-style architecture, no opaque model):
//   candidate retrieval (the scoped, servable, unseen pool) -> hard filters (openPair: two comics, no finished clip,
//   no vertical on desktop, duration fairness) -> independent scorers (named, additive, logged) -> diversity (one clip per
//   comic per round, session author penalty already in rotMult).
// Pure module, shared by the client (src/app.js), the tally (tally/feeds.mjs) and the tests. No DOM, no network.
//
//   trending  clips gaining crowd votes, win rate and completion over the last 24-72 h (time-decayed; tally writes
//             data/trending.json). Sparse data: bootstrap from funnygraph's spotlight + house board + the crowd BT.
//   foryou    the personal humour engine (src/app.js pickForYou / Training / Explore mix, unchanged).
//   underdog  a lesser-known comic (indie tier, low funnygraph popularity) against a big comic on a similar topic or vibe
//             (struct_sim + shared style/theory tags + funnygraph neighbors). The tier gap is a hard rule.
//   vibes     pairs from the vibe/neighbour space (funnygraph neighbors.json, then struct_sim).
//   cat:<slug> a category: a saved prompt's filters (region, tier, recency, format/setting, style tags, keywords),
//             scored like Trending inside the category pool.

export const FEEDS = [
  { k: 'trending', label: 'Trending' },
  { k: 'foryou', label: 'For You' },
  { k: 'underdog', label: 'Underdog' },
  { k: 'vibes', label: 'Similar Vibes' },
]
export const FEED_KEYS = FEEDS.map((f) => f.k)
export const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
export const isFeed = (k) => FEED_KEYS.includes(k) || (typeof k === 'string' && k.startsWith('cat:') && SLUG.test(k.slice(4)))
export const UNDERDOG_GAP = 0.3 // fame(big) - fame(small) must be at least this (hard rule)
export const MIN_CAT_CLIPS = 6, WARN_CAT_CLIPS = 20

// ---------- comic facts: region, tier, fame ----------
// people = funnygraph boards.json people {id: {n, t, r, c, h, house, pop, nb}}; comics = comics.json comics {name: {fgId, region, tier}}
export function comicFacts(clip, comics = {}, people = {}) {
  const P = comics[clip.comic] || {}
  const id = clip.fg || P.fgId || P.slug || null
  const g = (id && people[id]) || null
  return { id, region: clip.region || P.region || g?.r || null, continent: P.continent || g?.c || null, tier: P.tier || g?.t || null, g }
}
// fame 0..1 from funnygraph metrics only (tier, popularity lens, house rank, headline). Interpretable, monotone.
export function fame(f) {
  const g = f?.g, pop = Number.isFinite(g?.pop) ? g.pop / 100 : null, house = Number.isFinite(g?.house) ? g.house : null
  const h = Number.isFinite(g?.h) ? g.h / 100 : null
  if (f?.tier === 'king') return Math.min(1, 0.45 + 0.35 * (pop ?? h ?? 0.4) + (house != null ? 0.2 * Math.max(0, 1 - house / 300) : 0))
  if (f?.tier === 'indie') return Math.min(0.4, 0.05 + 0.3 * (pop ?? 0))
  return 0.3 + 0.2 * (pop ?? h ?? 0)
}

// ---------- region scope ----------
export const GLOBAL = 'global'
export const scopeOK = (scope, facts) => !scope || scope === GLOBAL || facts.region === scope
export const cleanScope = (s) => (s === GLOBAL || (typeof s === 'string' && /^[a-z][a-z-]{1,24}$/.test(s)) ? s : null)

// ---------- prompt -> filters (no LLM: a vocabulary of named synonyms; what it matched is shown as chips) ----------
const REGION_SYN = {
  uk: ['uk', 'british', 'britain', 'brit', 'brits', 'english', 'england', 'scottish', 'scotland', 'welsh', 'wales', 'london', 'northern'],
  ireland: ['irish', 'ireland', 'dublin'], us: ['us', 'usa', 'american', 'america', 'states'], canada: ['canadian', 'canada'],
  australia: ['australian', 'aussie', 'australia'], 'new-zealand': ['kiwi', 'nz', 'zealand'], india: ['indian', 'india'],
  nigeria: ['nigerian', 'nigeria'], 'south-africa': ['south-african', 'africa'], germany: ['german', 'germany'], france: ['french', 'france'],
  spain: ['spanish', 'spain'], mexico: ['mexican', 'mexico'], brazil: ['brazilian', 'brazil'], argentina: ['argentine', 'argentinian', 'argentina'],
  china: ['chinese', 'china'], japan: ['japanese', 'japan'], malaysia: ['malaysian', 'malaysia'], lebanon: ['lebanese', 'lebanon'],
  netherlands: ['dutch', 'netherlands'], colombia: ['colombian', 'colombia'],
}
const INTL = ['international', 'intl', 'world', 'worldwide', 'global', 'foreign', 'non-us']
const TIER_SYN = { indie: ['indie', 'indies', 'underground', 'unknown', 'small', 'underdog', 'underdogs', 'emerging', 'rising', 'upcoming', 'newcomer', 'newcomers', 'local'], king: ['legend', 'legends', 'king', 'kings', 'big', 'famous', 'icon', 'icons', 'goat', 'goats', 'greats', 'headliner', 'headliners', 'stars'] }
const STYLE_SYN = {
  dark: ['dark', 'edgy', 'offensive', 'grim', 'morbid', 'savage'], 'one-liners': ['one-liner', 'one-liners', 'oneliner', 'oneliners', 'liners', 'puns', 'wordplay', 'quickfire'],
  'crowd-work': ['crowd', 'crowdwork', 'crowd-work', 'hecklers', 'heckler', 'audience', 'roasting'], observational: ['observational', 'everyday', 'observation'],
  storytelling: ['story', 'stories', 'storytelling', 'storyteller', 'anecdotes'], 'self-deprecating': ['self-deprecating', 'self-roast', 'selfdeprecating', 'awkward'],
  rant: ['rant', 'rants', 'angry', 'ranting', 'political', 'politics'], clean: ['clean', 'family', 'wholesome'], absurd: ['absurd', 'surreal', 'weird', 'silly', 'bizarre'],
  deadpan: ['deadpan', 'dry', 'monotone'],
}
const STOP = new Set('a an the and or of in on for to with from by about some any me my i we our give show find only just more most best top good great funny funniest clips clip comedy comedian comedians comic comics jokes joke stuff feed feeds stand standup stand-up up sets set bits bit videos video like vs than that this who are is be people guys'.split(' '))
const SETTING_SYN = { 'talk-show': ['talk-show', 'talkshow', 'late-night', 'latenight', 'tonight', 'chat'], special: ['special', 'specials', 'netflix'] }
const LEN = { short: ['short', 'sharp', 'quick', 'snappy', 'bite-size', 'bitesize'], long: ['long', 'long-form', 'longform', 'extended'] }
const FORMAT_SYN = { vertical: ['vertical', 'shorts', 'tiktok', 'reels'], horizontal: ['horizontal', 'widescreen', 'landscape'] }

// text -> { filter, chips: [{k, v, from}] , unknown: [] }. Unmatched words become title keywords.
export function parsePrompt(text, { now = new Date(), regions = null } = {}) {
  const raw = String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/late night/g, 'late-night').replace(/talk show/g, 'talk-show').replace(/crowd work/g, 'crowd-work').replace(/one liners?/g, 'one-liners').replace(/self deprecating/g, 'self-deprecating').replace(/stand up/g, 'standup').replace(/south african?/g, 'south-african').replace(/new zealand/g, 'new-zealand')
  const words = raw.split(/[^a-z0-9-]+/).filter(Boolean)
  const f = {}, chips = [], add = (k, v, from) => { if (k === 'kw') { (f.kw = f.kw || []).includes(v) || f.kw.push(v) } else if (Array.isArray(f[k])) { if (!f[k].includes(v)) f[k].push(v) } else f[k] = v; chips.push({ k, v, from }) }
  const year = now.getFullYear()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const reg = Object.entries(REGION_SYN).find(([, s]) => s.includes(w))
    if (reg && (!regions || regions.includes(reg[0]))) { f.regions = f.regions || []; add('regions', reg[0], w); continue }
    if (INTL.includes(w)) { add('intl', true, w); continue }
    const tier = Object.entries(TIER_SYN).find(([, s]) => s.includes(w)); if (tier) { add('tier', tier[0], w); continue }
    if (w === 'new' || w === 'fresh' || w === 'young') { if (!f.tier) add('tier', 'indie', w); continue }
    if (['recent', 'latest', 'newest', 'today', 'this-year'].includes(w)) { add('minYear', year - 2, w); continue }
    if (['classic', 'old', 'vintage', 'retro', 'oldschool'].includes(w)) { add('maxYear', 2009, w); continue }
    const dec = w.match(/^(?:19)?([5-9]0)s$|^(20[0-2]0)s$/); if (dec) { const y = dec[1] ? 1900 + +dec[1] : +dec[2]; add('minYear', y, w); add('maxYear', y + 9, w); continue }
    if (/^(19|20)\d\d$/.test(w)) { add('minYear', +w, w); add('maxYear', +w, w); continue }
    const st = Object.entries(STYLE_SYN).find(([, s]) => s.includes(w)); if (st) { f.styles = f.styles || []; add('styles', st[0], w); continue }
    const se = Object.entries(SETTING_SYN).find(([, s]) => s.includes(w)); if (se) { add('setting', se[0], w); continue }
    const fm = Object.entries(FORMAT_SYN).find(([, s]) => s.includes(w)); if (fm) { add('format', fm[0], w); continue }
    if (LEN.short.includes(w)) { add('maxSec', 120, w); continue }
    if (LEN.long.includes(w)) { add('minSec', 300, w); continue }
    if (w.length >= 3 && !STOP.has(w)) add('kw', w, w)
  }
  return { filter: f, chips }
}
export const chipLabel = (c, regionLabel = {}) => ({
  regions: () => regionLabel[c.v] || c.v.toUpperCase(), intl: () => 'Outside the US', tier: () => (c.v === 'indie' ? 'Indie / lesser-known' : 'Big names'),
  minYear: () => 'From ' + c.v, maxYear: () => 'Up to ' + c.v, styles: () => c.v.replace(/-/g, ' '), setting: () => (c.v === 'talk-show' ? 'Talk shows' : 'Specials'),
  format: () => (c.v === 'vertical' ? 'Vertical shorts' : 'Widescreen'), maxSec: () => 'Under 2 min', minSec: () => '5 min +', kw: () => '“' + c.v + '”',
}[c.k] || (() => String(c.v)))()

// sanitise a filter (client, Worker and tally share this)
export function cleanFilter(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = {}, str = (s, n = 24) => typeof s === 'string' && /^[a-z0-9-]{1,24}$/.test(s) ? s.slice(0, n) : null
  if (Array.isArray(x.regions)) { const a = x.regions.map((s) => str(s)).filter(Boolean).slice(0, 8); if (a.length) o.regions = a }
  if (x.intl === true) o.intl = true
  if (x.tier === 'indie' || x.tier === 'king') o.tier = x.tier
  for (const k of ['minYear', 'maxYear']) { const n = Number(x[k]); if (Number.isInteger(n) && n >= 1950 && n <= 2100) o[k] = n }
  for (const k of ['minSec', 'maxSec']) { const n = Number(x[k]); if (Number.isFinite(n) && n >= 10 && n <= 3600) o[k] = Math.round(n) }
  if (Array.isArray(x.styles)) { const a = x.styles.map((s) => str(s)).filter((s) => s && STYLE_SYN[s]).slice(0, 6); if (a.length) o.styles = a }
  if (x.setting === 'talk-show' || x.setting === 'special') o.setting = x.setting
  if (x.format === 'vertical' || x.format === 'horizontal') o.format = x.format
  if (Array.isArray(x.kw)) { const a = x.kw.map((s) => str(s)).filter(Boolean).slice(0, 6); if (a.length) o.kw = a }
  return Object.keys(o).length ? o : null
}
const fold = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
// AND across dimensions, OR within one. Keywords match the title, topics or the comic's name.
export function matchFilter(c, f, facts) {
  if (!f) return true
  if (f.regions && !f.regions.includes(facts.region)) return false
  if (f.intl && (!facts.region || facts.region === 'us')) return false
  if (f.tier && facts.tier !== f.tier) return false
  if (f.minYear && !(c.year >= f.minYear)) return false
  if (f.maxYear && !(c.year && c.year <= f.maxYear)) return false
  const sec = Number(c.sec || c.dur) || 0
  if (f.maxSec && !(sec && sec <= f.maxSec)) return false
  if (f.minSec && !(sec >= f.minSec)) return false
  if (f.styles && !f.styles.some((s) => (c.style || []).includes(s))) return false
  if (f.setting === 'talk-show' && c.setting !== 'talk-show' && c.venue !== 'late-night') return false
  if (f.setting === 'special' && c.venue !== 'special' && !c.special_id && !/netflix|special/i.test(c.channel + ' ' + c.title)) return false
  if (f.format && (c.format === 'vertical' ? 'vertical' : 'horizontal') !== f.format) return false
  if (f.kw) { const hay = ' ' + fold([c.title, c.comic, ...(c.topics || [])].join(' ')).replace(/[^a-z0-9]+/g, ' ') + ' '; if (!f.kw.some((k) => hay.includes(' ' + k))) return false }
  return true
}
// how many clips / comics a filter yields, and the verdict shown under the prompt
export function filterVerdict(clips, f, factsOf) {
  const hit = clips.filter((c) => matchFilter(c, f, factsOf(c)))
  const comics = new Set(hit.map((c) => c.comic)).size
  const ok = hit.length >= MIN_CAT_CLIPS && comics >= 2
  return { clips: hit.length, comics, ok, warn: ok && hit.length < WARN_CAT_CLIPS }
}
export function slugify(t) { return fold(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') }

// curated community categories (always present; the API stores user-made ones)
export const CURATED = [
  { slug: 'uk-new-indie', title: 'UK New Indie', filter: { regions: ['uk', 'ireland'], tier: 'indie' }, curated: true },
  { slug: 'international', title: 'International', filter: { intl: true }, curated: true },
  { slug: 'underdogs', title: 'Underdogs', filter: { tier: 'indie' }, curated: true },
  { slug: 'short-and-sharp', title: 'Short & Sharp', filter: { maxSec: 120 }, curated: true },
]

// ---------- scorers (each one named; the logged feature vector is what the pair was chosen by) ----------
// trending clip score: decayed crowd momentum when the tally has it, else the bootstrap prior
//   momentum = data/trending.json clips[id].s (0..1)
//   bootstrap = 0.45 house-board percentile + 0.25 spotlight comic + 0.2 crowd BT (logit squashed) + 0.1 jitter
export function trendScore(c, facts, T, crowdLogit = 0, spotlight = {}) {
  const m = T?.clips?.[c.id]
  const boot = 0.45 * (Number.isFinite(facts.g?.pct) ? facts.g.pct / 100 : facts.tier === 'king' ? 0.4 : 0.15)
    + 0.25 * (facts.id && (facts.id === spotlight.comedianOfWeek || facts.id === spotlight.newComicOfWeek) ? 1 : 0)
    + 0.2 * (1 / (1 + Math.exp(-crowdLogit)))
    + (T?.moments?.some((x) => x.under === c.id) ? 0.15 : 0) // an underdog beat a legend with this clip recently
  if (!m) return { s: boot, src: 'bootstrap' }
  const w = Math.min(1, (m.n || 0) / 8) // trust momentum as evidence accumulates
  return { s: w * m.s + (1 - w) * boot, src: 'momentum' }
}
// similarity between two clips' comics in the vibe space: funnygraph neighbor sim when listed, else shared tags (Jaccard)
export function vibeSim(fa, fb, a, b) {
  const nb = fa.g?.nb?.find?.((x) => x[0] === fb.id) || fb.g?.nb?.find?.((x) => x[0] === fa.id)
  const ta = new Set([...(a.style || []), ...(fa.g?.tags || [])]), tb = new Set([...(b.style || []), ...(fb.g?.tags || [])])
  const inter = [...ta].filter((t) => tb.has(t)).length, uni = new Set([...ta, ...tb]).size
  const jac = uni ? inter / uni : 0
  const topic = (a.topics || []).some((t) => (b.topics || []).includes(t)) ? 1 : 0
  return { nb: nb ? nb[1] : 0, jac, topic, s: (nb ? 0.5 * nb[1] : 0) + 0.35 * jac + 0.15 * topic }
}

// ---------- pickers: (pool, ctx) -> [a, b] with .why (named scores) or null ----------
// ctx: { facts(c), open(a, b) (hard filters), sim(a, b) (struct_sim), lm(c) (log seen/author multiplier), rnd() }
const top = (arr, k) => arr.slice(0, k)
export function pickTrending(P, ctx) {
  if (P.length < 2) return null
  const sc = new Map(P.map((c) => [c, trendScore(c, ctx.facts(c), ctx.trending, ctx.crowd?.(c) || 0, ctx.spotlight || {})]))
  const val = (c) => sc.get(c).s + ctx.lm(c) * 0.25 + 0.12 * ctx.rnd()
  const ranked = [...P].sort((x, y) => val(y) - val(x))
  for (const a of top(ranked, 8)) {
    // diversity: its opponent is another trending clip from a different comic, nudged towards kindred material
    const opp = ranked.filter((b) => b.comic !== a.comic && ctx.open(a.id, b.id)).slice(0, 30)
      .map((b) => [val(b) + 0.3 * ctx.sim(a, b), b]).sort((x, y) => y[0] - x[0])
    if (opp.length) { const b = opp[0][1], pair = [a, b]; pair.why = { feed: 'trending', a: +sc.get(a).s.toFixed(3), b: +sc.get(b).s.toFixed(3), src: sc.get(a).src }; return pair }
  }
  return null
}
export function pickUnderdog(P, ctx) {
  const F = new Map(P.map((c) => { const f = ctx.facts(c); return [c, { f, fame: fame(f) }] }))
  const small = P.filter((c) => F.get(c).fame <= 0.4).sort((x, y) => (ctx.lm(y) + 0.4 * ctx.rnd()) - (ctx.lm(x) + 0.4 * ctx.rnd()))
  const big = P.filter((c) => F.get(c).fame >= 0.6)
  for (const a of top(small, 12)) {
    const fa = F.get(a)
    const opp = big.filter((b) => F.get(b).fame - fa.fame >= UNDERDOG_GAP && b.comic !== a.comic && ctx.open(a.id, b.id))
      .map((b) => { const v = vibeSim(fa.f, F.get(b).f, a, b), st = ctx.sim(a, b); return [0.5 * st + 0.5 * v.s + 0.1 * ctx.lm(b) + 0.15 * ctx.rnd(), b, st, v] })
      .sort((x, y) => y[0] - x[0])
    if (opp.length) { const [, b, st, v] = opp[0], pair = [a, b]; pair.under = a.id; pair.why = { feed: 'underdog', gap: +(F.get(b).fame - fa.fame).toFixed(3), sim: +st.toFixed(3), vibe: +v.s.toFixed(3) }; return pair }
  }
  return null
}
export function pickVibes(P, ctx) {
  if (P.length < 2) return null
  const F = new Map(P.map((c) => [c, ctx.facts(c)]))
  const seeds = [...P].sort((x, y) => (ctx.lm(y) + 0.5 * ctx.rnd()) - (ctx.lm(x) + 0.5 * ctx.rnd()))
  for (const a of top(seeds, 10)) {
    const opp = P.filter((b) => b.comic !== a.comic && ctx.open(a.id, b.id))
      .map((b) => { const v = vibeSim(F.get(a), F.get(b), a, b), st = ctx.sim(a, b), base = 0.6 * v.s + 0.4 * st; return [base + 0.1 * ctx.rnd(), b, v, st, base] })
      .filter((x) => x[4] > 0.05) // a real vibe match only (shared neighbours, tags, topics or structure)
      .sort((x, y) => y[0] - x[0])
    if (opp.length) { const [, b, v, st] = opp[0], pair = [a, b]; pair.why = { feed: 'vibes', nb: +v.nb.toFixed(3), tags: +v.jac.toFixed(3), sim: +st.toFixed(3) }; return pair }
  }
  return null
}

// ---------- tally side: trending momentum + per-category leaderboards ----------
// votes: merged [{a, b, winner, createdAt, signals?}], events: [{kind, a, b, at, clip?, signals?}], watch: {clip: {shows, finished}}
export function trendingDoc(votes, events, watch, byId, { now = Date.now(), hours = 72, halfLife = 24 } = {}) {
  const lo = now - hours * 3600e3, dec = (t) => Math.pow(0.5, (now - t) / (halfLife * 3600e3)), S = {}
  const get = (id) => (S[id] = S[id] || { w: 0, n: 0, skip: 0, raw: 0 })
  for (const v of votes) {
    const t = Date.parse(v.createdAt); if (!(t >= lo) || !byId[v.a] || !byId[v.b]) continue
    const d = dec(t); get(v.a).n += d; get(v.b).n += d; get(v.winner).w += d; get(v.a).raw++; get(v.b).raw++
  }
  for (const e of events) {
    const t = Date.parse(e.at || e.createdAt); if (!(t >= lo)) continue
    if (e.kind === 'skip' && e.clip && byId[e.clip]) get(e.clip).skip += dec(t)
  }
  const moments = []
  for (const v of votes) {
    const t = Date.parse(v.createdAt), P = v.signals?.policy
    if (t >= lo && P?.fd === 'underdog' && P.u && v.winner === P.u) moments.push({ under: P.u, over: P.u === v.a ? v.b : v.a, at: new Date(t).toISOString() })
  }
  const out = {}
  for (const [id, x] of Object.entries(S)) {
    const wr = (x.w + 1) / (x.n + 2), w = watch?.[id], comp = w && w.shows ? w.finished / w.shows : 0.5
    const vol = Math.log1p(x.n) / Math.log1p(20)
    const s = Math.max(0, Math.min(1, 0.45 * wr + 0.3 * Math.min(1, vol) + 0.25 * comp - 0.1 * Math.min(1, x.skip / Math.max(1, x.n))))
    out[id] = { s: Math.round(1000 * s) / 1000, n: Math.round(10 * x.n) / 10, wr: Math.round(1000 * wr) / 1000, comp: Math.round(1000 * comp) / 1000 }
  }
  for (const [id, w] of Object.entries(watch || {})) if (!out[id] && byId[id] && w.shows >= 2) out[id] = { s: Math.round(1000 * 0.6 * (w.finished / w.shows)) / 1000, n: 0, wr: null, comp: Math.round(1000 * w.finished / w.shows) / 1000 }
  return { updated: new Date(now).toISOString(), hours, halfLife, method: 'decayed win rate + vote volume + completion - skips (24 h half-life, 72 h window)', votes: votes.filter((v) => Date.parse(v.createdAt) >= lo).length, clips: out, moments: moments.slice(-50) }
}
// Elo over the votes cast inside one category (in time order), clips and comics
export function categoryBoard(votes, byId, K = 24) {
  const ce = {}, ke = {}, cw = {}, cn = {}, kw = {}, kn = {}
  const E = (m, id) => (m[id] ?? 1500)
  for (const v of [...votes].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))) {
    const A = byId[v.a], B = byId[v.b]; if (!A || !B || A.comic === B.comic) continue
    const wa = v.winner === v.a ? 1 : 0
    for (const [m, x, y, wm, nm] of [[ke, v.a, v.b, kw, kn], [ce, A.comic, B.comic, cw, cn]]) {
      const p = 1 / (1 + Math.pow(10, (E(m, y) - E(m, x)) / 400))
      m[x] = E(m, x) + K * (wa - p); m[y] = E(m, y) - K * (wa - p)
      nm[x] = (nm[x] || 0) + 1; nm[y] = (nm[y] || 0) + 1; wm[wa ? x : y] = (wm[wa ? x : y] || 0) + 1
    }
  }
  const rows = (m, w, n, key) => Object.keys(m).map((id) => ({ [key]: id, elo: Math.round(m[id]), wins: w[id] || 0, bouts: n[id] || 0 })).sort((a, b) => b.elo - a.elo).slice(0, 25)
  return { votes: votes.length, clips: rows(ke, kw, kn, 'id').map((r) => ({ ...r, comic: byId[r.id]?.comic })), comics: rows(ce, cw, cn, 'comic') }
}
