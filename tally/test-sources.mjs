// node tally/test-sources.mjs : AT + D1-export vote merge (latest per voter per pair, cross-source dedup, events aliasing)
import { mergeVotes, eventsForTraining, fetchExport } from './sources.mjs'
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const byId = { A: {}, B: {}, C: {} }
const at = [{ did: 'did:plc:x', a: 'A', b: 'B', winner: 'A', createdAt: '2026-10-10T10:00:00.000Z', voter: 'human' }]
const d1 = [
  { voter: 'd1:aaaaaaaaaaaaaaaa', a: 'B', b: 'A', winner: 'A', createdAt: '2026-10-10T10:00:00.000Z' }, // same pick as the AT record: same person
  { voter: 'd1:aaaaaaaaaaaaaaaa', a: 'A', b: 'C', winner: 'C', createdAt: '2026-10-11T10:00:00.000Z' },
  { voter: 'd1:bbbbbbbbbbbbbbbb', a: 'A', b: 'B', winner: 'B', createdAt: '2026-10-10T09:00:00.000Z' },
  { voter: 'd1:bbbbbbbbbbbbbbbb', a: 'B', b: 'A', winner: 'A', createdAt: '2026-10-12T09:00:00.000Z' }, // re-vote: latest wins
  { voter: 'd1:cccccccccccccccc', a: 'A', b: 'Z', winner: 'A', createdAt: '2026-10-10T09:00:00.000Z' }, // unknown clip
  { voter: 'alice@example.com', a: 'A', b: 'B', winner: 'A', createdAt: '2026-10-10T09:00:00.000Z' }, // not a hashed voter
]
const m = mergeVotes(at, d1, byId)
ok(m.alias['d1:aaaaaaaaaaaaaaaa'] === 'did:plc:x', 'a D1 voter whose pick matches an AT record exactly is aliased to that DID')
ok(m.votes.filter((v) => v.did === 'did:plc:x').length === 2 && m.votes.filter((v) => v.did === 'did:plc:x' && v.a === 'A' && v.b === 'B' || v.did === 'did:plc:x' && v.a === 'B' && v.b === 'A').length === 1, 'the cross-source copy collapses into one vote; the other D1 vote joins the DID')
const b = m.votes.filter((v) => v.did === 'd1:bbbbbbbbbbbbbbbb')
ok(b.length === 1 && b[0].winner === 'A', 'latest vote per voter per pair')
ok(!m.votes.some((v) => v.b === 'Z' || v.did === 'alice@example.com'), 'unknown clips and non-hashed voters are dropped')
ok(m.votes.length === 3 && m.d1Voters['d1:bbbbbbbbbbbbbbbb'] === 1, `3 votes in total (${m.votes.length})`)
const ev = eventsForTraining([{ voter: 'd1:aaaaaaaaaaaaaaaa', kind: 'pass', a: 'A', b: 'C', createdAt: '2026-10-11T10:00:00.000Z', signals: { policy: { m: 'explore' } } }], m.alias)
ok(ev.length === 1 && ev[0].user === 'did:plc:x' && ev[0].signals.policy.m === 'explore', 'export events feed train-screening under the canonical voter')
const pages = { '': { votes: [{ x: 1 }], next: 'c1' }, c1: { votes: [{ x: 2 }], next: null } }
const got = await fetchExport('https://api.test', 'votes', { fetchImpl: async (u) => ({ ok: true, json: async () => pages[new URL(u).searchParams.get('cursor') || ''] }) })
ok(got.length === 2, 'fetchExport follows the cursor')
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
