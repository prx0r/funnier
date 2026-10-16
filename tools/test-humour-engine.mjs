// Humour engine v2 tests (src/engine.js). Run from funnier/: node tools/test-humour-engine.mjs
// 1. the program: tensor == reference evaluation, backprop == finite differences (w, heads, and the frozen constants)
// 2. priors: zero votes = a neutral chart; a taste-less (random) voter stays near neutral; an imported passport moves the prior
// 3. recovery: synthetic users with KNOWN tastes vote on real catalogue pairs (clips.json + site/theory.json); the online
//    fit (warm-started after every vote, like the browser) must recover them within N votes
// 4. signals: rewinds train the laugh head; skips the skip head; per-vote deltas are produced and explainable
import fs from 'node:fs'
import * as E from '../src/engine.js'

let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const realClips = J('clips.json').filter((c) => c.status !== 'removed' && c.kind === 'human'), T = J('site/theory.json')
// a synthetic catalogue where every feature is well spread (tests the learner, not the catalogue's coverage)
const synthClips = (() => {
  const r = rng(99), comics = [...Object.keys(T.comics), 'Mark Normand', 'Casey Rocket'], tags = ['absurd', 'deadpan', 'observational', 'dark', 'storytelling', 'one-liners', 'rant', 'self-deprecating', 'crowd-work', 'clean']
  return Array.from({ length: 400 }, (_, i) => ({ id: 's' + i, comic: comics[i % comics.length], style: tags.filter(() => r() < 0.22), format: r() < 0.5 ? 'vertical' : 'horizontal',
    setting: r() < 0.1 ? 'talk-show' : 'stand-up', dur: Math.round(20 + r() * 300), kind: 'human' }))
})()
let clips = realClips, en = E.createEngine({ clips, theory: T })
const useCatalogue = (cs) => { clips = cs; en = E.createEngine({ clips, theory: T }) }
const NF = E.FK.length
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const sig = (z) => 1 / (1 + Math.exp(-z))

// ---------- 1. the program ----------
{
  const P = E.program(), r = rng(1)
  const A = en.raw(clips.find((c) => c.ops).id), B = en.raw(clips.find((c) => c.comic === 'Chris Rock').id)
  const theta = Float64Array.from({ length: NF + E.HEADS.length }, () => r() - 0.5), K = en.consts
  const ref = E.forward({ kind: 'pair', A, B }, theta, K, true), ten = E.forward({ kind: 'pair', A, B }, theta, K)
  ok(Math.abs(ref.z - ten.z) < 1e-6, `compiled tensor program == reference evaluation (${ref.z.toFixed(5)})`)
  ok(P.circuit.operations.length < 2000, `program size: ${P.circuit.operations.length} operations over ${E.SRC.N} source cells`)
  // backprop vs central finite differences
  const og = new Float32Array(P.width); og[P.out.pair] = 1
  const g = P.circuit.backpropagateReference(ref.vals, og)
  let worst = 0
  for (const i of [0, 1, 3, 9, 12, 24, 25, 27, NF]) {
    const h = 1e-3, tp = Float64Array.from(theta), tm = Float64Array.from(theta); tp[i] += h; tm[i] -= h
    const fd = (E.logitPair(A, B, tp, K) - E.logitPair(A, B, tm, K)) / (2 * h)
    worst = Math.max(worst, Math.abs(fd - g[E.SRC.W + i]))
  }
  ok(worst < 2e-3, `backprop matches finite differences on taste weights + beta (max err ${worst.toExponential(1)})`)
  // through the frozen feature program: priorMix (unfreezable constant)
  const iMix = E.CONSTS.indexOf('priorMix'), Kp = Float32Array.from(K), Km = Float32Array.from(K); Kp[iMix] += 1e-2; Km[iMix] -= 1e-2
  const fdc = (E.logitPair(A, B, theta, Kp) - E.logitPair(A, B, theta, Km)) / 2e-2
  ok(Math.abs(fdc - g[E.SRC.C + iMix]) < 5e-3 && Math.abs(g[E.SRC.C + iMix]) > 0, `gradient flows through the frozen feature program (d logit / d priorMix = ${g[E.SRC.C + iMix].toFixed(4)}, fd ${fdc.toFixed(4)})`)
  // fallback chain: a clip with its own bits uses them, a comic-only clip uses the comic's mix
  const bitsClip = clips.find((c) => c.ops), phiBits = en.phi(bitsClip.id)
  const top = Object.entries(bitsClip.ops).sort((x, y) => y[1] - x[1])[0][0]
  ok(phiBits[E.FK.indexOf('op_' + top)] > 0.5, `bits -> ops: ${bitsClip.comic}'s clip leads with ${top} (${phiBits[E.FK.indexOf('op_' + top)].toFixed(2)})`)
  const mn = clips.find((c) => c.comic === 'Mark Normand' && !(c.style || []).length)
  ok(!mn || en.phi(mn.id).slice(0, 24).every((x) => x === 0), 'no theory + no tags = no axis/operator signal (no invented features)')
}

// ---------- helpers: the browser's loop, offline ----------
const prior0 = E.basePrior()
function pairsFor(r, n) {
  const out = []
  while (out.length < n) {
    const a = clips[Math.floor(r() * clips.length)], b = clips[Math.floor(r() * clips.length)]
    if (a.comic !== b.comic) out.push([a.id, b.id]) // the hard rule: never the same comic on both sides
  }
  return out
}
const trueLogit = (wStar, a, b) => { const pa = en.phi(a), pb = en.phi(b); let z = 0; for (let k = 0; k < NF; k++) z += (wStar[k] || 0) * (pa[k] - pb[k]); return z }
function simulate(w, n, seed, { online = true, extra = null } = {}) {
  const wStar = vec(w), r = rng(seed), votes = [], snaps = {}
  let theta = E.thetaFromPrior(prior0), fitRes = null
  for (const [a, b] of pairsFor(r, n)) {
    const y = r() < sig(trueLogit(wStar, a, b))
    votes.push({ a, b, winner: y ? a : b, w: 1 })
    // the browser refits after every vote (warm start, 4 iterations); past 50 votes the test refits at the checkpoints only
    const k = votes.length, every = online && k <= 50
    if (every || [100, 200, n].includes(k)) { fitRes = en.fit(en.samples({ votes, ...(extra ? extra(votes) : {}) }), prior0, theta, { iters: every ? 3 : 8 }); theta = fitRes.theta }
    if ([10, 25, 50, 100, 200].includes(votes.length)) snaps[votes.length] = { theta: Float64Array.from(theta), sd: fitRes.sd, support: fitRes.support }
  }
  return snaps
}
const vec = (o) => E.FK.map((k) => o[k] || 0)
const cosine = (u, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < u.length; i++) { d += u[i] * v[i]; a += u[i] * u[i]; b += v[i] * v[i] } return a && b ? d / Math.sqrt(a * b) : 0 }
function heldOutAcc(w, theta, seed) {
  const wStar = vec(w), r = rng(seed); let hit = 0, oracle = 0, n = 0
  for (const [a, b] of pairsFor(r, 400)) { const zt = trueLogit(wStar, a, b); if (Math.abs(zt) < 0.05) continue; n++; const zp = E.logitPair(en.raw(a), en.raw(b), theta, en.consts); if (Math.sign(zp) === Math.sign(zt)) hit++; if (zt > 0) oracle++ }
  return hit / n
}

// ---------- 2. priors ----------
{
  const ro = E.readout(prior0.mu, Array.from(prior0.prec, (p) => 1 / Math.sqrt(p)))
  ok(E.AXES.every((a) => ro.f['ax_' + a.k].v === 50 && ro.f['ax_' + a.k].conf === 'low'), 'zero votes: every axis is 50, confidence low')
  const flat = simulate({}, 50, 7)[50], rf = E.readout(flat.theta, flat.sd)
  const dev = Math.max(...E.AXES.map((a) => Math.abs(rf.f['ax_' + a.k].v - 50)))
  const honest = E.AXES.filter((a) => rf.f['ax_' + a.k].lo <= 50 && rf.f['ax_' + a.k].hi >= 50).length
  ok(dev <= 25 && honest >= 7, `a coin-flip voter stays near neutral after 50 votes (max axis deviation ${dev}; 50 inside the band on ${honest}/9 axes)`)
  const merged = E.mergePrior(prior0, { ax_deadpan: 1.2 }, { ax_deadpan: 0.3 })
  const iD = E.FK.indexOf('ax_deadpan')
  ok(merged.mu[iD] > 0.5 && merged.mu[iD] < 1.2 && merged.prec[iD] > prior0.prec[iD], `imported passport becomes a discounted prior (deadpan mu ${merged.mu[iD].toFixed(2)}, prec ${merged.prec[iD].toFixed(1)})`)
}

// ---------- 3. recovery of known tastes ----------
const USERS = {
  'deadpan lover': { ax_deadpan: 1.6, energy: -0.8 },
  'rant fan': { ax_rant: 1.6, energy: 0.8 },
  'crowd-work fan': { ax_crowd: 1.8 },
  'one-liner purist': { ax_wordplay: 1.5, vertical: 0.6 },
  'dark + self-roast': { ax_dark: 1.3, ax_selfdep: 1.0 },
  'storyteller': { ax_story: 1.5, long: 0.8 },
  'observational': { ax_observational: 1.5, hold: -0.5 },
  'absurdist': { ax_absurd: 1.5, op_split_knowledge: 0.8 },
}
function recovery(label) {
  const table = {}
  for (const [name, w] of Object.entries(USERS)) {
    const wStar = vec(w), topAxis = Object.keys(w).filter((k) => k.startsWith('ax_')).sort((x, y) => w[y] - w[x])[0]
    for (const seed of [11, 22]) {
      const snaps = simulate(w, 200, seed + name.length)
      for (const [N, s] of Object.entries(snaps)) {
        const ro = E.readout(s.theta, s.sd), axes = E.AXES.map((a) => 'ax_' + a.k).sort((x, y) => ro.f[y].w - ro.f[x].w)
        const row = (table[N] = table[N] || { cos: [], top1: [], top2: [], acc: [], confTop: [] })
        row.cos.push(cosine(Array.from(s.theta.slice(0, NF)), wStar)); row.top1.push(axes[0] === topAxis ? 1 : 0); row.top2.push(axes.slice(0, 2).includes(topAxis) ? 1 : 0)
        row.acc.push(heldOutAcc(w, s.theta, seed * 7)); row.confTop.push(ro.f[topAxis].conf)
      }
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
  console.log(`\nrecovery, ${label} (8 synthetic users x 2 seeds; acc = held-out agreement with the true taste on 400 new pairs):`)
  console.log('votes  cos(w,w*)  top axis #1  top axis in top-2  held-out acc  confidence of the true top axis')
  const R = {}
  for (const N of Object.keys(table).map(Number).sort((a, b) => a - b)) {
    const t = table[N]; R[N] = { cos: mean(t.cos), top1: mean(t.top1), top2: mean(t.top2), acc: mean(t.acc) }
    const cc = ['low', 'medium', 'high'].map((c) => `${c} ${t.confTop.filter((x) => x === c).length}`).join(' / ')
    console.log(`${String(N).padStart(5)}  ${R[N].cos.toFixed(2).padStart(9)}  ${(100 * R[N].top1).toFixed(0).padStart(10)}%  ${(100 * R[N].top2).toFixed(0).padStart(16)}%  ${(100 * R[N].acc).toFixed(0).padStart(11)}%  ${cc}`)
  }
  return R
}
useCatalogue(synthClips)
const RS = recovery('synthetic catalogue (features well spread)')
ok(RS[25].top2 >= 0.75, `synthetic catalogue, 25 votes: true favourite axis in the learned top 2 for ${(100 * RS[25].top2).toFixed(0)}% of users`)
ok(RS[50].top1 >= 0.75 && RS[50].acc >= 0.75, `synthetic catalogue, 50 votes: true favourite axis #1 for ${(100 * RS[50].top1).toFixed(0)}%, held-out ${(100 * RS[50].acc).toFixed(0)}%`)
ok(RS[200].cos >= 0.75 && RS[200].top1 >= 0.9 && RS[200].acc >= 0.85, `synthetic catalogue, 200 votes: cos ${RS[200].cos.toFixed(2)}, #1 ${(100 * RS[200].top1).toFixed(0)}%, held-out ${(100 * RS[200].acc).toFixed(0)}%`)
useCatalogue(realClips)
const RR = recovery('the real catalogue (clips.json + theory.json: most clips untagged, 6 deadpan, 4 self-roast)')
ok(RR[50].acc >= 0.68, `real catalogue, 50 votes: predicts ${(100 * RR[50].acc).toFixed(0)}% of held-out picks the true taste would make`)
ok(RR[200].top2 >= 0.8 && RR[200].acc >= 0.78, `real catalogue, 200 votes: true axis in top 2 for ${(100 * RR[200].top2).toFixed(0)}%, held-out ${(100 * RR[200].acc).toFixed(0)}%`)
ok(RR[200].cos > RR[25].cos && RR[200].acc > RR[25].acc && RS[200].cos > RS[25].cos, 'more votes, better recovery (both catalogues)')
fs.mkdirSync('/tmp/engine-test', { recursive: true }); fs.writeFileSync('/tmp/engine-test/recovery.json', JSON.stringify({ synthetic: RS, real: RR }, null, 1))

// ---------- 4. signals + explanations ----------
useCatalogue(synthClips)
{
  const r = rng(5), votes = []
  // a deadpan lover who rewinds deadpan clips and skips high-energy ones
  for (const [a, b] of pairsFor(r, 40)) {
    const w = { ax_deadpan: 1.6, energy: -0.8 }, y = r() < sig(trueLogit(vec(w), a, b))
    const sg = {}
    for (const [side, id] of [['left', a], ['right', b]]) { const p = en.phi(id); if (p[E.FK.indexOf('ax_deadpan')] > 0.5 && r() < 0.7) sg[side + 'SeekTargets'] = [12] }
    votes.push({ a, b, winner: y ? a : b, w: 1, signals: sg })
  }
  const skips = clips.filter((c) => en.phi(c.id)[E.FK.indexOf('energy')] > 0.3).slice(0, 12).map((c) => ({ clip: c.id, w: 0.3 }))
  const S = en.samples({ votes, skips })
  ok(S.some((s) => s.kind === 'laugh' && s.y === 1) && S.some((s) => s.kind === 'skip' && s.y === 1) && S.some((s) => s.kind === 'finish'), `samples: pairs + laugh (rewinds) + skip + finish rows (${S.length})`)
  const f = en.fit(S, prior0, null, { iters: 15 }), ro = E.readout(f.theta, f.sd)
  ok(ro.heads.gL > 0.6 && ro.f.ax_deadpan.v > 60, `laugh head + taste from 40 votes with rewinds and skips: gL ${ro.heads.gL} (prior 0.6), deadpan ${ro.f.ax_deadpan.v} (${ro.f.ax_deadpan.conf} confidence), high energy ${ro.f.energy.v}`)
  // a per-vote delta, as the browser stores it (real clips)
  useCatalogue(realClips)
  const hist = []; for (const [x, y] of pairsFor(rng(8), 30)) hist.push({ a: x, b: y, winner: trueLogit(vec({ ax_deadpan: 1.6 }), x, y) >= 0 ? x : y, w: 1 })
  const f0 = en.fit(en.samples({ votes: hist }), prior0, null, { iters: 8 }), before = E.readout(f0.theta, f0.sd)
  const a = clips.find((c) => c.comic === 'Norm Macdonald').id, b = clips.find((c) => c.comic === 'Chris Rock' && en.phi(c.id)[E.FK.indexOf('ax_rant')] > 0.5).id
  const f2 = en.fit(en.samples({ votes: [...hist, { a, b, winner: a, w: 1.25 }] }), prior0, f0.theta, { iters: 4 })
  const ds = E.deltas(before, E.readout(f2.theta, f2.sd), { min: 0.1 })
  ok(Math.max(...ds.map((d) => Math.abs(d.d))) <= 15, `one vote after 30 moves an axis by at most 15 points (${E.deltaText(ds)})`)
  const why = `This vote: ${E.deltaText(ds)}, because you picked Norm's ${en.describe(a)} over Rock's ${en.describe(b)}`
  console.log('  ' + why)
  ok(ds.length > 0 && /because you picked Norm's .+ over Rock's .+/.test(why), 'per-vote delta line is produced')
  ok(ds.every((d) => E.FK.includes(d.k)) && ds.some((d) => d.d > 0), 'deltas name real features and move toward the winner')
  // unfreezing the screening/feature constants trains them too
  const fu = en.fit(S, prior0, f.theta, { iters: 3, unfreeze: true })
  ok(fu.consts.some((x, i) => Math.abs(x - en.consts[i]) > 1e-6) && fu.loss <= f.loss + 1e-6, `unfreeze: the feature program's constants move (priorMix ${en.consts[E.CONSTS.indexOf('priorMix')].toFixed(2)} -> ${fu.consts[E.CONSTS.indexOf('priorMix')].toFixed(3)}) and the loss does not rise`)
  // speed: one online update (warm start, 4 iterations) on 100 votes
  const v100 = []; for (const [x, y] of pairsFor(rng(9), 100)) v100.push({ a: x, b: y, winner: x, w: 1 })
  const t0 = performance.now(); en.fit(en.samples({ votes: v100 }), prior0, f.theta, { iters: 4 }); const ms = performance.now() - t0
  ok(ms < 1500, `online update after a vote, 100 votes of history: ${ms.toFixed(0)} ms (Node)`)
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
