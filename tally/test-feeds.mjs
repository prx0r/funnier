// node tally/test-feeds.mjs : src/feeds.js (prompt parsing, filters, scorers, Underdog tier gap, Trending momentum, category boards)
// + src/policy.js feed fields
import { parsePrompt, cleanFilter, matchFilter, filterVerdict, fame, pickUnderdog, pickTrending, pickVibes, trendingDoc, categoryBoard, UNDERDOG_GAP, CURATED, isFeed, cleanScope, slugify } from '../src/feeds.js'
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
const facts = (c) => ({ id: c.fg, region: c.r, tier: c.t, g: { pop: c.pop, house: c.house } })
const clips = [
  { id: 'a1', comic: 'Big One', fg: 'big-one', r: 'uk', t: 'king', pop: 90, house: 3, style: ['dark'], sec: 90, title: 'airports bit' },
  { id: 'a2', comic: 'Big Two', fg: 'big-two', r: 'us', t: 'king', pop: 70, house: 40, style: ['observational'], sec: 200 },
  { id: 'b1', comic: 'Small One', fg: 'small-one', r: 'uk', t: 'indie', pop: 5, style: ['dark'], sec: 60 },
  { id: 'b2', comic: 'Small Two', fg: 'small-two', r: 'ireland', t: 'indie', pop: null, style: ['crowd-work'], sec: 100 },
  { id: 'b3', comic: 'Small One', fg: 'small-one', r: 'uk', t: 'indie', pop: 5, style: ['dark'], sec: 70 },
]
ok(matchFilter(clips[0], { kw: ['airports'] }, facts(clips[0])) && !matchFilter(clips[1], { kw: ['airports'] }, facts(clips[1])), 'keywords match titles')
ok(filterVerdict(clips, CURATED[0].filter, facts).clips === 3 && filterVerdict(clips, CURATED[0].filter, facts).ok === false, 'UK New Indie: 3 clips < 6 -> refused')
ok(fame(facts(clips[0])) > 0.9 && fame(facts(clips[2])) < 0.1 && fame(facts(clips[3])) <= 0.4, 'fame: kings high, indies low')
const ctx = { facts, open: (x, y) => x !== y, sim: (a, b) => (a.style[0] === b.style[0] ? 1 : 0), lm: () => 0, rnd: Math.random, trending: null, spotlight: {} }
let gapOK = true, sameOK = true, n = 0
for (let i = 0; i < 200; i++) { const p = pickUnderdog(clips, ctx); if (!p) continue; n++; const g = fame(facts(p[1])) - fame(facts(p[0])); if (g < UNDERDOG_GAP) gapOK = false; if (p[0].comic === p[1].comic) sameOK = false }
ok(n === 200 && gapOK && sameOK, 'Underdog: always small vs big with the tier gap, never the same comic')
let dark = 0; for (let i = 0; i < 200; i++) { const p = pickUnderdog(clips, { ...ctx, rnd: () => 0.5 }); if (p && p[0].style[0] === 'dark' && p[1].id === 'a1') dark++ }
ok(dark > 0, 'Underdog prefers a big comic on the same topic/vibe')
{ const t = pickTrending(clips, ctx), v = pickVibes(clips, ctx); ok(t && t[0].comic !== t[1].comic && v && v[0].comic !== v[1].comic && v.why.feed === 'vibes', `Trending + Vibes pick two different comics (${t?.map((c) => c.id)} / ${v?.map((c) => c.id)})`) }
const now = Date.parse('2026-10-18T00:00:00Z'), byId = Object.fromEntries(clips.map((c) => [c.id, c])), iso = (h) => new Date(now - h * 3600e3).toISOString()
const votes = [
  ...Array.from({ length: 6 }, (_, i) => ({ a: 'b1', b: 'a1', winner: 'b1', createdAt: iso(2 + i), signals: { policy: { m: 'underdog', fd: 'underdog', u: 'b1' } } })),
  { a: 'a2', b: 'b2', winner: 'a2', createdAt: iso(100) }, // outside 72 h
]
const T = trendingDoc(votes, [{ kind: 'skip', clip: 'a1', at: iso(1) }], { b1: { shows: 6, finished: 5 } }, byId, { now })
ok(T.clips.b1.s > T.clips.a1.s && !T.clips.a2 && T.moments.length === 6 && T.moments[0].under === 'b1', `Trending: recent winner rises, old votes ignored, underdog moments logged (${JSON.stringify(T.clips.b1)})`)
const B = categoryBoard(votes.slice(0, 6), byId)
ok(B.comics[0].comic === 'Small One' && B.clips[0].id === 'b1' && B.votes === 6, 'category board: Elo over the votes cast in it')
ok(cleanPolicy({ m: 'underdog', fd: 'underdog', u: 'b1abcdef', sc: 'uk', cat: 'uk-new-indie' })?.fd === 'underdog' && cleanPolicy({ m: 'trending', fd: 'nope' }).fd === undefined, 'policy keeps fd/u/sc/cat, drops junk')
ok(isFeed('trending') && isFeed('cat:uk-new-indie') && !isFeed('cat:X') && cleanScope('uk') === 'uk' && !cleanScope('UK!') && slugify('Short & Sharp!') === 'short-sharp', 'feed keys, scope, slugs')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
