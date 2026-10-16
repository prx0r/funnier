// struct_sim(a, b) in [0, 1]: how much two clips share a structural "thing" (characters2 docs/FUNNIER-INTEGRATION.md §4a).
// Shared by the client (bundled into site/app.js) and the tally (tally/tally.mjs imports this file). Pure, no I/O.
// A weighted blend of the components both clips have; missing components drop out and the weights renormalise:
//   style Jaccard (clips.json style)         0.25     operator overlap (cosine of op lift)    0.25
//   topic Jaccard (clips.json topics)        0.15     stylometry closeness (z-scored)         0.15
//   delivery archetype match                 0.15     MARY closeness (arousal/valence/power)  0.05
// Operator mixes and stylometry use the matched special when both clips have one, otherwise the comic's (theory.json).
// A clip's own operator mix (clips.json ops, opsSource "bits": the bits on screen, tools/import-clip-features.mjs) beats both.
export const SIM_W = { style: 0.25, ops: 0.25, topic: 0.15, sty: 0.15, arch: 0.15, mary: 0.05 }
const arr = (x) => (Array.isArray(x) ? x : [])
function jaccard(a, b) {
  const A = new Set(arr(a)), B = new Set(arr(b)); if (!A.size || !B.size) return null
  let n = 0; for (const x of A) if (B.has(x)) n++
  return n / (A.size + B.size - n)
}
// cosine of the two operator mixes' lift over the roster mean (every comic leans on split_knowledge), mapped to [0, 1]
function opsClose(p, q, mean) {
  if (!p || !q) return null
  const m = mean || {}, ks = new Set([...Object.keys(p), ...Object.keys(q), ...Object.keys(m)]); let d = 0, np = 0, nq = 0
  for (const k of ks) { const x = (+p[k] || 0) - (+m[k] || 0), y = (+q[k] || 0) - (+m[k] || 0); d += x * y; np += x * x; nq += y * y }
  return np && nq ? (1 + d / Math.sqrt(np * nq)) / 2 : null
}
function styClose(s, t, scale) {
  if (!s || !t || !scale) return null
  let sum = 0, n = 0
  for (const k of Object.keys(scale)) { const x = s[k], y = t[k], sd = scale[k]?.sd || 1; if (Number.isFinite(x) && Number.isFinite(y)) { sum += ((x - y) / sd) ** 2; n++ } }
  return n ? Math.exp(-Math.sqrt(sum / n)) : null // RMS z-distance 0 -> 1, 1 sd -> 0.37
}
function maryClose(m, n) {
  if (!m || !n) return null
  const d = Math.hypot(m.arousal - n.arousal, m.valence - n.valence, m.power - n.power)
  return Number.isFinite(d) ? Math.max(0, 1 - d / Math.sqrt(3)) : null
}
// opts.pairing: for choosing a matchup, comic-level traits shared by two clips of the SAME comic are identical by
// construction, not evidence, so they drop out (special-level ones still count when both clips have a special).
// Recommendation (contentSim) keeps them: liking one Norm clip is a fair reason to expect another.
export function structParts(a, b, T, opts = {}) {
  if (!a || !b) return {}
  const same = opts.pairing && a.comic === b.comic
  const ca = T?.comics?.[a.comic], cb = T?.comics?.[b.comic]
  const sa = a.special_id ? T?.specials?.[a.special_id] : null, sb = b.special_id ? T?.specials?.[b.special_id] : null
  const both = !!(sa && sb && (!same || a.special_id !== b.special_id))
  const comicOk = !same
  return {
    style: jaccard(a.style, b.style),
    topic: jaccard(a.topics, b.topics),
    arch: comicOk && ca?.archetype && cb?.archetype ? (ca.archetype === cb.archetype ? 1 : 0) : null,
    mary: comicOk ? maryClose(ca?.mary, cb?.mary) : null,
    sty: both ? styClose(sa.sty, sb.sty, T?.styScale) : comicOk ? styClose(ca?.sty, cb?.sty, T?.styScale) : null,
    ops: a.ops && b.ops ? opsClose(a.ops, b.ops, T?.opsMean) // both clip-level: real evidence even within one comic
      : (a.ops || b.ops) && comicOk ? opsClose(a.ops || sa?.ops || ca?.ops, b.ops || sb?.ops || cb?.ops, T?.opsMean)
      : both ? opsClose(sa.ops, sb.ops, T?.opsMean) : comicOk ? opsClose(ca?.ops, cb?.ops, T?.opsMean) : null,
  }
}
export function structSim(a, b, T, opts) {
  const p = structParts(a, b, T, opts); let s = 0, w = 0
  for (const [k, wk] of Object.entries(SIM_W)) if (p[k] != null && Number.isFinite(p[k])) { s += wk * p[k]; w += wk }
  return w ? Math.round((s / w) * 1000) / 1000 : 0
}
