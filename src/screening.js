// The screening program, unfrozen (framework, GATED). Every constant that decides what you are shown and how a pick
// counts lives here, with its current value as the default and hard bounds. data/screening-params.json (written by
// tally/train-screening.mjs) may override them ONLY when its gate passed (>= 500 logged sessions AND the learned values
// beat the baseline on held-out data); otherwise the client and the tally use these defaults (a dry run).
//
// The pair choice as one differentiable program (handwired Circuit, src/vendor/handwired):
//   w(pair)   = (a * close*unc + b * fresh + c * struct_sim) * seen          (tally pairs.json weight; same-comic never)
//   Z         = a * S_cu + b * S_fr + c * S_st     (the same sum over the candidate set, logged with each pick)
//   pi(mode)  = mix[mode]                          (For you / Training / Explore)
//   pi(pick)  = pi(mode) * w / Z  for a Training pick, pi(mode) * logged within-mode propensity otherwise
// The circuit computes w, Z and pi(mode) from parameter cells and logged inputs; d/dtheta comes from its backward pass
// and the ratio's gradient is chained on the host (hand-derived). Engagement and information are learned off-policy
// from logged sessions with a self-normalised inverse-propensity estimate (logged propensity = the policy that ran).
import { Circuit, asWire } from './vendor/handwired/numeric-ui-core.ts'

export const SCREEN_VERSION = 'screen-1'
// [default, min, max]
export const PARAMS = {
  pairCloseUnc: [0.4, 0.05, 1], pairFresh: [0.3, 0.05, 1], pairStruct: [0.3, 0.05, 1],
  mixForyou: [0.4, 0.1, 0.8], mixTraining: [0.4, 0.1, 0.8], mixExplore: [0.2, 0.1, 0.6],
  coldTraining: [0.55, 0.2, 0.8], coldExplore: [0.45, 0.2, 0.8],
  snapMult: [1.25, 1, 1.6], slowMult: [0.7, 0.4, 1], strongMult: [1.4, 1, 2], skipLoss: [0.3, 0.1, 0.6], clipSkipLoss: [0.4, 0.1, 0.7],
  snapMs: [1500, 800, 3000], slowMs: [12000, 6000, 20000],
  simStyle: [0.25, 0.05, 0.5], simOps: [0.25, 0.05, 0.5], simTopic: [0.15, 0.05, 0.4], simSty: [0.15, 0.05, 0.4], simArch: [0.15, 0.05, 0.4], simMary: [0.05, 0, 0.2],
  watchGateSec: [30, 20, 45], watchGateFrac: [0.8, 0.6, 0.95],
  capMobileSec: [75, 45, 150], capDesktopSec: [150, 75, 300], minWindowSec: [30, 30, 60],
  introMs: [2500, 1500, 4000], ballotMs: [7000, 5000, 10000], ballotResumeMs: [2500, 1500, 4000],
}
export const DEFAULTS = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v[0]]))
export const MIN_SESSIONS = 500
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
export function bound(params) {
  const o = { ...DEFAULTS }
  for (const [k, [, lo, hi]] of Object.entries(PARAMS)) if (Number.isFinite(+params?.[k])) o[k] = clamp(+params[k], lo, hi)
  for (const g of [['mixForyou', 'mixTraining', 'mixExplore'], ['coldTraining', 'coldExplore']]) { const z = g.reduce((s, k) => s + o[k], 0); for (const k of g) o[k] = o[k] / z }
  o.minWindowSec = Math.max(30, o.minWindowSec) // never under 30 s of play
  return o
}
// the file -> the params the client/tally use. Applied only when the gate passed; else the defaults (dry run).
export function resolveParams(file) {
  const ok = file && typeof file === 'object' && file.apply === true && file.gate?.passed === true && (file.gate?.sessions || 0) >= MIN_SESSIONS && file.params
  return { params: ok ? bound(file.params) : { ...DEFAULTS }, applied: !!ok, version: ok ? String(file.version || SCREEN_VERSION) : SCREEN_VERSION + '-default' }
}

// ---------- the differentiable pair-choice program ----------
// source: theta[6] (a, b, c, mixForyou, mixTraining, mixExplore) | f[3] (chosen pair: close*unc*seen, fresh*seen, struct*seen) | S[3] (candidate sums) | mode one-hot[3]
export const THETA = ['pairCloseUnc', 'pairFresh', 'pairStruct', 'mixForyou', 'mixTraining', 'mixExplore']
const MODES = ['foryou', 'training', 'explore']
let PROG = null
export function program() {
  if (PROG) return PROG
  const N = 6 + 3 + 3 + 3, c = new Circuit(N), W = (i) => asWire(i)
  for (let i = 0; i < 6; i++) c.assumeRange(W(i), 0, 1)
  for (let i = 12; i < 15; i++) c.assumeRange(W(i), 0, 1)
  const w = c.affine([0, 1, 2].map((k) => [c.multiply(W(k), W(6 + k)), 1]))
  const Z = c.affine([0, 1, 2].map((k) => [c.multiply(W(k), W(9 + k)), 1]))
  const mix = c.affine([0, 1, 2].map((k) => [c.multiply(W(3 + k), W(12 + k)), 1])) // one-hot select of the mode's share
  const mixZ = c.affine([[W(3), 1], [W(4), 1], [W(5), 1]])
  PROG = { circuit: c, N, out: { w, Z, mix, mixZ }, width: N + c.operations.length }
  return PROG
}
function src(theta, s) {
  const x = new Float32Array(program().N)
  THETA.forEach((k, i) => { x[i] = theta[k] })
  for (let k = 0; k < 3; k++) { x[6 + k] = clamp(s.f?.[k] || 0, 0, 1e6); x[9 + k] = clamp(s.z?.[k] || 0, 0, 1e6) }
  const mi = MODES.indexOf(s.mode); if (mi >= 0) x[12 + mi] = 1
  return x
}
// pi_theta(logged pick) and d pi / d theta (via the circuit's backward pass + the quotient rule)
export function policyProb(theta, s) {
  const P = program(), vals = P.circuit.evaluateReference(src(theta, s)), O = P.out
  const grad = (wire) => { const og = new Float32Array(P.width); og[wire] = 1; return P.circuit.backpropagateReference(vals, og).subarray(0, 6) }
  const mix = vals[O.mix], mixZ = vals[O.mixZ] || 1, pm = mix / mixZ
  const gMix = grad(O.mix), gMixZ = grad(O.mixZ), dpm = THETA.map((_, i) => (gMix[i] * mixZ - mix * gMixZ[i]) / (mixZ * mixZ))
  if (s.mode === 'training' && (s.z?.[0] || s.z?.[1] || s.z?.[2])) {
    const w = vals[O.w], Z = vals[O.Z] || 1e-9, pp = w / Z, gw = grad(O.w), gZ = grad(O.Z)
    const dpp = THETA.map((_, i) => (gw[i] * Z - w * gZ[i]) / (Z * Z))
    return { p: pm * pp, grad: THETA.map((_, i) => dpm[i] * pp + pm * dpp[i]) }
  }
  const pp = clamp(Number.isFinite(s.pp) ? s.pp : 1, 1e-6, 1) // within-mode choice not modelled: the logged propensity (cancels in the ratio)
  return { p: pm * pp, grad: dpm.map((g) => g * pp) }
}
// engagement + information of one logged session (0..~3)
export function reward(s) {
  return (s.voted ? 1 : 0) + 0.5 * (s.finishedBoth ? 1 : 0) + 0.5 * (s.returnedNextDay ? 1 : 0) + 0.5 * (s.voted && Number.isFinite(s.info) ? s.info : 0)
}
// self-normalised IPS estimate of the reward under theta, and its gradient
export function snips(theta, sessions) {
  let num = 0, den = 0; const gn = THETA.map(() => 0), gd = THETA.map(() => 0)
  for (const s of sessions) {
    const mu = clamp(s.mu, 1e-4, 1), { p, grad } = policyProb(theta, s), r = reward(s), wt = Math.min(p / mu, 20) // clipped importance weight
    num += wt * r; den += wt
    if (p / mu < 20) grad.forEach((g, i) => { gn[i] += (g / mu) * r; gd[i] += g / mu })
  }
  const v = den ? num / den : 0
  return { v, grad: THETA.map((_, i) => (den ? (gn[i] * den - num * gd[i]) / (den * den) : 0)), ess: den }
}
// projected gradient ascent on the pair weights + mode mix, within the bounds
export function train(sessions, { iters = 200, lr = 0.05, start = DEFAULTS } = {}) {
  let th = bound(start)
  for (let it = 0; it < iters; it++) {
    const { grad } = snips(th, sessions), next = { ...th }
    THETA.forEach((k, i) => { next[k] = th[k] + lr * clamp(grad[i], -1, 1) })
    th = bound(next)
  }
  return th
}
