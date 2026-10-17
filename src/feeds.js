// Feeds: explicit, interpretable screening modes (X-algorithm-style architecture, no opaque model):
//   candidate retrieval (the scoped, servable, unseen pool) -> hard filters (openPair: two comics, no finished clip,
//   no vertical on desktop, duration fairness) -> independent scorers (named, additive, logged) -> diversity (one clip per
//   comic per round, session author penalty already in rotMult).
// Pure module, shared by the client (src/app.js), the tally (tally/feeds.mjs) and the tests. No DOM, no network.
//
// Every ranking feed is ONE core pair scorer (corePick below) plus a constraint. The scorer picks the pair whose vote
// teaches the crowd ranking the most about who's the funniest (expected information from the src/rank.js posterior,
// weighted towards the top K), keeps the viewer happy (a quality term), and only pairs clips that share a link
// (topic, funnygraph neighbour, style/theory tag, or struct_sim): relatedness is a gate, unrelated pairs are a logged fallback.
//   trending  core x a momentum bonus (data/trending.json: opponent-adjusted rise in strength, per showing).
//   foryou    the personal humour engine (src/app.js pickForYou / Training / Explore mix, unchanged; the only arm the
//             screening trainer learns from).
//   underdog  core restricted to indie vs king (funnygraph tier), + a mild similar-vibe bonus.
//   vibes     core restricted to vibe-similar pairs (0.6 vibe + 0.4 struct_sim > VIBE_MIN).
//   cat:<slug> core inside a category's pool (a saved prompt's filters).
// Safety rule: clips with setting 'chat' (podcasts, interviews, couch, panels) are never served by any feed or category
// (isChat); only explicit links (#clash, invites, history) still play them.

import { belief, pairInfo, sig, fitPosterior } from './rank.js'

export const FEEDS = [
  { k: 'trending', label: 'Trending' },
  { k: 'foryou', label: 'For You' },
  { k: 'underdog', label: 'Underdog' },
  { k: 'vibes', label: 'Similar Vibes' },
]
export const FEED_KEYS = FEEDS.map((f) => f.k)
export const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
export const isFeed = (k) => FEED_KEYS.includes(k) || (typeof k === 'string' && k.startsWith('cat:') && SLUG.test(k.slice(4)))
export const UNDERDOG_GAP = 0.3 // legacy (v1 fame gap); Underdog is now tier-based: every king vs every indie
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
const SETTING_SYN = { 'talk-show': ['talk-show', 'talkshow', 'late-night', 'latenight', 'tonight'], special: ['special', 'specials', 'netflix'] }
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
  if (isChat(c)) return false // podcast / interview / couch clips are never in a feed or category
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
export const isChat = (c) => c?.setting === 'chat'
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

// ---------- relatedness: the link that joins two clips (a required gate for every ranking feed) ----------
// Topics come from clips.json `topics` plus a named title vocabulary (interpretable, no model).
export const TITLE_TOPICS = {
  dating: /\b(dating|tinder|hinge|bumble|first date|boyfriend|girlfriend|single (life|guy|girl|women|men)|hook ?ups?)\b/,
  marriage: /\b(wife|wives|husband|married|marriage|wedding|divorce[ds]?|honeymoon)\b/,
  kids: /\b(kids?|baby|babies|daughters?|sons?|children|parenting|toddlers?|childbirth|pregnan\w*)\b/,
  parents: /\b(parents|mom|moms|mum|mums|mother|father|dad|dads|mama|papa)\b/,
  family: /\b(family|brothers?|sisters?|grandma|grandpa|grandmother|grandfather|nephew|niece|in-laws?|uncle|aunt)\b/,
  race: /\b(racis[mt]|race|white (people|guy|guys|privilege)|black (people|guy|guys)|asian|mexican|chinese|indian|immigra\w*)\b/,
  religion: /\b(jesus|god|religio\w*|church|catholic|muslim|islam\w*|jewish|jews?|bible|christian\w*|atheis\w*|pope)\b/,
  politics: /\b(trump|president|politic\w*|election|kamala|brexit|government|biden|obama|democrats?|republicans?)\b/,
  drugs: /\b(drugs?|weed|cocaine|stoned|crack ?heads?|mushrooms|acid|ketamine)\b/,
  drinking: /\b(drunk|drinking|beer|alcohol\w*|booze|hangover|sober)\b/,
  death: /\b(death|dead|dying|funerals?|die|died|suicide)\b/,
  sex: /\b(sex|porn|virgin|condoms?|orgasm|penis|p\*nis|d\*cks?|fingered)\b/,
  body: /\b(weight|fat|gym|diet|bald|short guy|tall|plus.?sized|body)\b/,
  health: /\b(doctors?|hospital|therapy|therapist|mental|cancer|disabilit\w*|deaf|blind|autis\w*|adhd)\b/,
  travel: /\b(airports?|planes?|flying|flights?|travel\w*|airlines?|hotels?|uber|holiday|vacation|road rage)\b/,
  food: /\b(food|pizza|restaurants?|waffle house|sandwich|mcdonald'?s|cooking|vegan|burger)\b/,
  animals: /\b(dogs?|cats?|animals?|zoo|pets?|kangaroos?|hamsters?|rats|roaches|horses?|bears?|sharks?)\b/,
  crime: /\b(police|cops?|prison|jail|crime|murder\w*|shooters?|shootings?|guns?|arsonist|mafia)\b/,
  tech: /\b(internet|phones?|technology|social media|iphone|instagram|tiktok|computer|robots?|group chats?)\b/,
  work: /\b(jobs?|day job|boss|office|career|working|work)\b/,
  school: /\b(school|college|teachers?|university|students?)\b/,
  gender: /\b(women|woman|men are|girls|feminis\w*|straight men|gay|lgbtq?\+?|gaydar|trans)\b/,
  age: /\b(old age|aging|getting old|birthday|millennials?|gen z|boomers?|midlife)\b/,
  money: /\b(money|rich|poor|broke|rent|debt|taxes)\b/,
  sports: /\b(football|golf|basketball|soccer|sports?|nfl|baseball|boxing|skating)\b/,
}
const TOPIC_MEMO = new WeakMap()
export function topicsOf(c) {
  let t = TOPIC_MEMO.get(c); if (t) return t
  const title = fold(c.title).replace(/#\w+/g, ' ')
  t = new Set([...(Array.isArray(c.topics) ? c.topics : [])])
  for (const [k, re] of Object.entries(TITLE_TOPICS)) if (re.test(title)) t.add(k)
  TOPIC_MEMO.set(c, t); return t
}
const tagsOf = (c, f) => new Set([...(Array.isArray(c.style) ? c.style : []), ...(Array.isArray(f?.g?.tags) ? f.g.tags : [])])
export const SS_LINK = 0.5 // struct_sim at or above this counts as a link on its own
// the cheap links (no struct_sim): shared topic > funnygraph neighbour > shared style / theory tag. null = none found.
export function cheapLink(a, b, fa, fb) {
  const ta = topicsOf(a), tb = topicsOf(b)
  for (const t of ta) if (tb.has(t)) return { link: 'topic:' + t, bonus: 0.6 }
  const nb = fa?.g?.nb?.find?.((x) => x[0] === fb?.id) || fb?.g?.nb?.find?.((x) => x[0] === fa?.id)
  if (nb) return { link: 'nb:' + (+nb[1]).toFixed(2), bonus: Math.min(1, 0.3 + nb[1]) }
  const sa = tagsOf(a, fa), sb = tagsOf(b, fb)
  for (const t of sa) if (sb.has(t)) return { link: 'tag:' + t, bonus: 0.25 }
  return null
}
// full gate: a cheap link, else struct_sim >= SS_LINK. ss (number) may be passed when already known.
export function relLink(a, b, fa, fb, sim, ss) {
  const l = cheapLink(a, b, fa, fb); if (l) return l
  const s = ss != null ? ss : sim ? sim(a, b) : 0
  return s >= SS_LINK ? { link: 'ss:' + s.toFixed(2), bonus: 0.3 + 0.5 * (s - SS_LINK) } : null
}

// ---------- the core pair scorer (every ranking feed: Trending, Underdog, Similar Vibes, categories) ----------
// score(a, b) = gain x top x quality x (1 + relatedness bonus) x seen/author multipliers x feed bonus, where
//   gain     p(1-p) * (var_a + var_b): expected information one vote adds to the crowd ranking (src/rank.js posterior;
//            a clip is a noisy sample of its comic, so the comic's variance is in var and comic rankings get resolved)
//   top      0.25 + 0.75 * P(either comic in the top K): best-arm identification ("who's the funniest")
//   quality  0.75 + 0.5 * sigmoid(mean strength): the viewer must still enjoy it (no two uncertain duds)
//   rel      the link's bonus (topic 0.6, funnygraph neighbour 0.3 + sim, shared tag 0.25, struct_sim 0.3..0.55)
// Relatedness is a GATE: only linked pairs compete; unrelated pairs only when no linked one passes the hard rules
// (logged as a fallback). The choice is random among the top N by score, proportional to score, so the logged
// propensity pp = score / sum(top N) is exact given the candidate set (anchors are deterministic).
export const CORE = { anchors: 24, topN: 6, scan: 900 }
export function corePick(P, ctx, opt = {}) {
  if (!P || P.length < 2) return null
  const post = ctx.post, F = new Map(), Bl = new Map(), R = new Map()
  const fOf = (c) => { let f = F.get(c); if (!f) { f = ctx.facts(c); F.set(c, f) } return f }
  const bOf = (c) => { let b = Bl.get(c); if (!b) { b = belief(post, c); Bl.set(c, b) } return b }
  const rOf = (c) => { let r = R.get(c); if (r == null) { r = Math.exp(ctx.lm ? ctx.lm(c) : 0); R.set(c, r) } return r }
  const elig = opt.elig ? P.filter(opt.elig) : P
  if (elig.length < 2) return null
  // anchors: the clips whose own uncertainty x top relevance x quality x freshness is highest (deterministic)
  const unary = (c) => { const b = bOf(c); return b.v * (0.25 + 0.75 * b.top) * (0.75 + 0.5 * sig(b.mu)) * rOf(c) * (opt.unary ? opt.unary(c) : 1) }
  const anchors = (opt.anchorOK ? elig.filter(opt.anchorOK) : elig).map((c) => [unary(c), c]).sort((x, y) => y[0] - x[0]).slice(0, CORE.anchors).map((x) => x[1])
  const cand = []
  for (const a of anchors) {
    const A = bOf(a), fa = fOf(a)
    for (const b of elig) {
      if (b === a || b.comic === a.comic || (opt.pairOK && !opt.pairOK(a, b))) continue
      const B = bOf(b), I = pairInfo(A, B), top = 0.25 + 0.75 * (1 - (1 - A.top) * (1 - B.top)), q = 0.75 + 0.5 * sig((A.mu + B.mu) / 2)
      const cl = cheapLink(a, b, fa, fOf(b))
      const base = I.gain * top * q * rOf(a) * rOf(b) * (opt.bonus ? opt.bonus(a, b) : 1)
      cand.push({ a, b, I, top, q, cl, base, s: base * (1 + (cl ? cl.bonus : 0)) })
    }
  }
  cand.sort((x, y) => y.s - x.s)
  const keys = new Set(), linked = [], loose = []
  const kOf = (x) => (x.a.id < x.b.id ? x.a.id + '|' + x.b.id : x.b.id + '|' + x.a.id)
  const take = (x, l, ss) => { keys.add(kOf(x)); x.l = l; x.ss = ss; x.s = x.base * (1 + l.bonus); linked.push(x) }
  if (opt.gate) { // a feed's own gate (Similar Vibes) needs struct_sim for each candidate: one pass, best first
    for (let i = 0; i < cand.length && i < CORE.scan && linked.length < CORE.topN; i++) {
      const x = cand[i]; if (keys.has(kOf(x))) continue
      const ss = ctx.sim ? ctx.sim(x.a, x.b) : 0
      if (!opt.gate(x.a, x.b, ss) || !ctx.open(x.a.id, x.b.id)) continue
      take(x, x.cl || relLink(x.a, x.b, null, null, null, ss) || { link: 'vibe', bonus: 0 }, ss)
    }
  } else if (ctx.noGate) { // simulation baseline only (tally/sim-feeds.mjs): no gate, best score first, link recorded when there is one
    for (let i = 0; i < cand.length && linked.length < CORE.topN; i++) { const x = cand[i]; if (!keys.has(kOf(x)) && ctx.open(x.a.id, x.b.id)) take(x, x.cl || { link: 'none', bonus: 0 }, null) }
  } else {
    // pass 1: the cheap links (shared topic, funnygraph neighbour, shared tag) over every candidate, best first
    for (let i = 0; i < cand.length && linked.length < CORE.topN; i++) { const x = cand[i]; if (x.cl && !keys.has(kOf(x)) && ctx.open(x.a.id, x.b.id)) take(x, x.cl, null) }
    // pass 2: struct_sim >= SS_LINK for the best unlinked candidates (bounded: struct_sim is the expensive part)
    for (let i = 0, n = 0; i < cand.length && n < CORE.scan && linked.length < CORE.topN; i++) {
      const x = cand[i]; if (x.cl || keys.has(kOf(x))) continue
      n++; const ss = ctx.sim ? ctx.sim(x.a, x.b) : 0, l = ss >= SS_LINK ? relLink(x.a, x.b, null, null, null, ss) : null
      if (l) { if (ctx.open(x.a.id, x.b.id)) take(x, l, ss) } else if (loose.length < CORE.topN && ctx.open(x.a.id, x.b.id)) { keys.add(kOf(x)); loose.push(x) }
    }
  }
  let fb = false, pool = linked
  if (!pool.length) {
    if (opt.gate) return null
    // fallback: no linked opponent passed the hard rules; unrelated pairs, logged as such
    for (let i = 0; i < cand.length && loose.length < CORE.topN && i < CORE.scan * 3; i++) { const x = cand[i]; if (!keys.has(kOf(x)) && ctx.open(x.a.id, x.b.id)) { keys.add(kOf(x)); loose.push(x) } }
    if (!loose.length) return null
    pool = loose; fb = true
  }
  pool.sort((x, y) => y.s - x.s)
  const Z = pool.reduce((s, x) => s + x.s, 0)
  let r = (ctx.rnd ? ctx.rnd() : Math.random()) * Z, i = 0
  for (; i < pool.length - 1; i++) { r -= pool[i].s; if (r <= 0) break }
  const x = pool[i], pair = [x.a, x.b], r3 = (v) => Math.round(v * 1000) / 1000
  pair.pp = Z > 0 ? x.s / Z : 1 / pool.length
  pair.why = { feed: opt.feed || 'core', gain: r3(x.I.gain), p: r3(x.I.p), top: r3(x.top), q: r3(x.q), rel: r3(x.l ? x.l.bonus : 0), link: x.l ? x.l.link : 'none', ...(fb ? { fallback: true } : {}), ...(opt.why ? opt.why(x.a, x.b) : {}), s: +x.s.toPrecision(3), pp: r3(pair.pp), n: pool.length }
  pair.terms = [x.I.gain, x.top, x.q, x.l ? x.l.bonus : 0, opt.bonusOf ? opt.bonusOf(x.a, x.b) : 1] // logged as policy.g (x1000)
  return pair
}

// ---------- feeds = the core scorer + a constraint ----------
// Trending: the core scorer x a momentum bonus (data/trending.json m, 0..1: opponent-adjusted rise in strength over the
// window, per-showing conversion and completion; tally trendingDoc).
export const momentum = (T, c) => { const m = T?.clips?.[c.id]; return m && Number.isFinite(m.m) ? m.m : 0 }
export function pickTrending(P, ctx) {
  const mb = (a, b) => 1 + 0.75 * Math.max(momentum(ctx.trending, a), momentum(ctx.trending, b))
  return corePick(P, ctx, { feed: 'trending', bonus: mb, bonusOf: mb, unary: (c) => 1 + 0.75 * momentum(ctx.trending, c), why: (a, b) => ({ mom: +Math.max(momentum(ctx.trending, a), momentum(ctx.trending, b)).toFixed(3) }) })
}
// Underdog: exactly the core scorer restricted to indie vs king (funnygraph tier: every king is big, every indie small),
// with a mild similar-vibe bonus. pair.under = the indie clip.
export const tierOfFacts = (f) => (f?.tier === 'king' || f?.tier === 'indie' ? f.tier : null)
export function pickUnderdog(P, ctx) {
  const T = new Map(), tier = (c) => { let t = T.get(c); if (t === undefined) { t = tierOfFacts(ctx.facts(c)); T.set(c, t) } return t }
  const vb = (a, b) => 1 + 0.3 * vibeSim(ctx.facts(a), ctx.facts(b), a, b).s
  const p = corePick(P, ctx, { feed: 'underdog', elig: (c) => !!tier(c), pairOK: (a, b) => tier(a) !== tier(b), bonus: vb, bonusOf: vb })
  if (!p) return null
  p.under = tier(p[0]) === 'indie' ? p[0].id : p[1].id
  p.why.under = p.under
  return p
}
// Similar Vibes: the core scorer restricted to vibe-similar pairs (0.6 vibe + 0.4 struct_sim above VIBE_MIN; no fallback)
export const VIBE_MIN = 0.1
export function pickVibes(P, ctx) {
  const vs = (a, b, ss) => 0.6 * vibeSim(ctx.facts(a), ctx.facts(b), a, b).s + 0.4 * (ss != null ? ss : ctx.sim(a, b))
  return corePick(P, ctx, { feed: 'vibes', gate: (a, b, ss) => vs(a, b, ss) > VIBE_MIN, why: (a, b) => ({ vibe: +vs(a, b).toFixed(3) }) })
}
// a category: the core scorer inside the category pool (the pool is already filtered by openPair/feedOK)
export const pickCategory = (P, ctx) => corePick(P, ctx, { feed: 'category' })

// ---------- tally side: trending momentum + per-category leaderboards ----------
// votes: merged [{a, b, winner, createdAt, signals?}], events: [{kind, a, b, at, clip?, signals?}], watch: {clip: {shows, finished}}
// Momentum is opponent-adjusted and per showing, so it can't feed on its own exposure:
//   dm    = posterior strength now - posterior strength from the votes before the window (src/rank.js, same prior):
//           beating weak opponents barely moves it, an upset moves it a lot
//   conv  = votes / showings (watch stats; capped at 1), not raw volume, so showing a clip more doesn't make it "trend"
//   comp  = finished / showings (0.5 when unknown);  skip = skips / showings
//   m     = evidence x clamp(0.65 x max(0, dm)/0.5 + 0.2 x comp + 0.15 x conv - 0.1 x skip, 0, 1), evidence = n/(n+4)
export function trendingDoc(votes, events, watch, byId, { now = Date.now(), hours = 72, halfLife = 24, prior = () => 0, clips = null } = {}) {
  const lo = now - hours * 3600e3, S = {}, inWin = [], before = [], all = []
  const get = (id) => (S[id] = S[id] || { n: 0, skip: 0, raw: 0 })
  for (const v of votes) {
    const t = Date.parse(v.createdAt); if (!byId[v.a] || !byId[v.b] || !(t <= now)) continue
    all.push(v); if (t >= lo) { inWin.push(v); get(v.a).n++; get(v.b).n++ } else before.push(v)
  }
  for (const e of events) {
    const t = Date.parse(e.at || e.createdAt); if (!(t >= lo)) continue
    if (e.kind === 'skip' && e.clip && byId[e.clip]) get(e.clip).skip++
  }
  const moments = []
  for (const v of inWin) { const P = v.signals?.policy; if (P?.fd === 'underdog' && P.u && v.winner === P.u) moments.push({ under: P.u, over: P.u === v.a ? v.b : v.a, at: new Date(Date.parse(v.createdAt)).toISOString() }) }
  const ids = Object.keys(S), cl = clips || Object.values(byId)
  const post = (vs) => fitPosterior(cl, vs, { prior })
  const P1 = ids.length ? post(all) : null, P0 = ids.length ? post(before) : null
  const str = (P, c) => (P.comics[c.comic]?.mu || 0) + (P.clips[c.id]?.o || 0)
  const out = {}, r3 = (x) => Math.round(1000 * x) / 1000
  for (const id of ids) {
    const x = S[id], c = byId[id], w = watch?.[id], shows = w && w.shows ? w.shows : 0
    const dm = str(P1, c) - str(P0, c), comp = shows ? Math.min(1, (w.finished || 0) / shows) : 0.5
    const conv = shows ? Math.min(1, x.n / shows) : Math.min(1, Math.log1p(x.n) / Math.log1p(20)) // capped volume when showings are unknown
    const skip = Math.min(1, x.skip / Math.max(1, shows || x.n)), ev = x.n / (x.n + 4)
    const m = ev * Math.max(0, Math.min(1, 0.65 * Math.max(0, dm) / 0.5 + 0.2 * comp + 0.15 * conv - 0.1 * skip))
    out[id] = { m: r3(m), s: r3(m), dm: r3(dm), n: x.n, shows, conv: r3(conv), comp: r3(comp) }
  }
  for (const [id, w] of Object.entries(watch || {})) if (!out[id] && byId[id] && w.shows >= 2) { const comp = Math.min(1, w.finished / w.shows); out[id] = { m: r3(0.2 * comp * (w.shows / (w.shows + 4))), s: 0, dm: 0, n: 0, shows: w.shows, conv: 0, comp: r3(comp) } }
  for (const o of Object.values(out)) o.s = o.m
  return { updated: new Date(now).toISOString(), hours, method: 'opponent-adjusted momentum: Bradley-Terry strength now minus before the window, x evidence, + completion and votes per showing (capped) - skips', votes: inWin.length, clips: out, moments: moments.slice(-50) }
}
// Bradley-Terry over the votes cast inside one category (order-independent, same hierarchy as the main board, flat
// prior): clips and comics, Elo scale, 95% interval from the Laplace sd.
export function categoryBoard(votes, byId) {
  const vs = votes.filter((v) => byId[v.a] && byId[v.b] && byId[v.a].comic !== byId[v.b].comic)
  const used = [...new Set(vs.flatMap((v) => [v.a, v.b]))].map((id) => byId[id])
  const P = fitPosterior(used, vs, { sdComic: 1.5, sdClip: 0.5, iters: 60 })
  const E = (x) => Math.round(1500 + (400 / Math.LN10) * x), w = {}, n = {}, cw = {}, cn = {}
  for (const v of vs) { const A = byId[v.a].comic, B = byId[v.b].comic, W = v.winner; n[v.a] = (n[v.a] || 0) + 1; n[v.b] = (n[v.b] || 0) + 1; w[W] = (w[W] || 0) + 1; cn[A] = (cn[A] || 0) + 1; cn[B] = (cn[B] || 0) + 1; const wc = byId[W].comic; cw[wc] = (cw[wc] || 0) + 1 }
  const clipsOut = used.map((c) => { const C = P.comics[c.comic], K = P.clips[c.id], mu = C.mu + K.o, sd = Math.sqrt(C.sd ** 2 + K.sd ** 2); return { id: c.id, comic: c.comic, elo: E(mu), lo: E(mu - 1.96 * sd), hi: E(mu + 1.96 * sd), wins: w[c.id] || 0, bouts: n[c.id] || 0 } }).sort((a, b) => b.elo - a.elo).slice(0, 25)
  const comicsOut = Object.entries(P.comics).map(([comic, C]) => ({ comic, elo: E(C.mu), lo: E(C.mu - 1.96 * C.sd), hi: E(C.mu + 1.96 * C.sd), wins: cw[comic] || 0, bouts: cn[comic] || 0 })).sort((a, b) => b.elo - a.elo).slice(0, 25)
  return { votes: vs.length, clips: clipsOut, comics: comicsOut }
}
