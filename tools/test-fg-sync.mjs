// funnygraph live contract: schema checks, slim roster records, comics.json merge, bundle, and the fail-soft path.
// Usage (from funnier/): node tools/test-fg-sync.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { VALIDATE, slimGraph, slimBits, personaTags } from './fg-lib.mjs'
import { mergeComics, buildBundle } from './sync-funnygraph.mjs'
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
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
