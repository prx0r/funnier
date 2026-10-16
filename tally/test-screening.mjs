// Screening framework tests (src/screening.js, tally/train-screening.mjs): node tally/test-screening.mjs
import * as S from '../src/screening.js'
import { buildSessions, trainScreening } from './train-screening.mjs'
import { cleanPolicy } from '../src/policy.js'
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
// 1. defaults = today's constants; bounds hold; the file is ignored unless its gate passed
ok(S.DEFAULTS.pairCloseUnc === 0.4 && S.DEFAULTS.mixExplore === 0.2 && S.DEFAULTS.ballotMs === 7000 && S.DEFAULTS.capMobileSec === 75 && S.DEFAULTS.watchGateSec === 30 && S.DEFAULTS.snapMult === 1.25, 'defaults are the current constants')
const wild = S.bound({ ballotMs: 1000, minWindowSec: 5, capMobileSec: 9999, mixForyou: 5, mixTraining: 0, mixExplore: 0 })
ok(wild.ballotMs === 5000 && wild.minWindowSec === 30 && wild.capMobileSec === 150 && Math.abs(wild.mixForyou + wild.mixTraining + wild.mixExplore - 1) < 1e-9, `bounds: ballot ${wild.ballotMs} ms, play >= ${wild.minWindowSec} s, cap ${wild.capMobileSec} s, mix sums to 1`)
ok(S.resolveParams({ apply: true, gate: { passed: false, sessions: 9999 }, params: { ballotMs: 9000 } }).params.ballotMs === 7000, 'a closed gate = defaults')
ok(S.resolveParams({ apply: true, gate: { passed: true, sessions: 100 }, params: { ballotMs: 9000 } }).params.ballotMs === 7000, 'under 500 sessions = defaults even if a file says passed')
ok(S.resolveParams({ apply: true, gate: { passed: true, sessions: 800 }, params: { ballotMs: 9000 } }).params.ballotMs === 9000 && S.resolveParams(null).applied === false && S.resolveParams('junk').params.ballotMs === 7000, 'a passed gate applies (bounded); missing/invalid file = defaults')
// 2. the program: P(pick) and its gradient (backward pass + quotient rule) match finite differences
const s0 = { mode: 'training', f: [0.6, 0.2, 0.5], z: [10, 12, 9], mu: 0.02 }, th = { ...S.DEFAULTS }
const { p, grad } = S.policyProb(th, s0)
const expect = 0.4 * (0.4 * 0.6 + 0.3 * 0.2 + 0.3 * 0.5) / (0.4 * 10 + 0.3 * 12 + 0.3 * 9)
let worst = 0; S.THETA.forEach((k, i) => { const h = 1e-4, a = { ...th, [k]: th[k] + h }, b = { ...th, [k]: th[k] - h }; worst = Math.max(worst, Math.abs((S.policyProb(a, s0).p - S.policyProb(b, s0).p) / (2 * h) - grad[i])) })
ok(Math.abs(p - expect) < 1e-6 && worst < 1e-4, `P(pick) = mix x w / Z (${p.toFixed(5)}); gradient == finite differences (max err ${worst.toExponential(1)})`)
// 3. synthetic logs: struct-heavy pairs (and Training) engage more -> the trainer finds it and the gate opens; small logs stay closed
function synth(n, seed) {
  const r = rng(seed), votes = [], events = [], t0 = Date.parse('2026-09-01T00:00:00Z')
  for (let i = 0; i < n; i++) {
    const mode = r() < 0.4 ? 'foryou' : r() < 0.667 ? 'training' : 'explore', pm = { foryou: 0.4, training: 0.4, explore: 0.2 }[mode]
    const cand = Array.from({ length: 40 }, () => [r(), r(), r()]), w = cand.map((f) => 0.4 * f[0] + 0.3 * f[1] + 0.3 * f[2]), Z = w.reduce((a, b) => a + b, 0)
    let x = r() * Z, j = 0; for (; j < 39; j++) { x -= w[j]; if (x <= 0) break }
    const f = cand[j], z = [0, 1, 2].map((k) => cand.reduce((s, c) => s + c[k], 0))
    const pv = mode === 'training' ? 0.25 + 0.6 * f[2] : mode === 'foryou' ? 0.45 : 0.35 // engagement rises with struct_sim
    const policy = { m: mode, pm: Math.round(1000 * pm), ...(mode === 'training' ? { pp: Math.round(1e6 * w[j] / Z), f: f.map((v) => Math.round(1000 * v)), z: z.map((v) => Math.round(1000 * v)) } : { pp: 1e6 }), q: Math.round(1000 * r()) }
    const rec = { user: 'u' + (i % 40), a: 'x', b: 'y', at: new Date(t0 + i * 600e3).toISOString(), signals: { policy, rightPct: r() < 0.8 ? 100 : 50 } }
    if (r() < pv) votes.push(rec); else events.push({ ...rec, kind: 'pass' })
  }
  return buildSessions(votes, events)
}
const big = synth(3000, 7), res = trainScreening(big)
ok(big.length === 3000 && big.every((s) => s.mu > 0), `sessions carry a logged propensity (${big.length})`)
ok(res.gate.passed && res.apply && res.params.pairStruct > S.DEFAULTS.pairStruct && res.params.mixTraining > S.DEFAULTS.mixTraining, `3000 sessions: gate PASSED (held-out ${res.gate.heldout.baseline} -> ${res.gate.heldout.learned}); struct ${res.params.pairStruct.toFixed(2)}, Training share ${res.params.mixTraining.toFixed(2)}`)
ok(res.params.ballotMs === 7000 && res.params.snapMult === 1.25 && res.report.notIdentifiable.includes('ballotMs'), 'timings and vote multipliers stay at defaults (not identifiable without randomised exploration)')
const small = trainScreening(synth(300, 9))
ok(!small.gate.passed && !small.apply && small.params.pairStruct === S.DEFAULTS.pairStruct && /need 500/.test(small.gate.reason), `300 sessions: dry run (${small.gate.reason}); proposal recorded ${JSON.stringify(small.proposal)}`)
const noGain = trainScreening(synth(3000, 11).map((s) => ({ ...s, voted: true, finishedBoth: true, returnedNextDay: false, info: 0.5 })))
ok(!noGain.gate.passed, `no real gain on held-out data: gate stays closed (${noGain.gate.reason})`)
ok(cleanPolicy({ m: 'training', pm: 400.4, pp: 25000, f: [1, 2, 3], z: [4, 5, 6], q: 512, v: 'screen-1-default', junk: 1 })?.pm === 400 && !cleanPolicy({ m: 'hack' }) && !('junk' in cleanPolicy({ m: 'explore', junk: 1 })), 'policy logs are sanitised (integers, known modes)')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
