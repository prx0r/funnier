// The humour model, drawn. Three layers, every one rendered from a Humour Passport (funnier.humour/v1) alone, so any
// exported profile, saved version or character can be drawn anywhere. Pure (strings of SVG, no DOM).
//   L1 glyph: an enneagram-style figure. Nine type points on a circle (one per humour axis), the inner hexad 1-4-2-8-5-7
//      and triangle 3-6-9 as edges whose width and colour come from the weights at both ends, feature satellites (the
//      operators, stylometry, setting) wired to the points they feed, a colour cloud per type (size = lean, blur =
//      uncertainty), the dominant type and its wing highlighted, plus a COMPUTED type name. No numbers anywhere.
//   L2 meta-axes: seven bipolar axes (Delivery, Structure, Risk, Cognition, Warmth, Pace, Press) derived from the
//      weights, drawn as diameters with a coloured cloud (magnitude -> saturation, sign -> warm/cool, sd -> blur).
//   L3 the net: input nodes = the interpretable features, one taste node, outputs = P(you prefer it), P(you laugh /
//      rewind), P(you finish it), P(you skip it); edge thickness = |weight|, colour = sign.
import { TYPES } from './passport.js'

const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const f1 = (x) => (Math.round(x * 10) / 10).toString()
const WARM = [36, 92], COOL = [205, 78] // hue, saturation: lean in = warm gold/amber, bounce = cool blue
const PRIOR_SD = { axis: 0.632, op: 0.447, sty: 0.577, meta: 0.5 }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const seedOf = (p) => parseInt(String(p?.hash || '0').slice(0, 8), 16) || 7

// weight + certainty of a feature from the passport (missing = 0, fully uncertain)
export function feat(p, k) {
  const f = p?.features?.[k]
  if (!f || !Number.isFinite(f.w)) return { w: 0, sd: 1, n: 0, c: 0, has: false, label: k }
  const pr = PRIOR_SD[f.group] || 0.6, c = clamp(1 - (Number.isFinite(f.sd) ? f.sd : pr) / pr, 0, 1)
  return { w: f.w, sd: Number.isFinite(f.sd) ? f.sd : pr, n: f.n || 0, c, has: (f.n || 0) > 0, label: f.label || k }
}
const tone = (w, a = 1) => { const [h, s] = w >= 0 ? WARM : COOL, m = clamp(Math.abs(w), 0, 1.5) / 1.5; return `hsla(${h},${Math.round(25 + s * m * 0.75)}%,${Math.round(52 + 10 * m)}%,${a})` }

// ---------- the computed type name ----------
// region = the axis with the largest weight (the noun); modifier = the strongest non-axis feature in its direction
// (or the runner-up axis as an adjective). "The Slow-Burn Confessor", "The Escalation Ghoul", "The Clockwork Noticer".
const NOUN = { absurd: 'Surrealist', deadpan: 'Straight Face', observational: 'Noticer', dark: 'Ghoul', story: 'Storyteller', wordplay: 'Punsmith', rant: 'Firebrand', selfdep: 'Confessor', crowd: 'Ringmaster' }
const AXADJ = { absurd: 'Absurdist', deadpan: 'Deadpan', observational: 'Observant', dark: 'Midnight', story: 'Long-Game', wordplay: 'Wordplay', rant: 'Ranting', selfdep: 'Self-Roasting', crowd: 'Crowd-Working' }
const MOD = {
  hold: ['Slow-Burn', 'Quick-Draw'], energy: ['Escalation', 'Low-Key'], pace: ['Rapid-Fire', 'Long-Fuse'],
  talkshow: ['Late-Night', 'Club'], vertical: ['Short-Form', 'Long-Form'], long: ['Long-Haul', 'Bite-Size'], clean: ['Clean', 'Filthy'],
  op_split_knowledge: ['Knowing'], op_repeat_variation: ['Callback'], op_double_interpret: ['Double-Edged'], op_status_invert: ['Status-Flipping'],
  op_rigidify: ['Clockwork'], op_juxtapose: ['Mismatch'], op_literalize: ['Literal'], op_literalize_or_other: ['Literal'], op_false_analogy: ['Bogus-Logic'],
  op_unmask: ['Unmasking'], op_expose_self_blindness: ['Blind-Spot'], op_mistake_identity: ['Mix-Up'], op_role_reverse: ['Role-Swap'], op_identity_contradict: ['Contradiction'], op_character_violation: ['Off-Script'],
}
export function typeName(p) {
  const axes = TYPES.map((t, i) => ({ t, i, ...feat(p, 'ax_' + t.k) }))
  const evidence = (p?.n?.votes || 0) + (p?.n?.favs || 0)
  const ranked = [...axes].sort((a, b) => b.w - a.w)
  const top = ranked[0]
  if (!evidence || top.w < 0.12) return { name: 'The Open Book', noun: 'Open Book', mod: '', k: null, settled: false }
  let best = null
  for (const [k, words] of Object.entries(MOD)) {
    const f = feat(p, k); if (!f.has) continue
    const word = f.w >= 0 ? words[0] : words[1]; if (!word) continue
    const score = Math.abs(f.w) * (0.5 + 0.5 * f.c) * (k.startsWith('op_') ? 0.8 : 1)
    if (Math.abs(f.w) >= 0.12 && (!best || score > best.score)) best = { word, score, k }
  }
  const second = ranked[1]
  if ((!best || best.score < 0.6 * second.w) && second.w >= 0.12) best = { word: AXADJ[second.t.k], k: 'ax_' + second.t.k }
  const mod = best?.word || ''
  return { name: `The ${mod ? mod + ' ' : ''}${NOUN[top.t.k]}`, noun: NOUN[top.t.k], mod, k: top.t.k, modFrom: best?.k || null, settled: true }
}

// ---------- L1: the glyph ----------
// enneagram geometry: point k (1..9) at -90 + 40k degrees, so 9 sits on top; hexad 1-4-2-8-5-7-1, triangle 3-6-9
const HEXAD = [1, 4, 2, 8, 5, 7, 1], TRIANGLE = [3, 6, 9, 3]
const OPAX = { op_double_interpret: 'wordplay', op_literalize: 'wordplay', op_literalize_or_other: 'wordplay', op_juxtapose: 'absurd', op_false_analogy: 'absurd', op_rigidify: 'observational',
  op_status_invert: 'rant', op_expose_self_blindness: 'selfdep', op_unmask: 'rant', op_repeat_variation: 'story', op_split_knowledge: 'deadpan', op_mistake_identity: 'absurd', op_role_reverse: 'absurd',
  op_identity_contradict: 'selfdep', op_character_violation: 'absurd', energy: 'rant', hold: 'deadpan', pace: 'wordplay', talkshow: 'observational', vertical: 'wordplay', long: 'story', clean: 'observational' }
export function glyphSVG(p, opts = {}) {
  const S = opts.size || 360, cx = S / 2, cy = S / 2, R = S * (opts.labels ? 0.3 : 0.36), id = (opts.id || 'g') + (p?.hash || 'x').slice(0, 6)
  const rnd = rng(seedOf(p)), spin = (rnd() - 0.5) * 6 // a few degrees of personal tilt, deterministic per passport
  const ang = (k) => ((-90 + 40 * k + spin) * Math.PI) / 180
  const pt = (k, r = R) => [cx + Math.cos(ang(k)) * r, cy + Math.sin(ang(k)) * r]
  const A = TYPES.map((t, i) => ({ t, k: i + 1, ...feat(p, 'ax_' + t.k) }))
  const tn = typeName(p), dom = tn.k ? A.find((a) => a.t.k === tn.k) : null
  const wingK = dom ? (() => { const l = A[(dom.k + 7) % 9], r = A[dom.k % 9]; return l.w >= r.w ? l : r })() : null
  const gm = opts.labels ? Math.round(S * 0.08) : 0
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-gm} 0 ${S + 2 * gm} ${S}" class="sigil${opts.animate === false ? '' : ' anim'}" role="img" aria-label="${esc((opts.title || 'Humour glyph') + ': ' + tn.name)}">`
  g += `<defs>${[0, 1, 2, 3].map((b) => `<filter id="${id}b${b}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${[2, 6, 12, 20][b] * S / 360}"/></filter>`).join('')}
    <radialGradient id="${id}bg"><stop offset="0" stop-color="#1a1420"/><stop offset="1" stop-color="#07070a" stop-opacity="0"/></radialGradient></defs>`
  g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.49}" fill="url(#${id}bg)"/>`
  // star dust: deterministic per passport
  for (let i = 0; i < 46; i++) { const a = rnd() * 2 * Math.PI, r = S * (0.08 + 0.42 * Math.sqrt(rnd())); g += `<circle cx="${f1(cx + Math.cos(a) * r)}" cy="${f1(cy + Math.sin(a) * r)}" r="${f1(0.4 + rnd() * 1.1)}" fill="rgba(255,255,255,${f1(0.08 + rnd() * 0.25)})"/>` }
  // colour cloud: one blob per type, size = lean, blur = uncertainty, hue = the type's own colour
  g += '<g class="sg-cloud">'
  for (const a of A) {
    if (a.w <= 0.02) continue
    const [x, y] = pt(a.k, R * 0.72), r = S * (0.07 + 0.2 * clamp(a.w, 0, 1) / 1), blur = a.c > 0.6 ? 1 : a.c > 0.3 ? 2 : 3
    g += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="hsla(${a.t.hue},${Math.round(45 + 45 * clamp(a.w, 0, 1) / 1)}%,58%,${f1(0.3 + 0.35 * a.c)})" filter="url(#${id}b${blur})"/>`
  }
  g += '</g><g class="sg-rot">'
  g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="${f1(S / 260)}"/>`
  // dominant -> wing arc along the circle
  if (dom && wingK) {
    const [x1, y1] = pt(dom.k), [x2, y2] = pt(wingK.k), sweep = ((wingK.k - dom.k + 9) % 9) === 1 ? 1 : 0
    g += `<path d="M${f1(x1)},${f1(y1)} A${R},${R} 0 0 ${sweep} ${f1(x2)},${f1(y2)}" fill="none" stroke="hsla(${dom.t.hue},85%,65%,.8)" stroke-width="${f1(S / 90)}" stroke-linecap="round"/>`
  }
  // inner figure: edges weighted by both ends
  const edge = (a, b) => {
    const A1 = A[a - 1], B1 = A[b - 1], w = (A1.w + B1.w) / 2, c = (A1.c + B1.c) / 2, [x1, y1] = pt(a), [x2, y2] = pt(b)
    return `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${tone(w * 2, 0.42 + 0.5 * c)}" stroke-width="${f1((1 + 5 * clamp(Math.abs(w), 0, 1) / 1) * S / 360)}" stroke-linecap="round"/>`
  }
  for (const seq of [HEXAD, TRIANGLE]) for (let i = 0; i < seq.length - 1; i++) g += edge(seq[i], seq[i + 1])
  // feature satellites: every non-axis feature with evidence, wired to the point it feeds
  const sats = Object.keys(OPAX).map((k) => ({ k, ...feat(p, k) })).filter((f) => f.has && Math.abs(f.w) > 0.04)
  const perAx = {}
  for (const f of sats) {
    const ax = A.find((a) => a.t.k === OPAX[f.k]), j = (perAx[ax.k] = (perAx[ax.k] || 0) + 1), off = (j % 2 ? 1 : -1) * Math.ceil(j / 2) * 7 * Math.PI / 180
    const a0 = ang(ax.k) + off, rr = R * (1.2 + 0.06 * (j % 3)), x = cx + Math.cos(a0) * rr, y = cy + Math.sin(a0) * rr, [px, py] = pt(ax.k)
    g += `<line x1="${f1(px)}" y1="${f1(py)}" x2="${f1(x)}" y2="${f1(y)}" stroke="${tone(f.w, 0.2 + 0.5 * f.c)}" stroke-width="${f1((0.4 + 2.2 * clamp(Math.abs(f.w), 0, 1.5) / 1.5) * S / 360)}"/>`
    g += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1((1.4 + 2.6 * clamp(Math.abs(f.w), 0, 1.5) / 1.5) * S / 360)}" fill="${tone(f.w, 0.5 + 0.5 * f.c)}"/>`
  }
  // the nine points
  for (const a of A) {
    const [x, y] = pt(a.k), on = Math.max(0, a.w), r = (4 + 11 * clamp(on, 0, 1) / 1) * S / 360, isDom = dom && a.k === dom.k, isWing = wingK && a.k === wingK.k
    if (isDom) g += `<circle class="sg-dom" cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 2.6)}" fill="hsla(${a.t.hue},90%,62%,.35)" filter="url(#${id}b1)"/>`
    g += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${a.w >= 0 ? `hsla(${a.t.hue},${Math.round(30 + 60 * clamp(on, 0, 1.2) / 1.2)}%,62%,${f1(0.45 + 0.55 * a.c)})` : tone(a.w, 0.5)}" stroke="rgba(255,255,255,${isDom ? '.95' : isWing ? '.7' : '.25'})" stroke-width="${f1((isDom ? 2.2 : isWing ? 1.4 : 0.8) * S / 360)}"/>`
  }
  g += '</g>'
  if (opts.labels) A.forEach((a) => { const [x, y] = pt(a.k, R * 1.48); g += `<text x="${f1(x)}" y="${f1(y)}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(S / 34)}" fill="rgba(255,255,255,${dom && a.k === dom.k ? '.95' : '.55'})" font-family="Inter Tight, system-ui, sans-serif" font-weight="${dom && a.k === dom.k ? 800 : 600}">${esc(a.t.short)}</text>` })
  return g + '</svg>'
}

// ---------- L2: the meta-axes ----------
// each meta-axis = a weighted sum of feature weights (features the model doesn't have drop out; an axis with none is
// drawn as "no data yet"). Negative pole first, positive pole second.
export const META = [
  { k: 'delivery', label: 'Delivery', lo: 'deadpan', hi: 'manic', mix: { energy: 1, ax_deadpan: -0.6, hold: -0.3, ax_rant: 0.3 } },
  { k: 'structure', label: 'Structure', lo: 'setup', hi: 'punch-heavy', mix: { ax_wordplay: 0.8, pace: 0.6, ax_story: -0.8, long: -0.4, op_repeat_variation: -0.3 } },
  { k: 'risk', label: 'Risk', lo: 'clean', hi: 'transgressive', mix: { ax_dark: 1, clean: -1, op_unmask: 0.3 } },
  { k: 'cognition', label: 'Cognition', lo: 'literal', hi: 'absurdist', mix: { ax_absurd: 1, op_double_interpret: 0.5, op_juxtapose: 0.5, op_false_analogy: 0.4, op_literalize: -0.6, op_rigidify: -0.5, ax_observational: -0.3 } },
  { k: 'warmth', label: 'Warmth', lo: 'self-roasting', hi: 'mocking', mix: { ax_rant: 0.7, op_status_invert: 0.5, ax_selfdep: -1, op_expose_self_blindness: -0.4 } },
  { k: 'pace', label: 'Pace', lo: 'slow-burn', hi: 'rapid', mix: { pace: 0.8, hold: -0.8, vertical: 0.3, long: -0.3 } },
  { k: 'press', label: 'Press', lo: 'patient', hi: 'goes for the kill', mix: { ax_crowd: 0.8, ax_rant: 0.4, energy: 0.4, ax_story: -0.6, hold: -0.3 } },
]
export function metaAxes(p) {
  return META.map((m) => {
    let s = 0, v2 = 0, norm = 0, has = 0
    for (const [k, c] of Object.entries(m.mix)) { const f = feat(p, k); norm += Math.abs(c); if (!f.has) continue; has++; s += c * f.w; v2 += (c * f.sd) ** 2 }
    const v = has ? Math.tanh((1.6 * s) / norm) : 0, sd = has ? Math.sqrt(v2) / norm * 1.6 : 1
    return { ...m, v, sd: clamp(sd, 0, 1), has: has > 0 }
  })
}
export function metaSVG(p, opts = {}) {
  const S = opts.size || 360, cx = S / 2, cy = S / 2, R = S * 0.33, id = (opts.id || 'm') + (p?.hash || 'x').slice(0, 6), M = metaAxes(p)
  const ang = (i) => (Math.PI * i) / M.length - Math.PI / 2 // diameters spread over 180 degrees; their ends cover 360
  const mx = Math.round(S * 0.16)
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-mx} 0 ${S + 2 * mx} ${S}" class="metasvg" role="img" aria-label="${esc(opts.title || 'Humour meta-axes')}"><defs>${[0, 1, 2, 3].map((b) => `<filter id="${id}b${b}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${[1.5, 5, 10, 16][b] * S / 360}"/></filter>`).join('')}</defs>`
  g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,.1)"/><circle cx="${cx}" cy="${cy}" r="${R / 2}" fill="none" stroke="rgba(255,255,255,.06)" stroke-dasharray="3 4"/>`
  const pts = []
  M.forEach((m, i) => {
    const a = ang(i), dx = Math.cos(a), dy = Math.sin(a)
    g += `<line x1="${f1(cx - dx * R)}" y1="${f1(cy - dy * R)}" x2="${f1(cx + dx * R)}" y2="${f1(cy + dy * R)}" stroke="rgba(255,255,255,${m.has ? '.13' : '.06'})"${m.has ? '' : ' stroke-dasharray="2 4"'}/>`
    const x = cx + dx * R * m.v, y = cy + dy * R * m.v
    pts.push([x, y])
    if (m.has) {
      const blur = m.sd < 0.25 ? 0 : m.sd < 0.45 ? 1 : m.sd < 0.7 ? 2 : 3
      g += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(S * (0.04 + 0.08 * Math.abs(m.v)))}" fill="${tone(m.v * 1.5, 0.35 + 0.4 * (1 - m.sd))}" filter="url(#${id}b${blur})"/>`
    }
    const lab = (t, sgn, strong) => { const lx = cx + sgn * dx * R * 1.17, ly = cy + sgn * dy * R * 1.17, anchor = Math.abs(dx) < 0.3 ? 'middle' : sgn * dx > 0 ? 'start' : 'end'
      return `<text x="${f1(lx)}" y="${f1(ly)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="${Math.round(S / 33)}" font-family="Inter Tight, system-ui, sans-serif" font-weight="${strong ? 700 : 500}" fill="rgba(255,255,255,${strong ? '.92' : '.5'})">${esc(t)}</text>` }
    g += lab(m.lo, -1, m.has && m.v < -0.15) + lab(m.hi, 1, m.has && m.v > 0.15)
  })
  // the shape: points in angular order around the circle
  const order = pts.map(([x, y], i) => [Math.atan2(y - cy, x - cx), x, y, M[i].has]).filter((q) => q[3]).sort((a, b) => a[0] - b[0])
  if (order.length >= 3) g += `<polygon points="${order.map((q) => f1(q[1]) + ',' + f1(q[2])).join(' ')}" fill="rgba(245,199,107,.07)" stroke="rgba(245,199,107,.55)" stroke-width="${f1(S / 240)}" stroke-linejoin="round"/>`
  order.forEach((q) => { g += `<circle cx="${f1(q[1])}" cy="${f1(q[2])}" r="${f1(S / 110)}" fill="#f5c76b"/>` })
  g += `<circle cx="${cx}" cy="${cy}" r="${f1(S / 160)}" fill="rgba(255,255,255,.4)"/>`
  return g + '</svg>'
}

// ---------- L3: the net itself ----------
const OUT = [['pair', 'you pick it', null], ['laugh', 'you laugh / rewind', 'gL'], ['finish', 'you finish it', 'gF'], ['skip', 'you skip it', 'gS']]
export function netSVG(p, opts = {}) {
  const all = Object.entries(p?.features || {}).map(([k]) => ({ k, ...feat(p, k) })).filter((f) => f.has || Math.abs(f.w) > 0.05).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  const maxIn = opts.max || 14, ins = all.slice(0, maxIn), more = all.length - ins.length
  const W = opts.width || 640, rowH = 26, H = Math.max(240, 40 + Math.max(ins.length, 1) * rowH + (more > 0 ? 20 : 0))
  const xIn = 196, xS = W * 0.56, xOut = W - 140, yS = H / 2, heads = p?.heads || {}
  let g = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="netsvg" role="img" aria-label="${esc(opts.title || 'Your humour model as a network')}">`
  const font = 'font-family="Inter Tight, system-ui, sans-serif"'
  if (!ins.length) g += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="rgba(255,255,255,.5)" font-size="14" ${font}>No weights yet: vote on a few clashes.</text>`
  ins.forEach((f, i) => {
    const y = 30 + i * rowH, wd = 0.6 + 7 * clamp(Math.abs(f.w), 0, 1.6) / 1.6
    g += `<path d="M${xIn},${y} C${f1((xIn + xS) / 2)},${y} ${f1((xIn + xS) / 2)},${yS} ${f1(xS)},${yS}" fill="none" stroke="${tone(f.w, 0.25 + 0.6 * f.c)}" stroke-width="${f1(wd)}" stroke-linecap="round"/>`
    g += `<circle cx="${xIn}" cy="${y}" r="5" fill="${tone(f.w, 0.9)}"/>`
    g += `<text x="${xIn - 12}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="12.5" ${font} fill="rgba(255,255,255,${f1(0.55 + 0.4 * f.c)})">${esc(f.label)}</text>`
  })
  if (more > 0) g += `<text x="${xIn - 12}" y="${30 + ins.length * rowH}" text-anchor="end" font-size="11" ${font} fill="rgba(255,255,255,.4)">+${more} quieter features</text>`
  // crowd input -> pair (beta)
  const beta = Number.isFinite(heads.beta) ? heads.beta : 1
  g += `<path d="M${xS},${H - 16} C${f1((xS + xOut) / 2)},${H - 16} ${f1((xS + xOut) / 2)},30 ${xOut},30" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="${f1(0.6 + 2 * clamp(beta, 0, 3) / 3)}" stroke-dasharray="3 4"/>`
  g += `<text x="${xS}" y="${H - 4}" text-anchor="middle" font-size="10.5" ${font} fill="rgba(255,255,255,.4)">crowd rating</text>`
  OUT.forEach(([k, label, hk], i) => {
    const y = 30 + i * ((H - 70) / 3), w = hk ? (Number.isFinite(heads[hk]) ? heads[hk] : 0.3) * (k === 'skip' ? -1 : 1) : 1
    g += `<line x1="${xS}" y1="${yS}" x2="${xOut}" y2="${f1(y)}" stroke="${tone(w * 1.2, 0.75)}" stroke-width="${f1(0.8 + 4 * clamp(Math.abs(w), 0, 1.5) / 1.5)}"/>`
    g += `<circle cx="${xOut}" cy="${f1(y)}" r="6" fill="${tone(w * 1.2, 0.95)}"/><text x="${xOut + 12}" y="${f1(y)}" dominant-baseline="middle" font-size="12" ${font} fill="rgba(255,255,255,.82)">${esc(label)}</text>`
  })
  g += `<circle cx="${f1(xS)}" cy="${yS}" r="15" fill="#1a1620" stroke="#f5c76b" stroke-width="2"/><text x="${f1(xS)}" y="${yS + 1}" text-anchor="middle" dominant-baseline="middle" font-size="13" ${font} font-weight="800" fill="#f5c76b">\u03a3</text>`
  g += `<text x="${f1(xS)}" y="${yS - 24}" text-anchor="middle" font-size="11" ${font} fill="rgba(255,255,255,.55)">your taste</text>`
  return g + '</svg>'
}

// ---------- versions: interpolate two passports (the morph) and diff them ----------
export function lerpPassport(a, b, t) {
  const ks = new Set([...Object.keys(a?.features || {}), ...Object.keys(b?.features || {})]), F = {}
  for (const k of ks) {
    const x = a?.features?.[k] || { w: 0, sd: 1, n: 0, group: b.features[k]?.group, label: b.features[k]?.label }, y = b?.features?.[k] || { ...x, w: 0, n: 0 }
    F[k] = { ...y, w: x.w + (y.w - x.w) * t, sd: (x.sd ?? 1) + ((y.sd ?? 1) - (x.sd ?? 1)) * t, n: (x.n || 0) + ((y.n || 0) - (x.n || 0)) * t }
  }
  const H = {}; for (const k of new Set([...Object.keys(a?.heads || {}), ...Object.keys(b?.heads || {})])) H[k] = (a?.heads?.[k] ?? 0) + ((b?.heads?.[k] ?? 0) - (a?.heads?.[k] ?? 0)) * t
  return { ...(t < 0.5 ? a : b), features: F, heads: H, n: t < 0.5 ? a.n : b.n }
}
export function diffPassports(a, b, top = 8) {
  const ks = new Set([...Object.keys(a?.features || {}), ...Object.keys(b?.features || {})]), out = []
  for (const k of ks) { const x = a?.features?.[k]?.w || 0, y = b?.features?.[k]?.w || 0; if (Math.abs(y - x) >= 0.02) out.push({ k, label: b?.features?.[k]?.label || a?.features?.[k]?.label || k, from: x, to: y, d: y - x }) }
  return out.sort((p, q) => Math.abs(q.d) - Math.abs(p.d)).slice(0, top)
}
