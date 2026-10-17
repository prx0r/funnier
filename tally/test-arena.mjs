// arena.json (funnygraph ARENA_BALLOT.md shape) from merged votes. Usage (from funnier/): node tally/test-arena.mjs
import { arenaPairs, arenaDoc } from './arena.mjs'
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const byId = { n1: { comic: 'Norm Macdonald' }, n2: { comic: 'Norm Macdonald' }, l1: { comic: 'Louis C.K.' }, z1: { comic: 'Zakir Khan' }, x1: { comic: 'Mystery' } }
const fg = (n) => ({ 'Norm Macdonald': 'norm-macdonald', 'Louis C.K.': 'louis-ck', 'Zakir Khan': 'zakir-khan' }[n] || null)
const V = [
  { did: 'd1:aa', voter: 'human', a: 'n1', b: 'l1', winner: 'n1' },
  { did: 'd1:bb', voter: 'human', a: 'l1', b: 'n2', winner: 'l1' },
  { did: 'did:plc:c', voter: 'human', a: 'n2', b: 'l1', winner: 'n2' },
  { did: 'did:plc:bot', voter: 'agent', a: 'n1', b: 'l1', winner: 'l1' },
  { did: 'd1:aa', voter: 'human', a: 'n1', b: 'n2', winner: 'n1' },
  { did: 'd1:aa', voter: 'human', a: 'z1', b: 'x1', winner: 'z1' },
  { did: 'd1:aa', voter: 'human', a: 'z1', b: 'l1', winner: 'z1' },
]
const r = arenaPairs(V, byId, fg)
const nl = r.pairs.find((p) => p.a === 'louis-ck' && p.b === 'norm-macdonald')
ok(nl && nl.a_wins === 1 && nl.b_wins === 2 && nl.n === 3, 'per-pair counts, a < b alphabetically (louis-ck 1, norm 2)')
ok(!r.pairs.some((p) => p.a === p.b), 'same-comic votes never counted')
ok(r.votes === 4 && r.voters === 3, 'humans only (agent vote excluded): 4 votes from 3 voters')
ok(r.unmapped.join() === 'Mystery', 'comics without a funnygraph id are reported, not guessed')
ok(r.pairs.every((p) => ['a', 'b', 'a_wins', 'b_wins', 'n'].every((k) => k in p) && p.a_wins + p.b_wins === p.n), 'every pair has {a,b,a_wins,b_wins,n} and adds up')
const d = arenaDoc(r, { updated: 'now', fgSha7: 'abc1234' })
ok(d.schema === 'funnygraph.arena/v1' && !JSON.stringify(d).includes('d1:') && !JSON.stringify(d).includes('did:'), 'published doc carries no voter identifiers')
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
