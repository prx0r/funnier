// funnygraph live contract: schema checks, slim roster records, comics.json merge, bundle, and the fail-soft path.
// Usage (from funnier/): node tools/test-fg-sync.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { VALIDATE, slimGraph, slimBits, personaTags, specialTitle, slimManifest, ratedSpecials } from './fg-lib.mjs'
import { mergeComics, buildBundle, extraBoards, buildProfiles, bioLine, gapText } from './sync-funnygraph.mjs'
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

ok(VALIDATE['rankings/ratings.json']({ rows: Array.from({ length: 25 }, (_, i) => ({ comedian_id: 'c' + i, name: 'C' + i, boards: {} })) }), 'ratings: valid shape accepted')
ok(!VALIDATE['rankings/ratings.json']({ rows: [{ comedian_id: 'x', name: 'X', boards: {} }] }), 'ratings: a truncated board is rejected (keeps last good)')
ok(!VALIDATE['rankings/consensus.json']([{ comedian_id: 'a', name: 'A' }, { comedian_id: 'b', name: 'B' }, { comedian_id: 'c', name: 'C' }, { comedian_id: 'd', name: 'D' }, { comedian_id: 'e', name: 'E' }]), 'consensus: rows without rank rejected')
ok(!VALIDATE['rankings/by_type.json']([]), 'by_type: an array where an object belongs is rejected')

const g = { comedian_id: 'norm-macdonald', name: 'Norm Macdonald', tier: 'king', region: 'canada', continent: 'north-america', humor_type: { primary: 'absurdist' },
  modes: { repertoire: { absurdist: 0.6, 'dark-confessional': 0.3, meta: 0.1 }, signature_title: 'anti-joke' }, engine: { delivery_archetype: 'suspension_deadpan' },
  identity: { deal: 'The long way round. Then more.' }, bio: { dob: '1959-10-17', dod: '2021-09-14' }, youtube_channel: { id: 'UCWiHJYoHWyO56dlo_vjTleA', status: 'active' },
  sets: [{ transcript: { path: '/secret.txt' } }], known_bits: [{ title: 'Moth joke', why_it_works: 'long' }] }
const s = slimGraph(g)
ok(s && s.id === 'norm-macdonald' && s.region === 'canada' && s.tier === 'king', 'slimGraph keeps identity, region, tier')
ok(JSON.stringify(personaTags(g)) === JSON.stringify(['absurd', 'dark', 'self-deprecating']), 'persona tags map funnygraph modes onto the Funnier vocabulary (' + personaTags(g).join(',') + ')')
ok(!JSON.stringify(s).includes('secret') && !JSON.stringify(s).includes('Moth'), 'slimGraph carries no sets, transcripts or bits')
ok(s.channels.length === 1 && s.channels[0].id === 'UCWiHJYoHWyO56dlo_vjTleA', 'a single channel object is accepted')
ok(slimGraph({ comedian_id: 'x', name: 'X', region: 'synthetic' }).synthetic, 'synthetic personas are flagged')
ok(!('why' in slimBits([{ bit: 'b', why: 'prose', comedian_id: 'x', theories: ['t'] }])[0]), 'bits: metadata only, no prose')

const owned = { comics: { 'Norm Macdonald': { slug: 'norm-macdonald', tagline: 'Card line.', facts: ['Weekend Update anchor on SNL'], photo: 'img/norm-macdonald.jpg' } }, ai: [] }
const C = { 'norm-macdonald': s, 'zakir-khan': { ...slimGraph({ comedian_id: 'zakir-khan', name: 'Zakir Khan', tier: 'indie', region: 'india' }) } }
const bundle = { people: { 'norm-macdonald': { h: 100, cov: 'FULL', house: 1, pct: 100, cons: 25, canon: 38, peop: 18, era: 39 } } }
const clips = [{ id: 'a', comic: 'Norm Macdonald' }, { id: 'b', comic: 'Zakir Khan' }, { id: 'c', comic: 'Unknown Comic' }, { id: 'd', comic: 'Gone', status: 'removed' }]
const m = mergeComics(owned, {}, C, bundle, clips, { repo: 'prx0r/funnygraph', sha: 'abcdef1234' })
const N = m.comics['Norm Macdonald']
ok(N.photo === 'img/norm-macdonald.jpg' && N.tagline === 'Card line.', 'Funnier-owned photo + card line kept')
ok(N.region === 'canada' && N.tier === 'king' && N.fgId === 'norm-macdonald' && N.fg.house === 1, 'funnygraph identity + board ranks merged')
ok(N.facts[0] === '1959\u20132021' && N.facts.includes('Canada') && N.facts.includes('Weekend Update anchor on SNL'), 'facts: years/region from funnygraph, credits from Funnier (' + N.facts.join(' | ') + ')')
ok(m.comics['Zakir Khan'].regionLabel === 'India' && m.comics['Zakir Khan'].tier === 'indie', 'a new international comic gets its region from funnygraph')
ok(m.comics['Unknown Comic'] && !m.comics['Unknown Comic'].fgId, 'a comic funnygraph does not know still gets a record (no fg fields)')
ok(!m.comics.Gone && m.source.sha7 === 'abcdef1', 'removed-only comics dropped; source sha recorded')
const m2 = mergeComics(owned, { 'Norm Macdonald': 'zakir-khan' }, C, null, clips, {})
ok(m2.comics['Norm Macdonald'].fgId === 'zakir-khan', 'fg-map.json overrides the slug')

// bundle from files on disk
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-'))
fs.mkdirSync(path.join(dir, 'rankings'))
const W = (f, v) => fs.writeFileSync(path.join(dir, 'rankings', f), JSON.stringify(v))
W('ratings.json', { rows: [{ comedian_id: 'norm-macdonald', name: 'Norm Macdonald', tier: 'king', headline: 100, boards: { house: { rank: 1, pct: 100 }, consensus: { rank: 25 } } }, { comedian_id: 'bot', name: 'Bot', boards: {} }] })
W('house.json', { rows: [{ rank: 1, comedian_id: 'norm-macdonald', name: 'Norm Macdonald', house_pct: 100 }] })
W('consensus.json', [{ rank: 25, comedian_id: 'norm-macdonald', name: 'Norm Macdonald', score: 6.1234 }])
const b = buildBundle({ repo: 'prx0r/funnygraph', sha: 'abcdef1234' }, { comedians: { ...C, bot: { id: 'bot', synthetic: true } } }, dir)
ok(b.boards.house.rows[0][0] === 'norm-macdonald' && b.boards.house.rows[0][2] === 100 && b.boards.consensus.rows[0][2] === 6.12, 'bundle copies board order and values')
ok(!b.people.bot && b.people['norm-macdonald'].r === 'canada', 'bundle: synthetic personas left out, region attached')
ok(b.source.sha7 === 'abcdef1', 'bundle records the funnygraph commit')

// fail soft: funnygraph unreachable -> last good copy kept, comics.json still generated, exit 0
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'))
fs.mkdirSync(path.join(out, 'data', 'funnygraph'), { recursive: true })
fs.cpSync(dir, path.join(out, 'data', 'funnygraph'), { recursive: true })
fs.writeFileSync(path.join(out, 'data', 'funnygraph', 'roster.json'), JSON.stringify({ sha: 'abcdef1234', blobs: {}, comedians: C }))
fs.writeFileSync(path.join(out, 'data', 'funnygraph', 'meta.json'), JSON.stringify({ repo: 'prx0r/funnygraph', sha: 'abcdef1234', lastGoodAt: 'then' }))
const before = fs.readFileSync(path.join(out, 'data', 'funnygraph', 'rankings', 'ratings.json'), 'utf8')
execFileSync(process.execPath, ['tools/sync-funnygraph.mjs', '.', out], { env: { ...process.env, FG_SYNC_OFFLINE: '1' }, stdio: 'pipe' })
const meta = JSON.parse(fs.readFileSync(path.join(out, 'data', 'funnygraph', 'meta.json'), 'utf8'))
ok(fs.readFileSync(path.join(out, 'data', 'funnygraph', 'rankings', 'ratings.json'), 'utf8') === before, 'offline: last good boards untouched')
ok(meta.sha === 'abcdef1234' && meta.ok === false && meta.errors.length, 'offline: meta keeps the last good sha and reports the error')
const pc = JSON.parse(fs.readFileSync(path.join(out, 'comics.json'), 'utf8'))
ok(pc.comics['Norm Macdonald']?.fgId === 'norm-macdonald' && pc.source.sha7 === 'abcdef1', 'offline: comics.json merged from the last good roster')
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pub0-'))
execFileSync(process.execPath, ['tools/sync-funnygraph.mjs', '.', fresh], { env: { ...process.env, FG_SYNC_OFFLINE: '1' }, stdio: 'pipe' })
ok(Object.keys(JSON.parse(fs.readFileSync(path.join(fresh, 'comics.json'), 'utf8')).comics).length >= 6 && !fs.existsSync(path.join(fresh, 'data', 'funnygraph', 'boards.json')), 'offline + no history: Funnier-owned comics.json still published, no fake boards')

// ---- comic boards (style kings, verdict gap, eras) + profile detail ----
ok(JSON.stringify(specialTitle('JIM JEFFERIES: INTOLERANT (2020) \u2013 FULL TRANSCRIPT', 'Jim Jefferies', true)) === '{"title":"Intolerant","year":2020}', 'special titles: name prefix, year and transcript suffix stripped, all-caps fixed')
ok(specialTitle('Kevin Hart: Gun Compartment Scene', 'Kevin Hart', true) === null && specialTitle('GEORGE CARLIN: JAMMING (1992) \u2013 Testo italiano completo', 'George Carlin', true) === null, 'scenes and translations are not specials')
const man = slimManifest({ comedians: { 'drew-michael': { name: 'Drew Michael', specials: [{ title: 'Drew Michael: Red Blue Green (2021) | Transcript', transcript_url: 'https://x.r2.cloudflarestorage.com/secret.json', n_words: 9000, transcript_preview: 'lines' }] } } })
ok(JSON.stringify(man) === '{"comedians":{"drew-michael":[["Red Blue Green",2021]]}}', 'site_manifest slimmed to title + year: no transcript links, previews or word counts')
const rs = ratedSpecials({ name: 'Bill Hicks', specials_rated: [{ title: 'Bill Hicks: Relentless', year: 1992, imdb_rating: 8.5, imdb_votes: 2756, standout: true, transcript: 'x.txt' }, { title: 'RED', year: 2010, imdb_rating: 7, imdb_votes: 341534 }, { title: 'Stewart Lee - Live', special: 'live' }] })
ok(rs.length === 1 && rs[0].t === 'Relentless' && rs[0].r === 8.5 && !('transcript' in rs[0]), 'rated specials: IMDb mismatches that do not name the comic dropped, no transcript path')
ok(VALIDATE['data/r2/site_manifest.json']({ comedians: {} }) && !VALIDATE['rankings/metrics.json']([{ comedian_id: 'a', name: 'A', gap_value: 'x' }]), 'metrics + manifest schema checks')
const P3 = { a: { n: 'A' }, b: { n: 'B' }, c: { n: 'C' }, d: { n: 'D' } }
const xb = extraBoards(P3, { observational: [{ type_rank: 2, comedian_id: 'b', name: 'B', legacy: 90.4 }, { type_rank: 1, comedian_id: 'a', name: 'A', legacy: 98.9 }, { type_rank: 3, comedian_id: 'zz', name: 'ZZ' }] },
  [{ comedian_id: 'a', name: 'A', gap_value: 0.83, overrated: 'massively overrated' }, { comedian_id: 'b', name: 'B', gap_value: -0.7, overrated: 'massively underrated' }, { comedian_id: 'c', name: 'C', gap_value: -0.1, overrated: 'accurately rated' }, { comedian_id: 'd', name: 'D', gap_value: null }],
  { nineties: [{ gen_rank: 1, comedian_id: 'c', name: 'C', score: 8.25 }] })
ok(xb.kings.groups[0].k === 'observational' && xb.kings.groups[0].rows[0][0] === 'a' && xb.kings.groups[0].rows[0][2] === 'Legacy 99' && xb.kings.groups[0].rows.length === 2, 'style kings: funnygraph type order, unknown comics dropped')
ok(xb.over.rows[0][0] === 'a' && xb.over.rows[0][2] === '+0.83 \u00b7 massively overrated' && xb.under.rows.map((r) => r[0]).join() === 'b,c' && xb.under.rows[1][2] === '\u22120.10', 'verdict gap boards: copied values + bands, null gap left out, accurate band not printed')
ok(xb.era.groups[0].label === 'Nineties' && xb.kings.ref && xb.under.ref, 'era picker; reference boards flagged ref')
ok(bioLine({ source: 'wikidata', occupations: ['actor', 'stand-up comedian', 'television actor'], birthplace: 'Canton', citizenship: 'United States' }) === 'Stand-up comedian and actor, born in Canton, United States.' && bioLine({ occupations: ['x'] }) === null, 'Wikidata bio line (' + bioLine({ source: 'wikidata', occupations: ['actor', 'stand-up comedian', 'television actor'], birthplace: 'Canton', citizenship: 'United States' }) + ')')
{ const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'fgp-')); fs.mkdirSync(path.join(pd, 'rankings'), { recursive: true }); fs.mkdirSync(path.join(pd, 'data', 'r2'), { recursive: true })
  const PW = (f, v) => fs.writeFileSync(path.join(pd, f), JSON.stringify(v))
  PW('rankings/neighbors.json', { 'bill-burr': [{ comedian_id: 'norm-macdonald', sim: 0.5 }, { comedian_id: 'bot', sim: 0.4 }, { comedian_id: 'nobody', sim: 0.3 }] })
  PW('data/r2/site_manifest.json', man.comedians ? { comedians: { 'bill-burr': [['Paper Tiger', 2019], ['The Philadelphia Incident', 2006]] } } : {})
  PW('rankings/specials.json', [{ special: 'Bill Burr: Let It Go', year: 2010, comedian_id: 'bill-burr', rating: 8.3 }, { special: 'N\u00f4', year: 1998, comedian_id: 'bill-burr', rating: 6.9 }])
  PW('rankings/metrics.json', [{ comedian_id: 'bill-burr', name: 'Bill Burr', gap_value: 0.112, overrated: 'accurately rated' }])
  const RC = { 'bill-burr': { id: 'bill-burr', name: 'Bill Burr', bio: { source: 'wikidata', occupations: ['comedian'], birthplace: 'Canton' }, specials: [{ t: 'Paper Tiger', y: 2019, r: 8, v: 13449, st: 1 }] }, 'norm-macdonald': s, bot: { id: 'bot', name: 'Bot', synthetic: true } }
  const merged = { comics: { 'Bill Burr': { fgId: 'bill-burr', slug: 'bill-burr' }, 'Norm Macdonald': { fgId: 'norm-macdonald' } } }
  const clipsP = [{ id: 'FBKWxJehH7Q', comic: 'Bill Burr', title: 'Bill Burr: Paper Tiger | Netflix', media: 'youtube', carrier: 'licensed', dur: 300 }, { id: 'zzz', comic: 'Bill Burr', title: 'Philadelphia Incident fan upload', media: 'youtube', carrier: 'unofficial' }]
  const pr = buildProfiles({ sha: 'abcdef1234' }, { comedians: RC }, { people: { 'bill-burr': { n: 'Bill Burr' } }, boards: { kings: { groups: [{ k: 'rant', label: 'Rant', rows: [['bill-burr', 3, null]] }] } } }, merged, clipsP, pd)
  const BB = pr.comics['bill-burr']
  ok(BB.sp.map((x) => x[0]).join('|') === 'Paper Tiger|Let It Go|The Philadelphia Incident' && BB.sp[0][2] === 8, 'profile specials: graph + curated + manifest merged, deduped, newest first, bogus IMDb match dropped (' + BB.sp.map((x) => x[0]).join('|') + ')')
  ok(BB.sp[0][3] === 'FBKWxJehH7Q' && BB.sp[0][4] === 0 && BB.sp[2].length === 3, 'a special links only to an official on-site clip of it (unofficial uploads never)')
  ok(!JSON.stringify(pr).match(/transcript|r2\.cloudflarestorage|scraps/i), 'profiles carry no transcript text or links')
  ok(BB.fans.length === 1 && BB.fans[0][1] === 'Norm Macdonald' && BB.bio === 'Comedian, born in Canton.' && BB.kings[0][1] === 'Rant' && BB.gap[1] === 'accurately rated', 'For fans of (synthetic + unknown dropped), bio, style king badge, verdict gap')
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
