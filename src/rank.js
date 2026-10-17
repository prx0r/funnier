// The crowd ranking's posterior: what Funnier believes about "who's the funniest" and how sure it is.
// Pure, no I/O. Shared by the tally (writes data/posterior.json), the client (pair scoring, cold start), the tests and
// the simulation (tally/sim-feeds.mjs).
//
// Model (the same hierarchy as the tally's board): clip strength s = u[comic] + o[clip], P(a beats b) = sigmoid(s_a - s_b).
//   prior  u[comic] ~ N(mu0(comic), SD_COMIC^2)   mu0 from funnygraph's house percentile (cold start), else its tier
//          o[clip]  ~ N(0, SD_CLIP^2)              a clip is a noisy sample of its comic
// MAP by damped diagonal Newton, then a diagonal Laplace approximation: sd = 1/sqrt(prior precision + sum p(1-p)).
// The diagonal ignores the comic/clip correlation, so a clip's total variance is taken as sd_u^2 + sd_o^2 (slightly
// conservative). Units are logits (Elo = 1500 + 400/ln10 * s).
export const SD_COMIC = 1.0, SD_CLIP = 0.5, PRIOR_SPAN = 2.0, TOP_K = 25
export const sig = (x) => 1 / (1 + Math.exp(-x))
// standard normal CDF (Abramowitz-Stegun 7.1.26 via erf)
export function Phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2)
  return z >= 0 ? (1 + e) / 2 : (1 - e) / 2
}
// prior mean of a comic from funnygraph (people[id] = {t: tier, pct: house percentile 0..100}): pct 100 -> +1, pct 0 -> -1
export function priorMean(g, tier) {
  if (g && Number.isFinite(g.pct)) return PRIOR_SPAN * (g.pct / 100 - 0.5)
  const t = g?.t || tier
  return t === 'king' ? 0.3 : t === 'indie' ? -0.3 : 0
}
// clips: [{id, comic}], votes: [{a, b, winner}], prior(comic) -> mu0
export function fitPosterior(clips, votes, { prior = () => 0, sdComic = SD_COMIC, sdClip = SD_CLIP, iters = 60 } = {}) {
  const comics = [...new Set(clips.map((c) => c.comic))], ci = new Map(comics.map((c, i) => [c, i])), ki = new Map(clips.map((c, i) => [c.id, i]))
  const cOf = clips.map((c) => ci.get(c.comic)), mu0 = comics.map((c) => +prior(c) || 0)
  const pc = 1 / (sdComic * sdComic), po = 1 / (sdClip * sdClip)
  const V = []
  for (const v of votes || []) {
    const a = ki.get(v.a), b = ki.get(v.b); if (a == null || b == null || a === b || (v.winner !== v.a && v.winner !== v.b)) continue
    const w = v.winner === v.a ? a : b, l = w === a ? b : a; V.push([w, l, Number.isFinite(v.w) ? v.w : 1])
  }
  const u = [...mu0], o = clips.map(() => 0), nC = comics.map(() => 0), nK = clips.map(() => 0)
  for (const [w, l] of V) { nK[w]++; nK[l]++; if (cOf[w] !== cOf[l]) { nC[cOf[w]]++; nC[cOf[l]]++ } }
  let hu = u.map(() => pc), ho = o.map(() => po)
  for (let t = 0; t < (V.length ? iters : 0); t++) {
    const gu = u.map((x, i) => -pc * (x - mu0[i])), go = o.map((x) => -po * x)
    hu = u.map(() => pc); ho = o.map(() => po)
    for (const [w, l, k] of V) {
      const cw = cOf[w], cl = cOf[l], p = sig(u[cw] + o[w] - u[cl] - o[l]), g = k * (1 - p), h = k * p * (1 - p)
      go[w] += g; go[l] -= g; ho[w] += h; ho[l] += h
      if (cw !== cl) { gu[cw] += g; gu[cl] -= g; hu[cw] += h; hu[cl] += h }
    }
    // damped diagonal Newton, each step clipped to +-0.5 logits (a near-separable record can't blow it up); comics and
    // clip offsets share the evidence, so each moves half way
    for (let i = 0; i < u.length; i++) u[i] += Math.max(-0.5, Math.min(0.5, 0.5 * gu[i] / hu[i]))
    for (let i = 0; i < o.length; i++) o[i] += Math.max(-0.5, Math.min(0.5, 0.5 * go[i] / ho[i]))
  }
  const r3 = (x) => Math.round(x * 1000) / 1000
  const out = { sdComic, sdClip, comics: {}, clips: {} }
  comics.forEach((c, i) => { out.comics[c] = { mu: r3(u[i]), sd: r3(1 / Math.sqrt(hu[i])), mu0: r3(mu0[i]), n: nC[i] } })
  clips.forEach((c, i) => { out.clips[c.id] = { o: r3(o[i]), sd: r3(1 / Math.sqrt(ho[i])), n: nK[i] } })
  return withTop(out)
}
// P(the comic is in the top K): normal approximation against the K-th best posterior mean
export function withTop(P, K = TOP_K) {
  const mus = Object.values(P.comics).map((x) => x.mu).sort((a, b) => b - a)
  const k = Math.max(1, Math.min(K, Math.floor(mus.length / 4) || 1))
  P.K = k; P.thr = mus.length ? mus[k - 1] : 0
  for (const x of Object.values(P.comics)) x.top = Math.round(1000 * Phi((x.mu - P.thr) / Math.sqrt(x.sd * x.sd + 0.05))) / 1000
  return P
}
// a clip's belief: strength mean, total variance, comic variance, P(comic in top K)
export function belief(P, c) {
  const C = P?.comics?.[c.comic], K = P?.clips?.[c.id]
  const cmu = C ? C.mu : 0, csd = C ? C.sd : P?.sdComic ?? SD_COMIC, osd = K ? K.sd : P?.sdClip ?? SD_CLIP
  return { mu: cmu + (K ? K.o : 0), v: csd * csd + osd * osd, cv: csd * csd, top: C?.top ?? 0, n: K?.n || 0 }
}
// expected information from one vote on (a, b): p(1-p) * Var(s_a - s_b), with the probit-moderated P(a wins)
// (two clips of one comic share the comic term, so only the clip offsets differ: a pairing rule forbids it anyway)
export function pairInfo(A, B, sameComic = false) {
  const V = sameComic ? (A.v - A.cv) + (B.v - B.cv) : A.v + B.v
  const p = sig((A.mu - B.mu) / Math.sqrt(1 + Math.PI * V / 8))
  return { p, V, gain: p * (1 - p) * V }
}
