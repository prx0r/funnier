// Simulation: does the core pair scorer (src/feeds.js corePick) find "who's the funniest" faster than the old feed logic
// or random pairs, and what does the relatedness gate cost? Synthetic voters answer from a KNOWN ground truth; every
// policy is scored with the same estimator (the src/rank.js posterior, refitted every 25 votes), so only the pair choice
// differs. Metrics vs votes: Kendall tau (all comics) and top-10 precision of the comic ranking, + % rounds with a real link.
// Usage (from funnier/): node tally/sim-feeds.mjs [--seeds 4] [--votes 1500] [--comics 120] [--policies random,old,core,gate]
//   [--truth informed|blind] [--boards /tmp/pub/data/funnygraph/boards.json] [--comicsjson /tmp/pub/comics.json] [--out <json>]
// truth informed: comic strength = 0.6 x funnygraph prior + N(0, 0.8) (the prior helps but is noisy);
// truth blind:    comic strength = N(0, 1), unrelated to the prior (the prior can only mislead).
// Catalogue: a seeded sample of the real clips.json (no chat clips), <= 3 clips per comic, with their real tags, topics,
// lengths and funnygraph facts, so the relatedness gate sees the real link structure.
import fs from 'node:fs'
import { corePick, pickTrending, comicFacts, isChat, relLink, cheapLink } from '../src/feeds.js'
import { fitPosterior, priorMean, belief, sig } from '../src/rank.js'
import { structSim } from '../src/structsim.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const SEEDS = +arg('--seeds', 4), VOTES = +arg('--votes', 1500), NCOMICS = +arg('--comics', 120), TRUTH = arg('--truth', 'informed')
const POLICIES = arg('--policies', 'random,old,core,gate').split(',')
const CHECK = [100, 250, 500, 1000, 1500, 2000, 3000].filter((x) => x <= VOTES)
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const ALL = readJSON('clips.json', []).filter((c) => c.status !== 'removed' && !isChat(c) && c.kind === 'human' && c.media === 'youtube' && Number(c.sec) > 0)
const THEORY = readJSON('site/theory.json', {})
const people = readJSON(arg('--boards', '/tmp/pub/data/funnygraph/boards.json'), {})?.people || {}
const COMICS = readJSON(arg('--comicsjson', '/tmp/pub/comics.json'), null)?.comics || readJSON('site/comics.json', {}).comics || {}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
const FAIR = 1.5, win = (c) => Math.min(Number(c.sec) || 60, 150), fair = (a, b) => Math.max(win(a), win(b)) <= FAIR * Math.min(win(a), win(b)) + 0.01

function kendall(est, tru) {
  const ks = Object.keys(tru); let c = 0, d = 0
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { const x = Math.sign(est[ks[i]] - est[ks[j]]) * Math.sign(tru[ks[i]] - tru[ks[j]]); if (x > 0) c++; else if (x < 0) d++ }
  return (c - d) / Math.max(1, c + d)
}
const top10 = (est, tru) => { const t = new Set(Object.keys(tru).sort((a, b) => tru[b] - tru[a]).slice(0, 10)); return Object.keys(est).sort((a, b) => est[b] - est[a]).slice(0, 10).filter((k) => t.has(k)).length / 10 }

function runOne(policy, seed) {
  const r = rng(seed * 7919 + 17)
  // catalogue
  const byComic = {}; for (const c of ALL) (byComic[c.comic] = byComic[c.comic] || []).push(c)
  const names = Object.keys(byComic).sort().map((n) => [r(), n]).sort((a, b) => a[0] - b[0]).slice(0, NCOMICS).map((x) => x[1])
  const clips = names.flatMap((n) => byComic[n].slice(0, 3))
  const F = new Map(clips.map((c) => [c, comicFacts(c, COMICS, people)])), facts = (c) => F.get(c)
  const first = {}; for (const c of clips) if (!first[c.comic]) first[c.comic] = c
  const prior = (comic) => { const f = facts(first[comic]); return priorMean(f.g, f.tier) }
  // ground truth
  const u = {}, o = {}
  for (const n of names) u[n] = TRUTH === 'blind' ? gauss(r) : 0.6 * prior(n) + 0.8 * gauss(r)
  for (const c of clips) o[c.id] = 0.35 * gauss(r)
  const s = (c) => u[c.comic] + o[c.id]
  // struct_sim cache
  const ssMemo = new Map(), sim = (a, b) => { const k = a.id < b.id ? a.id + b.id : b.id + a.id; let v = ssMemo.get(k); if (v == null) { v = structSim(a, b, THEORY, { pairing: true }); ssMemo.set(k, v) } return v }
  const open = (x, y) => { const A = byId[x], B = byId[y]; return A && B && A.comic !== B.comic && fair(A, B) }
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]))
  const votes = [], out = { tau: {}, top10: {}, link: 0, fb: 0 }
  let P = fitPosterior(clips, [], { prior }), bouts = {}
  const ctx = () => ({ facts, open, sim, lm: (c) => Math.log(1 / (1 + 0.15 * (bouts[c.id] || 0))) * 0.5, rnd: r, post: P, trending: null, noGate: policy === 'core' })
  // ---- old (v1) logic: Trending share (15% rising) from trendScore + struct_sim; the rest the cold-start For You mix
  // (0.6 Training: pairs.json weights 0.4 close*unc + 0.3 fresh + 0.3 struct_sim, sampled from the top 40; 0.4 Explore:
  // least-seen clip vs its most kindred fair opponent). Closeness/uncertainty from the same posterior (Elo scale).
  const oldPick = () => {
    const elo = (c) => { const b = belief(P, c); return { e: 1500 + 173.7 * b.mu, w: 3.92 * 173.7 * Math.sqrt(b.v) } }
    const trendN = Object.values(bouts).filter((n) => n >= 3).length, share = Math.min(0.65, 0.15 + trendN / 100)
    if (r() < share) { // old pickTrending: house percentile + crowd BT bootstrap score, opponent by score + 0.3 struct_sim
      const ts = (c) => { const f = facts(c); return 0.45 * (Number.isFinite(f.g?.pct) ? f.g.pct / 100 : f.tier === 'king' ? 0.4 : 0.15) + 0.2 * sig(belief(P, c).mu) + 0.12 * r() }
      const ranked = [...clips].sort((x, y) => ts(y) - ts(x))
      for (const a of ranked.slice(0, 8)) { const opp = ranked.filter((b) => open(a.id, b.id)).slice(0, 30).map((b) => [ts(b) + 0.3 * sim(a, b), b]).sort((x, y) => y[0] - x[0]); if (opp.length) return [a, opp[0][1]] }
    }
    if (r() < 0.6) {
      const cand = []
      for (let k = 0; k < 400; k++) { const a = clips[Math.floor(r() * clips.length)], b = clips[Math.floor(r() * clips.length)]; if (!open(a.id, b.id)) continue
        const A = elo(a), B = elo(b), close = Math.exp(-Math.abs(A.e - B.e) / 200), unc = (A.w + B.w) / 800, fresh = 1 / (1 + Math.min(bouts[a.id] || 0, bouts[b.id] || 0) / 10)
        cand.push([0.4 * close * unc + 0.3 * fresh + 0.3 * sim(a, b), a, b]) }
      const top = cand.sort((x, y) => y[0] - x[0]).slice(0, 40), Z = top.reduce((t, x) => t + x[0], 0); let z = r() * Z
      for (const x of top) { z -= x[0]; if (z <= 0) return [x[1], x[2]] }
      if (top.length) return [top[0][1], top[0][2]]
    }
    const least = [...clips].sort((x, y) => (bouts[x.id] || 0) - (bouts[y.id] || 0) + 0.35 * (r() - 0.5))
    for (const a of least) { const opp = clips.filter((b) => open(a.id, b.id)); if (opp.length) return [a, opp.map((b) => [sim(a, b) + 0.35 * r(), b]).sort((x, y) => y[0] - x[0])[0][1]] }
    return null
  }
  const randPick = () => { for (let k = 0; k < 200; k++) { const a = clips[Math.floor(r() * clips.length)], b = clips[Math.floor(r() * clips.length)]; if (open(a.id, b.id)) return [a, b] } return null }
  for (let t = 1; t <= VOTES; t++) {
    const p = policy === 'random' ? randPick() : policy === 'old' ? oldPick() : corePick(clips, ctx(), { feed: 'sim' })
    if (!p) break
    const [a, b] = p, l = p.why && p.why.link !== 'none' ? true : !!relLink(a, b, facts(a), facts(b), sim)
    if (l) out.link++; if (p.why?.fallback) out.fb++
    votes.push({ a: a.id, b: b.id, winner: r() < sig(s(a) - s(b)) ? a.id : b.id })
    bouts[a.id] = (bouts[a.id] || 0) + 1; bouts[b.id] = (bouts[b.id] || 0) + 1
    if (t % 25 === 0) P = fitPosterior(clips, votes, { prior })
    if (CHECK.includes(t)) { const est = Object.fromEntries(names.map((n) => [n, P.comics[n].mu])); out.tau[t] = kendall(est, u); out.top10[t] = top10(est, u) }
  }
  out.link /= votes.length; out.fb /= votes.length; out.n = votes.length
  return out
}

const res = {}
for (const pol of POLICIES) {
  const runs = []; const t0 = Date.now()
  for (let sd = 1; sd <= SEEDS; sd++) runs.push(runOne(pol, sd))
  const avg = (k) => Object.fromEntries(CHECK.map((t) => [t, +(runs.reduce((a, x) => a + (x[k][t] ?? NaN), 0) / runs.length).toFixed(3)]))
  res[pol] = { tau: avg('tau'), top10: avg('top10'), link: +(runs.reduce((a, x) => a + x.link, 0) / runs.length).toFixed(3), fallback: +(runs.reduce((a, x) => a + x.fb, 0) / runs.length).toFixed(3), sec: Math.round((Date.now() - t0) / 1000) }
  console.log(pol.padEnd(7), 'tau', JSON.stringify(res[pol].tau), 'top10', JSON.stringify(res[pol].top10), 'link', res[pol].link, 'fallback', res[pol].fallback, `(${res[pol].sec}s)`)
}
const outp = arg('--out', null)
if (outp) { const prev = readJSON(outp, {}); prev[TRUTH] = { ...(prev[TRUTH] || {}), ...res, config: { seeds: SEEDS, votes: VOTES, comics: NCOMICS } }; fs.writeFileSync(outp, JSON.stringify(prev, null, 1)) }
