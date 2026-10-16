// Funnier humour engine v2: an interpretable, per-user model of what one person finds funny.
// Pure (no DOM, no storage): bundled into site/app.js, imported by tally/tally.mjs and tools/test-humour-engine.mjs.
//
// Built on chenglou/handwired (src/vendor/handwired, MIT): the whole model is ONE numeric program, i.e. affine sums and
// ReGLU products over float32 cells, so it stays exact AND differentiable end to end.
//
//   clip --(frozen feature program)--> phi(clip): a named, human-readable feature vector
//        if the clip has its own bit-level operator mix use it, else its special's, else its comic's    (circuit.select)
//        operator lift over the roster mean, clamped to 0..1                                             (relu - relu)
//        humour axes = style tags + 0.35 x (delivery-archetype prior + operator prior), clamped
//        energy / punchline hold / pace (stylometry) centred to -1..1 where measured, else 0             (select)
//        setting (talk show), format (Shorts), length (longer clips)
//   taste  s(clip) = sum_k w_k * phi_k(clip)                                                            (ReGLU products)
//   heads  pair:   logit P(A funnier than B) = s(A) - s(B) + beta * (crowd(A) - crowd(B))
//          laugh:  logit P(rewound / laughed)  = aL + gL * s(clip)      (seek-backs are the laugh label; laughs disabled)
//          finish: logit P(watched to the end) = aF + gF * s(clip)
//          skip:   logit P(skipped)            = aS - gS * s(clip)
// The program's constants (roster operator mean, prior mix, lift scale) are source cells too: frozen by default, and
// `unfreeze` lets the same backward pass train them. Training is MAP with a Gaussian prior: the crowd prior (or an
// imported Humour Passport) as the mean, per-group precisions as shrinkage, diagonal Gauss-Newton steps from the
// program's own gradients (backpropagateReference). The diagonal curvature doubles as a Laplace posterior, so every
// weight has a standard deviation, which becomes the uncertainty band and the confidence shown per axis.
import { Circuit, asWire } from './vendor/handwired/numeric-ui-core.ts'

export const ENGINE_MODEL = 'funnier-engine/2.0'
export const OPS = ['split_knowledge', 'repeat_variation', 'double_interpret', 'status_invert', 'rigidify', 'juxtapose', 'literalize', 'mistake_identity',
  'literalize_or_other', 'expose_self_blindness', 'false_analogy', 'identity_contradict', 'unmask', 'role_reverse', 'character_violation']
export const OP_LABEL = {
  split_knowledge: 'dramatic irony', repeat_variation: 'callbacks', double_interpret: 'double meanings', status_invert: 'status flips',
  rigidify: 'mechanical logic', juxtapose: 'odd pairings', literalize: 'taking it literally', mistake_identity: 'mistaken identity',
  literalize_or_other: 'literal-minded turns', expose_self_blindness: 'people blind to themselves', false_analogy: 'bogus logic',
  identity_contradict: 'self-contradiction', unmask: 'unmasking pretence', role_reverse: 'role reversals', character_violation: 'breaking type',
}
// the humour-chart axes (keys match src/humour.js DIMS)
export const AXES = [
  { k: 'absurd', tag: 'absurd', label: 'anti-jokes / absurdity', noun: 'anti-joke' },
  { k: 'deadpan', tag: 'deadpan', label: 'deadpan', noun: 'deadpan bit' },
  { k: 'observational', tag: 'observational', label: 'observational', noun: 'observational bit' },
  { k: 'dark', tag: 'dark', label: 'dark turns', noun: 'dark bit' },
  { k: 'story', tag: 'storytelling', label: 'storytelling', noun: 'story' },
  { k: 'wordplay', tag: 'one-liners', label: 'one-liners & wordplay', noun: 'one-liner' },
  { k: 'rant', tag: 'rant', label: 'rants', noun: 'rant' },
  { k: 'selfdep', tag: 'self-deprecating', label: 'self-roasts', noun: 'self-roast' },
  { k: 'crowd', tag: 'crowd-work', label: 'crowd work', noun: 'crowd work' },
]
// characters2 delivery archetypes -> axes, and operators (lift) -> axes: the soft prior behind each axis
export const ARCH = {
  suspension_deadpan: { deadpan: 1, absurd: 0.6 },
  sincere_storyteller: { story: 1, selfdep: 0.6 },
  observational_auditor: { observational: 1, wordplay: 0.4 },
  mock_indignant_engine: { rant: 1, dark: 0.3 },
}
export const OPDIM = {
  double_interpret: { wordplay: 1 }, literalize: { wordplay: 0.8, absurd: 0.3 }, literalize_or_other: { wordplay: 0.6 },
  juxtapose: { absurd: 0.8, observational: 0.3 }, false_analogy: { absurd: 0.8 }, rigidify: { observational: 0.8 },
  status_invert: { rant: 0.7, selfdep: 0.3 }, expose_self_blindness: { selfdep: 0.8, observational: 0.3 }, unmask: { rant: 0.5, dark: 0.3 },
  repeat_variation: { story: 0.5 }, split_knowledge: { deadpan: 0.3, story: 0.3 }, mistake_identity: { absurd: 0.4 }, role_reverse: { absurd: 0.4 },
}
const ARCHS = Object.keys(ARCH)
// the named feature vector. group decides the prior precision (shrinkage) and where it shows up
export const FEATURES = [
  ...AXES.map((a) => ({ k: 'ax_' + a.k, group: 'axis', axis: a.k, label: a.label })),
  ...OPS.map((op) => ({ k: 'op_' + op, group: 'op', op, label: OP_LABEL[op] })),
  { k: 'energy', group: 'sty', label: 'high energy', lo: 'low-key delivery' },
  { k: 'hold', group: 'sty', label: 'long pauses', lo: 'quick-fire delivery' },
  { k: 'pace', group: 'sty', label: 'punchy, short sentences', lo: 'wordy delivery' },
  { k: 'talkshow', group: 'meta', label: 'talk-show sets' },
  { k: 'vertical', group: 'meta', label: 'Shorts' },
  { k: 'long', group: 'meta', label: 'longer clips' },
  { k: 'clean', group: 'meta', label: 'clean material' },
]
export const FK = FEATURES.map((f) => f.k)
const NF = FEATURES.length
// prior precision per group (1 / variance of a weight before any vote): operators are many and noisy, so shrink harder
export const PRIOR_PREC = { axis: 2.5, op: 5, sty: 3, meta: 4 }
// the heads' extra parameters: [name, prior mean, prior precision]. gamma = how much each signal is explained by taste
export const HEADS = [['beta', 1, 4], ['gL', 0.6, 8], ['gF', 0.3, 10], ['gS', 0.3, 10], ['aL', -1.5, 2], ['aF', 1, 2], ['aS', -1.5, 2]]
// frozen program constants (unfreezable): roster operator mean (15), prior mix, lift scale
export const CONSTS = [...OPS.map((op) => 'mean_' + op), 'priorMix', 'liftScale']
const NC = CONSTS.length

// ---------- raw clip inputs (host side: just reading clips.json / theory.json, no decisions) ----------
// layout: tags[10] arch[4] hasBits bitOps[15] hasSpecial spOps[15] comicOps[15] energy hasEnergy hold hasHold pace hasPace talkshow vertical sec crowd
const TAGS = [...AXES.map((a) => a.tag), 'clean']
const R = (() => { let i = 0; const o = {}; const at = (k, n = 1) => { o[k] = i; i += n }
  at('tags', TAGS.length); at('arch', ARCHS.length); at('hasBits'); at('bitOps', 15); at('hasSpecial'); at('spOps', 15); at('comicOps', 15)
  at('energy'); at('hasEnergy'); at('hold'); at('hasHold'); at('pace'); at('hasPace'); at('talkshow'); at('vertical'); at('sec'); at('crowd'); o.N = i; return o })()
export const RAW_N = R.N
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const arr = (x) => (Array.isArray(x) ? x : [])
const fin = (x) => Number.isFinite(x)
export function rawClip(c, T = {}, crowd = 0) {
  const x = new Float32Array(R.N)
  if (!c) return x
  const st = arr(c.style)
  TAGS.forEach((t, i) => { if (st.includes(t)) x[R.tags + i] = 1 })
  const C = T?.comics?.[c.comic], ai = ARCHS.indexOf(C?.archetype)
  if (ai >= 0) x[R.arch + ai] = 1
  const sp = c.special_id ? T?.specials?.[c.special_id] : null
  if (c.ops && typeof c.ops === 'object') { x[R.hasBits] = 1; OPS.forEach((op, i) => { x[R.bitOps + i] = clamp(+c.ops[op] || 0, 0, 1) }) }
  if (sp?.ops) { x[R.hasSpecial] = 1; OPS.forEach((op, i) => { x[R.spOps + i] = clamp(+sp.ops[op] || 0, 0, 1) }) }
  if (C?.ops) OPS.forEach((op, i) => { x[R.comicOps + i] = clamp(+C.ops[op] || 0, 0, 1) })
  if (C && fin(C.energy)) { x[R.energy] = clamp(C.energy, 0, 1); x[R.hasEnergy] = 1 }
  if (C && fin(C.holdMs)) { x[R.hold] = clamp((C.holdMs - 400) / 1600, 0, 1); x[R.hasHold] = 1 }
  const sty = sp?.sty || C?.sty, sc = T?.styScale?.short_sent_frac
  if (sty && sc && fin(sty.short_sent_frac)) { x[R.pace] = clamp(0.5 + (sty.short_sent_frac - sc.mean) / (4 * (sc.sd || 1)), 0, 1); x[R.hasPace] = 1 }
  if (c.setting === 'talk-show') x[R.talkshow] = 1
  if (c.format === 'vertical') x[R.vertical] = 1
  x[R.sec] = clamp(Number(c.dur || c.sec) || 60, 0, 36000)
  x[R.crowd] = clamp(Number(crowd) || 0, -6, 6)
  return x
}
export function meanRaw(list) { // float64 sums, kept within each cell's observed min..max (float32 rounding can overshoot 1)
  const x = new Float32Array(R.N); if (!list.length) return x
  for (let i = 0; i < R.N; i++) {
    let s = 0, lo = Infinity, hi = -Infinity
    for (const r of list) { s += r[i]; if (r[i] < lo) lo = r[i]; if (r[i] > hi) hi = r[i] }
    x[i] = Math.min(hi, Math.max(lo, Math.fround(s / list.length)))
  }
  return x
}

// ---------- the program ----------
// source table: rawA[RAW_N] rawB[RAW_N] consts[NC] w[NF] heads[7]
export const SRC = { A: 0, B: R.N, C: 2 * R.N, W: 2 * R.N + NC, H: 2 * R.N + NC + NF, N: 2 * R.N + NC + NF + HEADS.length }
const W = (i) => asWire(i)
function buildProgram() {
  const c = new Circuit(SRC.N)
  const bit = (i) => c.assumeRange(W(i), 0, 1)
  for (const base of [SRC.A, SRC.B]) {
    for (let i = 0; i < TAGS.length; i++) bit(base + R.tags + i)
    for (let i = 0; i < ARCHS.length; i++) bit(base + R.arch + i)
    for (const k of ['hasBits', 'hasSpecial', 'hasEnergy', 'hasHold', 'hasPace', 'talkshow', 'vertical']) bit(base + R[k])
    for (let i = 0; i < 15; i++) { bit(base + R.bitOps + i); bit(base + R.spOps + i); bit(base + R.comicOps + i) }
  }
  const zero = c.constant(0)
  const clamp01 = (x) => c.affine([[c.reglu([], 1, [[x, 1]], 0), 1], [c.reglu([], 1, [[x, 1]], -1), -1]]) // relu(x) - relu(x - 1)
  const mean = (i) => W(SRC.C + i), priorMix = W(SRC.C + 15), liftScale = W(SRC.C + 16)
  const phi = (base) => {
    const r = (k, i = 0) => W(base + R[k] + i)
    // if (hasBits) bit ops; else if (hasSpecial) special ops; else comic ops
    const lift = OPS.map((_, i) => {
      const ops = c.select(r('hasBits'), c.select(r('hasSpecial'), r('comicOps', i), r('spOps', i)), r('bitOps', i))
      return clamp01(c.multiply(c.affine([[ops, 1], [mean(i), -1]]), liftScale))
    })
    const axes = AXES.map((a, ai) => {
      const terms = []
      ARCHS.forEach((ar, j) => { const v = ARCH[ar][a.k]; if (v) terms.push([r('arch', j), v]) })
      OPS.forEach((op, j) => { const v = OPDIM[op]?.[a.k]; if (v) terms.push([lift[j], v]) })
      const prior = terms.length ? clamp01(c.affine(terms)) : zero
      return clamp01(c.affine([[r('tags', ai), 1], [c.multiply(prior, priorMix), 1]]))
    })
    const centred = (v, has) => c.select(r(has), zero, c.affine([[r(v), 2]], -1)) // if (has) 2v - 1 else 0
    return [...axes, ...lift, centred('energy', 'hasEnergy'), centred('hold', 'hasHold'), centred('pace', 'hasPace'),
      r('talkshow'), r('vertical'), clamp01(c.affine([[r('sec'), 1 / 240]], -45 / 240)), r('tags', TAGS.length - 1)]
  }
  const phiA = phi(SRC.A), phiB = phi(SRC.B)
  const taste = (ph) => c.affine(ph.map((f, k) => [c.multiply(f, W(SRC.W + k)), 1]))
  const sA = taste(phiA), sB = taste(phiB)
  const h = Object.fromEntries(HEADS.map(([k], i) => [k, W(SRC.H + i)]))
  const crowdDiff = c.affine([[W(SRC.A + R.crowd), 1], [W(SRC.B + R.crowd), -1]])
  const out = {
    pair: c.affine([[sA, 1], [sB, -1], [c.multiply(h.beta, crowdDiff), 1]]),
    laugh: c.affine([[c.multiply(h.gL, sA), 1], [h.aL, 1]]),
    finish: c.affine([[c.multiply(h.gF, sA), 1], [h.aF, 1]]),
    skip: c.affine([[c.multiply(h.gS, sA), -1], [h.aS, 1]]),
  }
  // fast paths: the compiled tensor program gives the same values as evaluateReference (checked in the test)
  const heads = c.createTensorEvaluator([out.pair, out.laugh, out.finish, out.skip])
  return { circuit: c, phiA, phiB, sA, sB, out, heads, width: SRC.N + c.operations.length }
}
let PROGRAM = null
export const program = () => (PROGRAM = PROGRAM || buildProgram())

// ---------- parameters ----------
export function defaultConsts(T = {}) {
  const m = T?.opsMean || {}
  return Float32Array.from([...OPS.map((op) => +m[op] || 0), 0.35, 5])
}
// theta = [w (NF), heads (7)]; prior = { mu, prec } of the same length
export function basePrior(crowdW = null) {
  const mu = new Float64Array(NF + HEADS.length), prec = new Float64Array(NF + HEADS.length)
  FEATURES.forEach((f, k) => { mu[k] = Number.isFinite(crowdW?.[f.k]) ? clamp(crowdW[f.k], -2, 2) : 0; prec[k] = PRIOR_PREC[f.group] })
  HEADS.forEach(([, m, p], i) => { mu[NF + i] = m; prec[NF + i] = p })
  return { mu, prec }
}
// merge an imported passport (weights + their sd) into a prior: precision-weighted, discounted (it is someone's
// past self on another device, not this device's evidence), so new votes still move it
export function mergePrior(prior, weights = {}, sd = {}, discount = 0.5) {
  const mu = Float64Array.from(prior.mu), prec = Float64Array.from(prior.prec)
  FEATURES.forEach((f, k) => {
    const w = weights[f.k]; if (!Number.isFinite(w)) return
    const s = Number.isFinite(sd[f.k]) && sd[f.k] > 0.05 ? sd[f.k] : 1 / Math.sqrt(prec[k])
    const p2 = discount / (s * s)
    mu[k] = (prec[k] * mu[k] + p2 * clamp(w, -3, 3)) / (prec[k] + p2); prec[k] += p2
  })
  return { mu, prec }
}
export const thetaFromPrior = (prior) => Float64Array.from(prior.mu)

// ---------- evaluation and gradients through the program ----------
function source(A, B, theta, consts) {
  const s = new Float32Array(SRC.N)
  s.set(A, SRC.A); if (B) s.set(B, SRC.B)
  s.set(consts, SRC.C)
  for (let i = 0; i < NF + HEADS.length; i++) s[SRC.W + i] = theta[i]
  return s
}
const sig = (z) => 1 / (1 + Math.exp(-z))
const softplus = (z) => (z > 30 ? z : Math.log1p(Math.exp(z)))
// one sample: { kind: pair|laugh|finish|skip, A: raw, B: raw|null, y: 0|1, c: weight }
export function forward(sample, theta, consts, reference = false) {
  const P = program(), src = source(sample.A, sample.B, theta, consts)
  const vals = reference ? P.circuit.evaluateReference(src) : P.circuit.evaluateTensor(src)
  return { vals, z: vals[P.out[sample.kind]] }
}
const HEAD_I = { pair: 0, laugh: 1, finish: 2, skip: 3 }
function headZ(sample, theta, consts) { return program().heads(source(sample.A, sample.B, theta, consts))[HEAD_I[sample.kind]] }
export function phiOf(rawA, consts, theta = null) {
  const P = program(), vals = P.circuit.evaluateReference(source(rawA, null, theta || new Float64Array(NF + HEADS.length), consts))
  return Array.from(P.phiA, (wv) => vals[wv])
}
export const logitPair = (A, B, theta, consts) => forward({ kind: 'pair', A, B }, theta, consts).z
// d z / d (theta, consts) for one sample, read off the program's backward pass
function jacobian(sample, theta, consts) {
  const P = program(), { vals, z } = forward(sample, theta, consts)
  const og = new Float32Array(P.width); og[P.out[sample.kind]] = 1
  const g = P.circuit.backpropagateReference(vals, og)
  return { z, gTheta: g.subarray(SRC.W, SRC.W + NF + HEADS.length), gConst: g.subarray(SRC.C, SRC.C + NC) }
}
export function loss(samples, theta, consts, prior) {
  let L = 0
  for (const s of samples) { const z = headZ(s, theta, consts); L += s.c * (s.y ? softplus(-z) : softplus(z)) }
  for (let i = 0; i < theta.length; i++) L += 0.5 * prior.prec[i] * (theta[i] - prior.mu[i]) ** 2
  return L
}
// MAP fit by Gauss-Newton with backtracking, warm-started from theta0. The taste weights and heads are few (38), so the
// step uses the FULL curvature (H = prior precision + sum_i c_i p_i (1 - p_i) J_i J_i^T, Cholesky-solved); J_i is read
// off the program's backward pass. The inverse of H at the optimum is the Laplace posterior: its diagonal gives each
// weight's sd (correlated features share their evidence honestly). Unfrozen program constants take diagonal steps.
// Returns theta, sd per parameter, per-feature support (summed weight of the samples that moved it), loss and consts.
export function fit(samples, prior, theta0, consts, { iters = 8, unfreeze = false, constPrec = 50, consts0 = null } = {}) {
  let theta = Float64Array.from(theta0 || prior.mu), K = Float32Array.from(consts)
  const K0 = consts0 || consts, nT = theta.length
  let L = loss(samples, theta, K, prior), H = null
  const support = new Float64Array(NF)
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(nT), h = new Float64Array(nT * nT), gc = new Float64Array(NC), hc = new Float64Array(NC).fill(constPrec)
    for (let i = 0; i < nT; i++) { g[i] = prior.prec[i] * (theta[i] - prior.mu[i]); h[i * nT + i] = prior.prec[i] }
    if (unfreeze) for (let i = 0; i < NC; i++) gc[i] = constPrec * (K[i] - K0[i])
    if (it === 0) support.fill(0)
    const nz = []
    for (const s of samples) {
      const { z, gTheta, gConst } = jacobian(s, theta, K), p = sig(z), e = s.c * (p - s.y), f = s.c * p * (1 - p)
      nz.length = 0
      for (let i = 0; i < nT; i++) { const j = gTheta[i]; if (j) { nz.push(i); g[i] += e * j; if (it === 0 && i < NF && Math.abs(j) > 0.05) support[i] += s.c } }
      for (const i of nz) { const fi = f * gTheta[i]; for (const k of nz) h[i * nT + k] += fi * gTheta[k] }
      if (unfreeze) for (let i = 0; i < NC; i++) { const j = gConst[i]; if (j) { gc[i] += e * j; hc[i] += f * j * j } }
    }
    H = h
    const step = cholSolve(h, g, nT)
    let eta = 1, improved = false
    for (let bt = 0; bt < 6; bt++) {
      const t2 = theta.map((x, i) => x - eta * clamp(step[i], -2, 2))
      clampHeads(t2)
      const K2 = unfreeze ? K.map((x, i) => x - eta * gc[i] / hc[i]) : K
      const L2 = loss(samples, t2, K2, prior)
      if (L2 <= L + 1e-9) { theta = t2; K = Float32Array.from(K2); improved = L - L2 > 1e-6; L = L2; break }
      eta /= 2
    }
    if (!improved) break
  }
  let sd
  if (H) { const inv = cholInverseDiag(H, nT); sd = Array.from(inv, (x) => Math.sqrt(Math.max(x, 1e-12))) } else sd = Array.from(prior.prec, (x) => 1 / Math.sqrt(x))
  return { theta, sd, support: Array.from(support), loss: L, consts: K }
}
function chol(A, n) { // lower-triangular L with A = L L^T (A is SPD: prior precision + PSD Gauss-Newton)
  const L = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j]; for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k]
    L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j]
  }
  return L
}
function cholSolve(A, b, n) {
  const L = chol(A, n), y = new Float64Array(n), x = new Float64Array(n)
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i] }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i] }
  return x
}
function cholInverseDiag(A, n) { // diag(A^-1), column by column
  const out = new Float64Array(n), e = new Float64Array(n)
  const L = chol(A, n), y = new Float64Array(n), x = new Float64Array(n)
  for (let c = 0; c < n; c++) {
    e.fill(0); e[c] = 1
    for (let i = 0; i < n; i++) { let s = e[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i] }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i] }
    out[c] = x[c]
  }
  return out
}
function clampHeads(t) { // gammas stay non-negative and sane; beta (trust in the crowd) within 0..3
  t[NF] = clamp(t[NF], 0, 3)
  for (let i = 1; i <= 3; i++) t[NF + i] = clamp(t[NF + i], 0, 2)
  for (let i = 0; i < NF; i++) t[i] = clamp(t[i], -4, 4)
}

// ---------- samples from the app's own records ----------
// data: { votes: [{a, b, winner, w, signals}], skips: [{clip, w}], favs: [comic], clips: {id: clip} }
// raw(id) -> raw input row. Pair votes are the main label; seek-backs (rewinds) = the laugh label; skips and finishes
// are weaker labels for their own heads.
export const SIGNAL_W = { laugh: 0.5, laughNeg: 0.1, finish: 0.1, skipNeg: 0.1, fav: 0.6 }
export function buildSamples({ votes = [], skips = [], favs = [], clips = {} }, raw, { favRaw = null } = {}) {
  const S = []
  for (const v of votes) {
    if (!clips[v.a] || !clips[v.b] || (v.winner !== v.a && v.winner !== v.b)) continue
    const L = v.winner === v.a ? v.b : v.a, c = Number.isFinite(v.w) ? clamp(v.w, 0.1, 3) : 1
    S.push({ kind: 'pair', A: raw(v.winner), B: raw(L), y: 1, c, ref: v })
    const sg = v.signals || v
    for (const [side, id] of [['left', v.a], ['right', v.b]]) {
      const seeks = arr(sg[side + 'SeekTargets']).length, skipped = !!sg[side + 'Skipped']
      if (seeks) S.push({ kind: 'laugh', id, A: raw(id), B: null, y: 1, c: Math.min(1, SIGNAL_W.laugh * seeks) })
      else if (!skipped) S.push({ kind: 'laugh', id, A: raw(id), B: null, y: 0, c: SIGNAL_W.laughNeg })
      const done = side === 'right' ? (Number.isFinite(sg.rightFrac) ? sg.rightFrac >= 0.8 : Number.isFinite(sg.rightPct) ? sg.rightPct >= 80 : !skipped) : !skipped
      S.push({ kind: 'finish', id, A: raw(id), B: null, y: done ? 1 : 0, c: SIGNAL_W.finish })
      if (!skipped) S.push({ kind: 'skip', id, A: raw(id), B: null, y: 0, c: SIGNAL_W.skipNeg })
    }
  }
  for (const k of skips) if (clips[k.clip]) S.push({ kind: 'skip', id: k.clip, A: raw(k.clip), B: null, y: 1, c: Number.isFinite(k.w) ? k.w : 0.3, ref: k })
  if (favRaw) for (const name of arr(favs).slice(0, 4)) { const r = favRaw(name); if (r) S.push({ kind: 'pair', A: r.comic, B: r.roster, y: 1, c: SIGNAL_W.fav, fav: name }) }
  // one row per (head, clip, label): same inputs, summed weight (keeps training fast as the history grows)
  const out = [], seen = new Map()
  for (const s of S) {
    if (s.kind === 'pair' || !s.id) { out.push(s); continue }
    const k = s.kind + '|' + s.id + '|' + s.y
    if (seen.has(k)) seen.get(k).c += s.c; else { const t = { ...s }; seen.set(k, t); out.push(t) }
  }
  return out
}

// ---------- reading the weights: axes, confidence, explanations ----------
const pct = (w) => 50 + 50 * Math.tanh(w)
// confidence = how far the votes have narrowed a weight from its prior: sd / prior sd
export function confidenceOf(sd, priorSd = 0.63) { const r = sd / priorSd; return r >= 0.85 ? 'low' : r >= 0.6 ? 'medium' : 'high' }
const PRIOR_SD = FEATURES.map((f) => 1 / Math.sqrt(PRIOR_PREC[f.group]))
// theta + sd -> what the chart and the profile show: 0..100 per feature with a band (w +- 1 sd)
export function readout(theta, sd, support = []) {
  const f = {}
  FEATURES.forEach((F, k) => {
    const w = theta[k], s = sd[k] ?? 1
    f[F.k] = { w: Math.round(w * 1000) / 1000, sd: Math.round(s * 1000) / 1000, v: Math.round(pct(w)), lo: Math.round(pct(w - s)), hi: Math.round(pct(w + s)), n: Math.round((support[k] || 0) * 10) / 10, conf: confidenceOf(s, PRIOR_SD[k]) }
  })
  const heads = Object.fromEntries(HEADS.map(([k], i) => [k, Math.round(theta[NF + i] * 1000) / 1000]))
  return { f, heads }
}
const featLabel = (k) => FEATURES.find((f) => f.k === k)?.label || k
// a short description of a clip from its features: "slow one-liner", "high-energy rant", "crowd work"
export function describeClip(phi) {
  const ax = AXES.map((a, i) => [phi[i], a]).sort((x, y) => y[0] - x[0])[0]
  const iE = FK.indexOf('energy'), iH = FK.indexOf('hold')
  const adj = phi[iH] >= 0.4 ? 'slow' : phi[iE] >= 0.4 ? 'high-energy' : phi[iE] <= -0.4 ? 'low-key' : ''
  let noun = ax && ax[0] >= 0.3 ? ax[1].noun : ''
  if (!noun) { const op = OPS.map((o, j) => [phi[AXES.length + j], o]).sort((x, y) => y[0] - x[0])[0]; noun = op && op[0] >= 0.5 ? OP_LABEL[op[1]] + ' bit' : 'clip' }
  return (adj && noun !== 'crowd work' ? adj + ' ' : '') + noun
}
// what one event changed: the features whose shown value moved most, in display points
export function deltas(before, after, { min = 1, top = 3 } = {}) {
  const out = []
  for (const k of FK) {
    const a = before.f[k], b = after.f[k]; if (!a || !b) continue
    const d = Math.round(10 * (pct(b.w) - pct(a.w))) / 10
    if (Math.abs(d) >= min) out.push({ k, label: featLabel(k), d })
  }
  return out.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, top)
}
export function deltaText(ds) {
  return ds.map((x) => `${x.d > 0 ? '+' : '\u2212'}${Math.round(Math.abs(x.d))}% ${x.label}`).join(', ')
}

// ---------- a convenience wrapper around one catalogue ----------
// crowd(id) -> crowd strength in logits (from the public board); prior: from basePrior/mergePrior
export function createEngine({ clips = [], theory = {}, crowd = () => 0 } = {}) {
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]))
  const consts = defaultConsts(theory), cache = new Map(), phiCache = new Map()
  const raw = (id) => { if (!cache.has(id)) cache.set(id, rawClip(byId[id], theory, crowd(id))); return cache.get(id) }
  const phi = (id) => { if (!phiCache.has(id)) phiCache.set(id, phiOf(raw(id), consts)); return phiCache.get(id) }
  const comicRaw = {}
  const informative = (c) => phi(c.id).some((x, i) => i < AXES.length + OPS.length && x > 0)
  const rosterList = () => clips.filter(informative)
  const favRaw = (name) => {
    if (!(name in comicRaw)) { const cs = clips.filter((c) => c.comic === name && informative(c)); comicRaw[name] = cs.length ? { comic: meanRaw(cs.map((c) => raw(c.id))), roster: meanRaw(rosterList().map((c) => raw(c.id))) } : null }
    return comicRaw[name]
  }
  const tasteOf = (id, theta) => { const p = phi(id); let s = 0; for (let k = 0; k < NF; k++) s += theta[k] * p[k]; return s }
  return {
    byId, consts, raw, phi, favRaw, tasteOf,
    samples: (data) => buildSamples({ ...data, clips: byId }, raw, { favRaw }),
    predict: (a, b, theta) => sig(logitPair(raw(a), raw(b), theta, consts)),
    fit: (samples, prior, theta0, opts) => fit(samples, prior, theta0, consts, opts),
    describe: (id) => describeClip(phi(id)),
    clearCache: () => { cache.clear(); phiCache.clear(); for (const k of Object.keys(comicRaw)) delete comicRaw[k] },
  }
}
