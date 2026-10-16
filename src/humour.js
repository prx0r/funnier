// The humour chart: a granular, interpretable picture of what one person finds funny, and the SVG that draws it.
// Pure (no DOM, no storage): bundled into site/app.js and imported by tools/test-humour-chart.mjs.
//
// Each clip gets a feature vector over DIMS (0..1): its clips.json style tags (1 when tagged), plus a softer prior from
// characters2 theory (site/theory.json): the comic's delivery archetype and the operator mix of the comic or of the
// matched special (lift over the roster mean). A person's value on a dimension is a shrunk "win rate": how often the
// side that has more of that dimension won when it was on screen, weighted by each pick's confidence (decision time,
// skips), with skipped clips counted as losses and the Four Favourites as a weak prior. 50 = neutral; the chart shows
// 0..100. Operators and stylometry (energy, punchline hold, pace) use the same idea on the theory data.

export const DIMS = [
  { k: 'absurd', label: 'Absurd / anti-joke', short: 'Absurd', tag: 'absurd', phrase: 'anti-jokes' },
  { k: 'deadpan', label: 'Deadpan', short: 'Deadpan', tag: 'deadpan', phrase: 'long holds' },
  { k: 'observational', label: 'Observational', short: 'Observational', tag: 'observational', phrase: 'everyday noticing' },
  { k: 'dark', label: 'Dark', short: 'Dark', tag: 'dark', phrase: 'dark turns' },
  { k: 'story', label: 'Storytelling', short: 'Stories', tag: 'storytelling', phrase: 'long stories' },
  { k: 'wordplay', label: 'Wordplay & one-liners', short: 'One-liners', tag: 'one-liners', phrase: 'tight one-liners' },
  { k: 'rant', label: 'Rant', short: 'Rant', tag: 'rant', phrase: 'righteous rants' },
  { k: 'selfdep', label: 'Self-roast', short: 'Self-roast', tag: 'self-deprecating', phrase: 'self-roasts' },
  { k: 'crowd', label: 'Crowd work', short: 'Crowd work', tag: 'crowd-work', phrase: 'crowd work' }, // shown once clips carry the tag
]
const DIMK = DIMS.map((d) => d.k)
// characters2 delivery archetypes -> dimensions (a soft prior; tags dominate)
const ARCH = {
  suspension_deadpan: { deadpan: 1, absurd: 0.6 },
  sincere_storyteller: { story: 1, selfdep: 0.6 },
  observational_auditor: { observational: 1, wordplay: 0.4 },
  mock_indignant_engine: { rant: 1, dark: 0.3 },
}
// operator (lift over the roster mean) -> dimensions
const OPDIM = {
  double_interpret: { wordplay: 1 }, literalize: { wordplay: 0.8, absurd: 0.3 }, literalize_or_other: { wordplay: 0.6 },
  juxtapose: { absurd: 0.8, observational: 0.3 }, false_analogy: { absurd: 0.8 }, rigidify: { observational: 0.8 },
  status_invert: { rant: 0.7, selfdep: 0.3 }, expose_self_blindness: { selfdep: 0.8, observational: 0.3 }, unmask: { rant: 0.5, dark: 0.3 },
  repeat_variation: { story: 0.5 }, split_knowledge: { deadpan: 0.3, story: 0.3 }, mistake_identity: { absurd: 0.4 }, role_reverse: { absurd: 0.4 },
}
export const OP_LABEL = { // plain English (kept in step with tally/humour.mjs)
  split_knowledge: 'dramatic irony', repeat_variation: 'callbacks', double_interpret: 'double meanings', status_invert: 'status flips',
  rigidify: 'mechanical logic', juxtapose: 'odd pairings', literalize: 'taking it literally', mistake_identity: 'mistaken identity',
  literalize_or_other: 'literal-minded turns', expose_self_blindness: 'people blind to themselves', false_analogy: 'bogus logic',
  identity_contradict: 'self-contradiction', unmask: 'unmasking pretence', role_reverse: 'role reversals', character_violation: 'breaking type',
}
export const STY = [
  { k: 'energy', lo: 'Low-key', hi: 'High-energy' },
  { k: 'hold', lo: 'Quick-fire', hi: 'Long holds' },
  { k: 'pace', lo: 'Wordy', hi: 'Punchy' },
]
const SHORT = { 'Norm Macdonald': 'Norm', 'Louis C.K.': 'Louis C.K.', 'Jerry Seinfeld': 'Seinfeld', 'Chris Rock': 'Chris Rock', 'Mark Normand': 'Normand' }
export const shortName = (comic, comics) => comics?.[comic]?.short || SHORT[comic] || String(comic || '').split(' ').slice(-1)[0]
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const arr = (x) => (Array.isArray(x) ? x : [])

function opsOf(c, T) {
  if (c?.ops && typeof c.ops === 'object') return c.ops // the clip's own bits (opsSource "bits")
  const sp = c?.special_id ? T?.specials?.[c.special_id] : null
  return sp?.ops || T?.comics?.[c?.comic]?.ops || null
}
function opLift(ops, T) { // positive lift over the roster mean, normalised to max 1
  if (!ops) return null
  const m = T?.opsMean || {}, o = {}
  let mx = 0
  for (const k of Object.keys(ops)) { const v = Math.max(0, (+ops[k] || 0) - (+m[k] || 0)); if (v > 0) { o[k] = v; mx = Math.max(mx, v) } }
  if (!mx) return null
  for (const k of Object.keys(o)) o[k] /= mx
  return o
}
// clip -> { dim: 0..1 }
export function clipFeatures(c, T) {
  const f = Object.fromEntries(DIMK.map((k) => [k, 0])), st = arr(c?.style)
  for (const d of DIMS) if (st.includes(d.tag)) f[d.k] = 1
  const prior = Object.fromEntries(DIMK.map((k) => [k, 0]))
  const a = ARCH[T?.comics?.[c?.comic]?.archetype]
  if (a) for (const [k, v] of Object.entries(a)) prior[k] = Math.max(prior[k], v)
  const lift = opLift(opsOf(c, T), T)
  if (lift) for (const [op, v] of Object.entries(lift)) for (const [k, w] of Object.entries(OPDIM[op] || {})) prior[k] = Math.max(prior[k], v * w)
  for (const k of DIMK) f[k] = clamp(f[k] + 0.35 * prior[k], 0, 1)
  return f
}
// clip -> stylometry 0..1 (null when characters2 has nothing for the comic)
export function clipStyle(c, T) {
  const C = T?.comics?.[c?.comic]; if (!C) return null
  const sp = c?.special_id ? T?.specials?.[c.special_id] : null
  const sty = sp?.sty || C.sty, sc = T?.styScale?.short_sent_frac
  return {
    energy: Number.isFinite(C.energy) ? clamp(C.energy, 0, 1) : null,
    hold: Number.isFinite(C.holdMs) ? clamp((C.holdMs - 400) / 1600, 0, 1) : null,
    pace: sty && sc && Number.isFinite(sty.short_sent_frac) ? clamp(0.5 + (sty.short_sent_frac - sc.mean) / (4 * (sc.sd || 1)), 0, 1) : null,
  }
}

// votes: [{ a, b, winner, w }] (w = pick confidence), skips: [{ clip, w }], favs: [comic], clips: {id: clip}
// opts: { theory, comics, score(id) -> number (your model, for "funniest to you"), server: GET /me/humour profile,
//   engine: readout() of the humour engine v2 (src/engine.js) -> its weights draw the axes, with uncertainty bands }
export function computeChart({ votes = [], skips = [], favs = [], clips = {}, theory = null, comics = {}, score = null, server = null, engine = null } = {}) {
  const T = theory || {}, F = {}, S = {}
  const feat = (id) => (F[id] = F[id] || clipFeatures(clips[id], T))
  const sty = (id) => (id in S ? S[id] : (S[id] = clipStyle(clips[id], T)))
  const all = Object.values(clips)
  const covered = new Set(DIMS.filter((d) => all.some((c) => arr(c.style).includes(d.tag)) || d.k !== 'crowd').map((d) => d.k))
  const pos = Object.fromEntries(DIMK.map((k) => [k, 0])), exp = Object.fromEntries(DIMK.map((k) => [k, 0]))
  const opPos = {}, opExp = {}
  const styWon = { energy: [0, 0], hold: [0, 0], pace: [0, 0] }, styAll = { energy: [0, 0], hold: [0, 0], pace: [0, 0] }
  let n = 0
  const addOps = (id, w, won) => {
    const l = opLift(opsOf(clips[id], T), T); if (!l) return
    for (const [op, v] of Object.entries(l)) { opExp[op] = (opExp[op] || 0) + w * v; if (won) opPos[op] = (opPos[op] || 0) + w * v }
  }
  const addSty = (id, w, won) => {
    const s = sty(id); if (!s) return
    for (const k of Object.keys(styAll)) if (s[k] != null) { styAll[k][0] += w * s[k]; styAll[k][1] += w; if (won) { styWon[k][0] += w * s[k]; styWon[k][1] += w } }
  }
  for (const v of votes) {
    if (!clips[v?.a] || !clips[v?.b] || (v.winner !== v.a && v.winner !== v.b)) continue
    const w = Number.isFinite(v.w) ? v.w : 1, W = v.winner, L = W === v.a ? v.b : v.a, fw = feat(W), fl = feat(L)
    for (const k of DIMK) { pos[k] += w * fw[k]; exp[k] += w * (fw[k] + fl[k]) }
    addOps(W, w, true); addOps(L, w, false); addSty(W, w, true); addSty(L, w, false)
    n++
  }
  for (const s of skips) { // a skipped clip: a weak loss for what it is made of
    if (!clips[s?.clip]) continue
    const w = Number.isFinite(s.w) ? s.w : 0.3, f = feat(s.clip)
    for (const k of DIMK) exp[k] += w * f[k]
    addOps(s.clip, w, false); addSty(s.clip, w, false)
  }
  // Four Favourites: each favourite comic's average clip beats an average clip, at 0.6 of a pick
  // clips with something to say (tags or theory); untagged imports carry no signal and would drag means toward 0
  const informative = (c) => DIMK.some((k) => feat(c.id)[k] > 0)
  const comicMean = (name) => {
    const cs = all.filter((c) => c.comic === name && informative(c)); if (!cs.length) return null
    const m = Object.fromEntries(DIMK.map((k) => [k, 0])); for (const c of cs) { const f = feat(c.id); for (const k of DIMK) m[k] += f[k] / cs.length }
    return m
  }
  const rosterMean = Object.fromEntries(DIMK.map((k) => [k, 0]))
  const inf = all.filter(informative)
  for (const c of inf) { const f = feat(c.id); for (const k of DIMK) rosterMean[k] += f[k] / (inf.length || 1) }
  for (const name of arr(favs).slice(0, 4)) {
    const m = comicMean(name); if (!m) continue
    for (const k of DIMK) { pos[k] += 0.6 * m[k]; exp[k] += 0.6 * (m[k] + rosterMean[k]) }
  }
  const dims = {}, conf = {}, band = {}, cl = {}
  let ops, styOut = {}
  if (engine?.f) { // engine v2: the axes ARE the taste weights (50 + 50 tanh w), the band is +-1 posterior sd
    for (const k of DIMK) if (covered.has(k)) { const e = engine.f['ax_' + k]; if (!e) continue; dims[k] = e.v; conf[k] = e.n; band[k] = [e.lo, e.hi]; cl[k] = e.conf }
    ops = Object.keys(OP_LABEL).map((op) => ({ op, e: engine.f['op_' + op] })).filter((x) => x.e && x.e.n >= 0.6).map((x) => ({ k: x.op, label: OP_LABEL[x.op], v: x.e.v })).sort((x, y) => y.v - x.v)
    for (const k of ['energy', 'hold', 'pace']) { const e = engine.f[k]; if (e && e.n >= 1.5) styOut[k] = e.v }
  } else {
    for (const k of DIMK) if (covered.has(k)) { dims[k] = Math.round(100 * (pos[k] + 1) / (exp[k] + 2)); conf[k] = Math.round(exp[k] * 10) / 10 }
    ops = Object.keys(opExp).filter((op) => opExp[op] >= 0.6).map((op) => ({ k: op, label: OP_LABEL[op] || op, v: Math.round(100 * ((opPos[op] || 0) + 1) / (opExp[op] + 2)) }))
      .sort((x, y) => y.v - x.v)
    for (const k of Object.keys(styAll)) {
      const [sa, na] = styAll[k], [sw, nw] = styWon[k]
      if (nw >= 1.5 && na > 0) styOut[k] = Math.round(clamp(50 + 50 * Math.tanh(4 * (sw / nw - sa / na)), 0, 100))
    }
  }
  // server-side (offline) profile: its operator weights win when it is ready
  let serverLine = null
  if (server && server.weights && typeof server.weights === 'object') {
    for (const [op, w] of Object.entries(server.weights)) if (OP_LABEL[op] && Number.isFinite(w)) {
      const v = Math.round(100 / (1 + Math.exp(-2 * w))), cur = ops.find((o) => o.k === op)
      if (cur) cur.v = Math.round((cur.v + v) / 2); else if (Math.abs(w) > 0.05) ops.push({ k: op, label: OP_LABEL[op], v })
    }
    ops.sort((x, y) => y.v - x.v)
  }
  if (server && typeof server.line === 'string') serverLine = server.line.slice(0, 160)
  const signal = n + arr(favs).length
  const ranked = Object.keys(dims).sort((x, y) => dims[y] - dims[x] || conf[y] - conf[x])
  const top = signal ? ranked.filter((k) => dims[k] > 52).slice(0, 2) : []
  const low = signal ? ranked.filter((k) => dims[k] < 46).slice(-1) : []
  // the comic whose shape is closest to yours
  let adjacent = null
  if (signal) {
    const u = Object.fromEntries(Object.keys(dims).map((k) => [k, (dims[k] - 50) / 50]))
    for (const name of [...new Set(all.map((c) => c.comic))]) {
      const m = comicMean(name); if (!m) continue
      let d = 0, nu = 0, nc = 0
      for (const k of Object.keys(u)) { const ck = m[k] - rosterMean[k]; d += u[k] * ck; nu += u[k] * u[k]; nc += ck * ck }
      const cos = nu && nc ? d / Math.sqrt(nu * nc) : 0, pct = Math.round(clamp(50 + 50 * cos, 0, 97))
      if (!adjacent || pct > adjacent.pct) adjacent = { comic: name, short: shortName(name, comics), pct }
    }
  }
  const phrase = (k) => DIMS.find((d) => d.k === k)?.phrase || k
  let line
  if (!signal) line = 'Still reading you. Vote on a few clashes and your chart fills in.'
  else if (!top.length) line = `An open mind: nothing wins you over yet${adjacent ? `. ${adjacent.pct}% ${adjacent.short}-adjacent` : ''}.`
  else line = `You like ${top.map(phrase).join(' and ')}${adjacent ? `: ${adjacent.pct}% ${adjacent.short}-adjacent` : ''}.`
  // funniest to you: your model's top clip among the ones you have seen
  let funniest = null
  if (score && n) {
    const seen = [...new Set(votes.flatMap((v) => [v.a, v.b]))].filter((id) => clips[id])
    const best = seen.map((id) => [score(id), id]).sort((x, y) => y[0] - x[0])[0]
    if (best) { const c = clips[best[1]]; funniest = { id: c.id, title: c.title, comic: c.comic } }
  }
  return { v: engine?.f ? 2 : 1, model: engine?.f ? engine.model || 'engine' : 'counts', n, favs: arr(favs).slice(0, 4), dims, conf, band, cl, ops: ops.slice(0, 6), sty: styOut, top, low, adjacent, line, serverLine, funniest, mml: makeMeLaughBy(top, styOut) }
}

// "Make me laugh by…" (a dating-app prompt), from your strongest dimension and your hold/energy lean
const MML = {
  deadpan: ['doing a 40-second pause before the punchline', 'telling me something devastating with a completely straight face'],
  absurd: ['telling a joke that goes nowhere, very slowly, and committing', 'explaining a moth joke for nine minutes'],
  observational: ['noticing the thing about airports nobody has said out loud', 'pointing out what is weird about something I do every day'],
  dark: ['finding the joke in the worst thing that ever happened to you', 'making me laugh at a funeral (not ours)'],
  story: ['taking ten minutes to set up one perfect payoff', 'telling me a story where the callback lands an hour later'],
  wordplay: ['landing a one-liner so tight I groan before I laugh', 'getting a pun past me before I see it coming'],
  rant: ['getting righteously furious about something tiny', 'ranting about self-checkout like it wronged your family'],
  selfdep: ['roasting yourself before I get the chance', 'telling me your most embarrassing story, unprompted'],
  crowd: ['picking on the guy in the front row (not me)', 'turning a heckle into the best bit of the night'],
}
export function makeMeLaughBy(top, sty = {}, seed = 0) {
  if (!top?.length) return sty.hold > 60 ? MML.deadpan[0] : 'surprising me (the chart is still reading me)'
  const list = MML[top[0]] || MML.deadpan
  return list[Math.abs(seed) % list.length]
}

// taste match between two charts: cosine of their leans (value - 50) over the dimensions both have, mapped to 0..100
export function tasteMatch(A, B) {
  const ks = Object.keys(A?.dims || {}).filter((k) => B?.dims && k in B.dims)
  let d = 0, na = 0, nb = 0, gap = 0
  for (const k of ks) { const x = A.dims[k] - 50, y = B.dims[k] - 50; d += x * y; na += x * x; nb += y * y; gap += Math.abs(x - y) }
  const cos = na && nb ? d / Math.sqrt(na * nb) : 0
  // closeness of the actual values matters too (two flat charts agree)
  const close = ks.length ? 1 - gap / (ks.length * 100) : 0
  const pct = ks.length ? Math.round(clamp(100 * (0.5 * (0.5 + 0.5 * cos) + 0.5 * close), 0, 100)) : null
  const both = ks.filter((k) => A.dims[k] >= 56 && B.dims[k] >= 56).sort((x, y) => (B.dims[y] + A.dims[y]) - (B.dims[x] + A.dims[x]))
  const disagree = ks.filter((k) => Math.abs(A.dims[k] - B.dims[k]) >= 18).sort((x, y) => Math.abs(A.dims[y] - B.dims[y]) - Math.abs(A.dims[x] - B.dims[x]))
  return { pct, both, disagree }
}
export const dimLabel = (k) => DIMS.find((d) => d.k === k)?.label || k
export const dimShort = (k) => DIMS.find((d) => d.k === k)?.short || k
export const dimPhrase = (k) => DIMS.find((d) => d.k === k)?.phrase || k

// ---------- the reusable SVG component ----------
// series: [{ dims, color, label }] (first = you). opts: { size, labels: true, rings: true, id }
export const CHART_COLORS = ['#f5c76b', '#ff3d55', '#5ad1ff', '#b48cff']
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export function chartAxes(series) {
  const ks = DIMS.map((d) => d.k).filter((k) => series.some((s) => s?.dims && k in s.dims))
  return ks.length >= 3 ? ks : DIMS.slice(0, 8).map((d) => d.k)
}
export function chartSVG(series, opts = {}) {
  const S = opts.size || 360, pad = opts.labels === false ? 8 : 64, R = S / 2 - pad, cx = S / 2, cy = S / 2
  const ks = chartAxes(series), N = ks.length, ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / N
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * (v / 100), cy + Math.sin(ang(i)) * R * (v / 100)]
  const poly = (vals) => vals.map((v, i) => pt(i, v).map((x) => x.toFixed(1)).join(',')).join(' ')
  const id = opts.id || 'hc' + Math.round(Math.random() * 1e6)
  const mx = opts.labels === false ? 0 : Math.round(S * 0.23) // room for the side labels ("Observational 47"), wide fallback fonts included
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-mx} 0 ${S + 2 * mx} ${S}" class="hchart" role="img" aria-label="${xmlEsc(opts.title || 'Humour chart')}">`
  g += `<defs>${series.map((s, j) => `<radialGradient id="${id}g${j}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${s.color || CHART_COLORS[j]}" stop-opacity=".08"/><stop offset="100%" stop-color="${s.color || CHART_COLORS[j]}" stop-opacity="${j ? '.22' : '.38'}"/></radialGradient>`).join('')}</defs>`
  for (const r of [25, 50, 75, 100]) g += `<polygon points="${poly(ks.map(() => r))}" fill="none" stroke="rgba(255,255,255,${r === 50 ? '.28' : '.09'})" stroke-width="${r === 50 ? 1.2 : 1}"${r === 50 ? ' stroke-dasharray="3 4"' : ''}/>`
  ks.forEach((k, i) => { const [x, y] = pt(i, 100); g += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.08)"/>` })
  // uncertainty band of the first series: the ring between each axis' lo and hi (engine v2, +-1 posterior sd)
  const b0 = series[0]?.band
  if (b0 && opts.bands !== false && ks.every((k) => Array.isArray(b0[k]))) {
    const hi = ks.map((k) => clamp(b0[k][1], 4, 100)), lo = ks.map((k) => clamp(b0[k][0], 2, 100))
    const P = (i, v) => pt(i, v).map((x) => x.toFixed(1)).join(',')
    const outer = ks.map((_, i) => P(i, hi[i])).join(' L'), inner = ks.map((_, i) => P(i, lo[i])).reverse().join(' L')
    g += `<path class="hcband" d="M${outer} Z M${inner} Z" fill="${series[0].color || CHART_COLORS[0]}" fill-opacity=".12" fill-rule="evenodd" stroke="none"/>`
  }
  series.forEach((s, j) => {
    if (!s?.dims) return
    const vals = ks.map((k) => clamp(s.dims[k] ?? 50, 4, 100)), col = s.color || CHART_COLORS[j]
    g += `<polygon class="hcs" points="${poly(vals)}" fill="url(#${id}g${j})" stroke="${col}" stroke-width="${j ? 2 : 2.6}" stroke-linejoin="round"${j ? ' stroke-dasharray="6 4"' : ''}/>`
    if (!j) vals.forEach((v, i) => { const [x, y] = pt(i, v); g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${col}"/>` })
  })
  if (opts.labels !== false) ks.forEach((k, i) => {
    const [x, y] = pt(i, 118), a = Math.cos(ang(i)), anchor = Math.abs(a) < 0.3 ? 'middle' : a > 0 ? 'start' : 'end'
    const v = series[0]?.dims?.[k]
    g += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" class="hcl" fill="rgba(255,255,255,.82)" font-size="${Math.round(S / 30)}" font-family="Inter Tight, system-ui, sans-serif" font-weight="600">${xmlEsc(dimShort(k))}${v != null && opts.values !== false ? `<tspan dx="5" fill="${series[0].color || CHART_COLORS[0]}" font-weight="800">${v}</tspan>` : ''}</text>`
  })
  return g + '</svg>'
}
