// node tally/test-feeds.mjs : src/feeds.js + src/rank.js (prompt parsing, filters, the core info-gain pair scorer, the relatedness
// gate, Underdog indie vs king, chat exclusion, opponent-adjusted Trending momentum, BT category boards)
// + src/policy.js feed fields
import { parsePrompt, cleanFilter, matchFilter, filterVerdict, pickUnderdog, pickVibes, corePick, trendingDoc, categoryBoard, CURATED, isFeed, cleanScope, slugify, isChat } from '../src/feeds.js'
import { pairInfo, withTop } from '../src/rank.js'
import { cleanPolicy } from '../src/policy.js'
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const P = (t) => parsePrompt(t, { now: new Date('2026-10-18') }).filter
ok(JSON.stringify(P('UK new indie')) === '{"regions":["uk"],"tier":"indie"}', 'UK new indie -> region uk + indie')
ok(JSON.stringify(P('dark one-liners')) === '{"styles":["dark","one-liners"]}', 'dark one-liners -> two style tags')
ok(JSON.stringify(P('crowd work')) === '{"styles":["crowd-work"]}', 'crowd work -> crowd-work')
ok(P('irish storytelling legends').regions[0] === 'ireland' && P('irish storytelling legends').tier === 'king', 'Irish storytelling legends')
ok(P('short late night 90s').maxSec === 120 && P('short late night 90s').setting === 'talk-show' && P('90s').minYear === 1990 && P('90s').maxYear === 1999, 'length, setting, decade')
ok(JSON.stringify(P('funny clips about airports')) === '{"kw":["airports"]}', 'stopwords dropped, the rest are title keywords')
ok(cleanFilter({ regions: ['UK!'], tier: 'god', styles: ['dark', 'nope'], maxSec: 5, kw: ['<b>'] })?.styles?.join() === 'dark' && !cleanFilter({}) , 'cleanFilter drops junk')
const facts = (c) => ({ id: c.fg, region: c.r, tier: c.t, g: { pop: c.pop, house: c.house, tags: c.tags } })
const clips = [
  { id: 'a1', comic: 'Big One', fg: 'big-one', r: 'uk', t: 'king', pop: 90, house: 3, style: ['dark'], sec: 90, title: 'airports bit' },
  { id: 'a2', comic: 'Big Two', fg: 'big-two', r: 'us', t: 'king', pop: 70, house: 40, style: ['observational'], sec: 200 },
  { id: 'b1', comic: 'Small One', fg: 'small-one', r: 'uk', t: 'indie', pop: 5, style: ['dark'], sec: 60 },
  { id: 'b2', comic: 'Small Two', fg: 'small-two', r: 'ireland', t: 'indie', pop: null, style: ['crowd-work'], sec: 100 },
  { id: 'b3', comic: 'Small One', fg: 'small-one', r: 'uk', t: 'indie', pop: 5, style: ['dark'], sec: 70 },
]
ok(matchFilter(clips[0], { kw: ['airports'] }, facts(clips[0])) && !matchFilter(clips[1], { kw: ['airports'] }, facts(clips[1])), 'keywords match titles')
ok(filterVerdict(clips, CURATED[0].filter, facts).clips === 3 && filterVerdict(clips, CURATED[0].filter, facts).ok === false, 'UK New Indie: 3 clips < 6 -> refused')
// ---------- the core pair scorer (src/feeds.js corePick + src/rank.js) ----------
const post = (C) => withTop({ sdComic: 1, sdClip: 0.5, comics: C, clips: {} }, 2)
const mk = (id, comic, extra = {}) => ({ id, comic, fg: comic.toLowerCase(), t: extra.t || 'indie', style: extra.style || ['dark'], topics: extra.topics || [], title: extra.title || id, sec: 60 })
const base = { facts, open: (x, y) => x !== y, sim: () => 0, lm: () => 0 }
{ // information: uncertain + close beats certain or lopsided
  const B = (mu, sd, top = 0) => ({ mu, v: sd * sd + 0.25, cv: sd * sd, top })
  const close = pairInfo(B(0, 1), B(0.1, 1)).gain, sure = pairInfo(B(0, 0.1), B(0.1, 0.1)).gain, far = pairInfo(B(3, 1), B(-3, 1)).gain
  ok(close > sure && close > far, `gain: uncertain+close ${close.toFixed(3)} > certain ${sure.toFixed(3)} and lopsided ${far.toFixed(3)}`)
}
{ // corePick: the uncertain, close pair at the top wins over a certain pair and an uncertain pair at the bottom
  const P = post({ A: { mu: 1.0, sd: 1 }, B: { mu: 1.1, sd: 1 }, C: { mu: -1.5, sd: 1 }, D: { mu: -1.4, sd: 1 }, E: { mu: 0.0, sd: 0.05 }, F: { mu: 0.05, sd: 0.05 } })
  P.clips = { e1: { o: 0, sd: 0.05 }, f1: { o: 0, sd: 0.05 } } // E and F: settled, mid-table
  const pool = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => mk(k.toLowerCase() + '1', k))
  const tally = {}; for (let i = 0; i < 400; i++) { const p = corePick(pool, { ...base, post: P, rnd: Math.random }); const k = p.map((c) => c.comic).sort().join(''); tally[k] = (tally[k] || 0) + 1 }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
  ok(best === 'AB' && !tally.EF && (tally.CD || 0) < tally.AB / 2, `core scorer prefers uncertain, close, top-relevant pairs (${JSON.stringify(tally)})`)
  const p = corePick(pool, { ...base, post: P, rnd: () => 0 })
  ok(p.why.gain > 0 && p.why.top > 0 && p.why.q > 0 && p.why.link.startsWith('tag:dark') && p.pp > 0 && p.pp <= 1 && p.terms.length === 5, `pair.why logs gain/top/quality/link + propensity (${JSON.stringify(p.why)})`)
}
{ // relatedness gate: a linked pair beats a higher-gain unrelated one; unrelated only as a logged fallback
  const P = post({ A: { mu: 0, sd: 1 }, B: { mu: 0, sd: 1 }, C: { mu: 0, sd: 0.6 } })
  const pool = [mk('a1', 'A', { style: ['dark'] }), mk('b1', 'B', { style: ['clean'] }), mk('c1', 'C', { style: ['dark'] })]
  let linked = 0; for (let i = 0; i < 100; i++) { const p = corePick(pool, { ...base, post: P, rnd: Math.random }); if (p.why.link !== 'none' && p.some((c) => c.id === 'c1')) linked++ }
  ok(linked === 100, `gate: only linked pairs compete (A–C share 'dark'; A–B has more gain but no link): ${linked}/100`)
  const lone = [mk('a1', 'A', { style: ['dark'] }), mk('b1', 'B', { style: ['clean'] })]
  const f = corePick(lone, { ...base, post: P, rnd: Math.random })
  ok(f && f.why.fallback === true && f.why.link === 'none', 'no linked opponent passes the hard rules -> unrelated fallback, logged')
  const t = corePick([mk('x1', 'X', { style: [], title: 'My wife and the wedding' }), mk('y1', 'Y', { style: [], title: 'Divorce lawyers' })], { ...base, post: P, rnd: Math.random })
  ok(t?.why.link === 'topic:marriage', `title topics link clips (${t?.why.link})`)
}
{ // Underdog = the core scorer restricted to indie vs king: every king is big, every indie small (no fame cutoff)
  const pool = [mk('k1', 'K1', { t: 'king' }), mk('k2', 'K2', { t: 'king' }), mk('i1', 'I1'), mk('i2', 'I2'), mk('i3', 'I3', { t: 'indie' })]
  pool.forEach((c, i) => { c.pop = i === 1 ? 2 : 50 }) // a low-popularity king still counts as a king
  const P = post({ K1: { mu: 1, sd: 1 }, K2: { mu: 0.2, sd: 1 }, I1: { mu: 0, sd: 1 }, I2: { mu: 0.9, sd: 1 }, I3: { mu: -1, sd: 1 } })
  let okN = 0, n = 0, k2 = 0; for (let i = 0; i < 300; i++) { const p = pickUnderdog(pool, { ...base, post: P, rnd: Math.random }); if (!p) continue; n++; const ts = p.map((c) => c.t).sort().join('-'); if (ts === 'indie-king' && pool.find((c) => c.id === p.under).t === 'indie') okN++; if (p.some((c) => c.id === 'k2')) k2++ }
  ok(n === 300 && okN === 300 && k2 > 0, `Underdog: always indie vs king, the indie logged as under (${okN}/${n}); the low-fame king is eligible (${k2})`)
}
{ // Similar Vibes: only vibe-similar pairs, never a fallback
  const P = post({ A: { mu: 0, sd: 1 }, B: { mu: 0, sd: 1 } })
  ok(pickVibes([mk('a1', 'A', { style: ['dark'] }), mk('b1', 'B', { style: ['clean'] })], { ...base, post: P, rnd: Math.random }) === null, 'Similar Vibes: no vibe match -> no pair (no unrelated fallback)')
}
{ // chat clips (podcast / interview / couch) never reach any feed or category
  const chat = { id: 'ch1', comic: 'Pod', setting: 'chat', style: ['dark'], title: 'Pod on a podcast', sec: 60 }
  ok(isChat(chat) && !matchFilter(chat, null, {}) && !matchFilter(chat, { setting: 'talk-show' }, {}) && !matchFilter(chat, { styles: ['dark'] }, {}) && cleanFilter({ setting: 'chat' }) === null && !CURATED.some((c) => c.filter.setting === 'chat'), 'chat clips: excluded by every filter (main rotation included); no chat category')
}
// ---------- Trending momentum: opponent-adjusted, per showing ----------
const now = Date.parse('Sun 2026-10-18 7:00 AM (UTC+07:00)'), iso = (h) => new Date(now - h * 3600e3).toISOString()
const TC = [mk('s1', 'Strong'), mk('w1', 'Weak'), mk('u1', 'Upset'), mk('f1', 'Farmer')], TB = Object.fromEntries(TC.map((c) => [c.id, c]))
const old = Array.from({ length: 30 }, (_, i) => ({ a: 's1', b: 'w1', winner: 's1', createdAt: iso(200 + i) })) // before the window: Strong >> Weak
const recent = [...Array.from({ length: 5 }, (_, i) => ({ a: 'u1', b: 's1', winner: 'u1', createdAt: iso(2 + i), signals: { policy: { m: 'underdog', fd: 'underdog', u: 'u1' } } })), ...Array.from({ length: 5 }, (_, i) => ({ a: 'f1', b: 'w1', winner: 'f1', createdAt: iso(2 + i) }))]
const T = trendingDoc([...old, ...recent], [], { u1: { shows: 6, finished: 5 }, f1: { shows: 60, finished: 30 } }, TB, { now })
ok(T.clips.u1.dm > T.clips.f1.dm && T.clips.u1.m > T.clips.f1.m && T.clips.u1.conv > T.clips.f1.conv && T.moments.length === 5, `Trending: beating the strong comic moves momentum more than beating the weak one (dm ${T.clips.u1.dm} vs ${T.clips.f1.dm}); votes per showing, not raw volume (conv ${T.clips.u1.conv} vs ${T.clips.f1.conv})`)
// ---------- category boards: Bradley-Terry, order-independent ----------
const cv = [...recent, { a: 's1', b: 'w1', winner: 's1', createdAt: iso(1) }]
const B1 = categoryBoard(cv, TB), B2 = categoryBoard([...cv].reverse(), TB)
ok(JSON.stringify(B1) === JSON.stringify(B2) && B1.comics[0].comic === 'Upset' && B1.votes === 11 && B1.comics[0].lo < B1.comics[0].elo, `category board: BT, the same in any vote order (leader ${B1.comics[0].comic} ${B1.comics[0].elo} [${B1.comics[0].lo}-${B1.comics[0].hi}])`)
ok(JSON.stringify(cleanPolicy({ m: 'trending', fd: 'trending', pp: 125000, g: [583, 760, 1009, 0, 1000], lk: 'topic:dating', fb: 1 })) === '{"m":"trending","pp":125000,"fd":"trending","g":[583,760,1009,0,1000],"lk":"topic:dating","fb":1}', 'policy keeps the scorer terms g, the link lk and the fallback flag')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
