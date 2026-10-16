// Per-clip granularity from characters2 (corpus/clip_features.json + bits_annotated), run AFTER tools/import-theory.mjs.
// Node 22+, no deps. From funnier/:  node tools/import-clip-features.mjs [--c2 <prx0r/characters2 clone>]   (default ../../characters2, or $CHARACTERS2)
// Idempotent. Writes:
//   site/theory.json  adds a specials[] block (duration, op mix over its bits, stylometry, laugh density) for every
//                     special_id a clip carries that the importer did not already cover (e.g. the corpus-merged offset clips).
//   clips.json        ops / opsSource:"bits" / opsN: the operator mix of the bits on screen for clips placed inside a special
//                     (t_start, or transcript_offset.frac_through), shrunk toward the special's mix (K pseudo-labels);
//                     style + tagsSource:"auto-meta": conservative tags from metadata only (title, setting, format, duration)
//                     for clips with no style. Nothing else in a clip is touched.
// clip_features.json is joined by id, but its archetype / energy / punchline hold / operators are the comic's
// (comedian-graph + operator_frequency, identical for every clip of a comic) and its laugh is the special's, so they
// stay where they already live (theory.json comics / specials) instead of being copied onto each clip.
// Only derived numbers and operator labels leave characters2; no bit text, no transcript, no per-bit rows.
import fs from 'node:fs'
import path from 'node:path'

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const C2 = path.resolve(arg('--c2') || process.env.CHARACTERS2 || '../../characters2')
const TR = path.join(C2, 'theory', 'transcripts'), ML = path.join(TR, 'ml')
if (!fs.existsSync(path.join(TR, 'bits_annotated'))) { console.error('characters2 bits_annotated not found at', C2); process.exit(1) }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clips = J('clips.json'), T = J('site/theory.json'), COMICS = J('site/comics.json').comics
const STY = J(path.join(ML, 'stylometry.json')), LD = J(path.join(ML, 'laugh_density.json'))
const CF = fs.existsSync(path.join(C2, 'corpus', 'clip_features.json')) ? J(path.join(C2, 'corpus', 'clip_features.json')) : []
const OPERATORS = T.operators
const STY_KEYS = ['sent_len_mean', 'sent_len_cv', 'short_sent_frac', 'type_token_ratio', 'function_word_rate', 'i_rate']
const r3 = (x) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 1000) / 1000)
const slugOf = (name) => COMICS[name]?.slug
const bitsCache = {}
function bitsOf(slug, sp) {
  const k = slug + '/' + sp; if (k in bitsCache) return bitsCache[k]
  const p = path.join(TR, 'bits_annotated', slug, sp + '.bits.json')
  return (bitsCache[k] = fs.existsSync(p) ? J(p).bits || [] : [])
}
const topOps = (o, k) => Object.fromEntries(Object.entries(o).filter(([op, x]) => OPERATORS.includes(op) && x > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map(([op, x]) => [op, r3(x)]))
function opCounts(bits) { const c = {}; let n = 0; for (const b of bits) for (const o of b.ops || []) { c[o] = (c[o] || 0) + 1; n++ } return { c, n } }

// ---------- 1. specials the clips point at but theory.json lacks ----------
let addedSpecials = 0
for (const c of clips) {
  const sp = c.special_id; if (!sp || T.specials[sp]) continue
  const slug = slugOf(c.comic), bits = slug ? bitsOf(slug, sp) : []
  if (!bits.length) continue
  const ref = (COMICS[c.comic].specials || []).find((s) => s.id === c.special_ref)
  const ps = STY[slug]?.per_special?.find((x) => x.special === sp), ld = (LD[slug] || []).find((x) => x.special === sp)
  const words = ps?.words || bits.reduce((s, b) => s + (b.n_words || 0), 0)
  const dur = ref?.runtimeMin ? { sec: Math.round(ref.runtimeMin * 60), source: 'runtime' } : { sec: Math.round((words / 150) * 60), source: 'words/150wpm (estimate)' }
  const { c: oc, n } = opCounts(bits)
  T.specials[sp] = {
    comic: c.comic, title: ref?.title || null, ref: c.special_ref || null, durSec: dur.sec, durSource: dur.source, bits: bits.length,
    ops: topOps(Object.fromEntries(Object.entries(oc).map(([o, x]) => [o, x / (n || 1)])), 15),
    sty: ps ? Object.fromEntries(STY_KEYS.map((k) => [k, r3(ps[k])])) : null,
    laugh: ld ? { mean: r3(ld.mean_laugh_pred), p90: r3(ld.p90_laugh_pred), hot: r3(ld.hot_unit_frac) } : null,
  }
  addedSpecials++
}

// ---------- 2. bit-level ops: the bits on screen ----------
const K = 2 // pseudo-labels of the special's own mix: a window with 1-2 labelled bits shouldn't read as a pure type
const MIN_LABELS = 3, MAX_WIDEN = 3 // widen the window (x1.5 steps, up to 3x the clip) until it holds MIN_LABELS op labels
let bitLevel = 0
const bitLog = []
for (const c of clips) {
  delete c.ops; delete c.opsSource; delete c.opsN
  const sp = c.special_id && T.specials[c.special_id], slug = slugOf(c.comic)
  if (!sp || !slug || !sp.durSec) continue
  const f = c.transcript_offset?.frac_through, hasT = c.t_start != null
  if (f == null && !hasT) continue
  const bits = bitsOf(slug, c.special_id); if (!bits.length) continue
  const len = c.dur || c.sec || 60, w = len / sp.durSec
  // t_start: the clip starts there. transcript_offset: where the title's phrase sits, so centre the clip's span on it.
  const lo0 = hasT ? c.t_start / sp.durSec : f - w / 2, hi0 = hasT ? (c.t_start + len) / sp.durSec : f + w / 2
  let win = null
  for (let m = 1; m <= MAX_WIDEN + 1e-9; m *= 1.5) {
    const mid = (lo0 + hi0) / 2, half = ((hi0 - lo0) / 2) * m
    const lo = Math.max(0, mid - half), hi = Math.min(1, mid + half)
    const inWin = bits.filter((b) => b.feat && b.feat.pos_in_special >= lo && b.feat.pos_in_special <= hi)
    win = { inWin, m, ...opCounts(inWin) }
    if (win.n >= MIN_LABELS) break
  }
  if (!win || win.n < 2) { bitLog.push(`${c.id} ${c.comic}: ${win?.n || 0} labelled bit(s) near the clip, too thin (special level stays)`); continue }
  const mix = {}
  for (const o of OPERATORS) { const v = ((win.c[o] || 0) + K * (+sp.ops?.[o] || 0)) / (win.n + K); if (v > 0) mix[o] = v }
  c.ops = topOps(mix, 5); c.opsSource = 'bits'; c.opsN = win.n
  bitLevel++
  bitLog.push(`${c.id} ${c.comic} -> ${win.inWin.length} bits, ${win.n} op labels (window x${r3(win.m)}): ${Object.keys(c.ops).slice(0, 3).join(', ')}`)
}

// ---------- 3. conservative style tags from metadata ----------
const CROWD = /\bcrowd\s*(work|suggestion|question|interaction|yells|asks)|\bcrowdwork\b|\bheckl|\baudience\b|\b(in|to|with|at) the crowd\b|\b(a|an|kooky|chatty|wasted|unruly|crazy|weird) crowd\b|\bcrowd\b.*\b(guy|couple|member)|\bguy in (the )?crowd|\bin crowd\b|\bmid show\b|\bon the spot\b|\broasts? (the )?audience/i
const STORY = /\b(story|stories)\b/i
const DARK = /#dark\b/i
let auto = 0, crowd = 0
const tagCount = {}
for (const c of clips) {
  if (c.tagsSource === 'auto-meta') { c.style = []; c.tagsSource = 'draft-auto' }
  if ((c.style || []).length || c.tagsSource === 'draft' || c.kind !== 'human') continue
  const t = c.title || '', s = []
  if (CROWD.test(t)) s.push('crowd-work')
  if (STORY.test(t)) s.push('storytelling')
  if (DARK.test(t)) s.push('dark')
  // a very short vertical Short with no crowd cue is one joke: setup, punch, out
  const sec = c.dur || c.sec
  if (!s.length && c.format === 'vertical' && c.setting === 'stand-up' && sec && sec <= 20 && !/riff|roast|\?/i.test(t)) s.push('one-liners')
  if (!s.length) continue
  c.style = s; c.tagsSource = 'auto-meta'; auto++
  if (s.includes('crowd-work')) crowd++
  for (const x of s) tagCount[x] = (tagCount[x] || 0) + 1
}

// ---------- clip_features join (report only; see header) ----------
const byId = Object.fromEntries(clips.map((c) => [c.id, c]))
const joined = CF.filter((x) => byId[x.clip_id])
const specialLevel = clips.filter((c) => c.special_id && T.specials[c.special_id]).length

let head = ''; try { head = fs.readFileSync(path.join(C2, '.git', 'HEAD'), 'utf8').trim(); if (head.startsWith('ref: ')) head = fs.readFileSync(path.join(C2, '.git', head.slice(5)), 'utf8').trim() } catch {}
T.clipFeatures = { commit: head.slice(0, 7) || null, imported: new Date().toISOString().slice(0, 10), K, minLabels: MIN_LABELS }
fs.writeFileSync('site/theory.json', JSON.stringify(T))
fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1) + '\n')
for (const l of bitLog) console.log(l)
console.log(`clip_features joined ${joined.length}/${CF.length}; specials added ${addedSpecials} -> ${Object.keys(T.specials).length}; clips with special-level features ${specialLevel}; bit-level ops ${bitLevel}; auto-meta style ${auto} (crowd-work ${crowd}) ${JSON.stringify(tagCount)}`)
