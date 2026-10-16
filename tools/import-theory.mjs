// Import the characters2 theory base into Funnier (characters2 docs/FUNNIER-INTEGRATION.md §1, §2 method 1).
// Node 22+, no deps. Run from the funnier/ dir:
//   node tools/import-theory.mjs [--c2 <path to a prx0r/characters2 clone>]   (default ../../characters2, or $CHARACTERS2)
// Writes:
//   site/theory.json  compact, public: per-comic archetype, mary coords (only when measured numerically), energy,
//                     punchline hold, measured operator priors (all non-zero), stylometry, laugh-density summary; plus a
//                     per-special block for the specials our clips are matched to (duration, stylometry, laugh density,
//                     operator mix over its bits). NO bit text, NO transcripts, NO per-bit rows: those stay offline.
//   clips.json        adds special_id (characters2 special slug, or null), special_ref (our comics.json special id,
//                     or null), and t_start/t_source when the clip's own title anchors it inside that special.
// Joins are metadata only: the clip TITLE against characters2's own corpus. Nothing is fetched from YouTube.
import fs from 'node:fs'
import path from 'node:path'

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const C2 = path.resolve(arg('--c2') || process.env.CHARACTERS2 || '../../characters2')
const T = path.join(C2, 'theory')
if (!fs.existsSync(path.join(T, 'transcripts', 'ml', 'operator_frequency.json'))) { console.error('characters2 theory base not found at', C2); process.exit(1) }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clips = J('clips.json')
const COMICS = J('site/comics.json').comics
const ML = path.join(T, 'transcripts', 'ml')
const STY = J(path.join(ML, 'stylometry.json')), OPS = J(path.join(ML, 'operator_frequency.json')), LD = J(path.join(ML, 'laugh_density.json'))
export const OPERATORS = ['split_knowledge', 'repeat_variation', 'double_interpret', 'status_invert', 'rigidify', 'juxtapose', 'literalize', 'mistake_identity',
  'literalize_or_other', 'expose_self_blindness', 'false_analogy', 'identity_contradict', 'unmask', 'role_reverse', 'character_violation']
const STY_KEYS = ['sent_len_mean', 'sent_len_cv', 'short_sent_frac', 'type_token_ratio', 'function_word_rate', 'i_rate']
const r3 = (x) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 1000) / 1000)
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)

// our display names <-> characters2 slugs (comics.json carries the slug)
const slugOf = Object.fromEntries(Object.entries(COMICS).map(([name, p]) => [name, p.slug]))
const wanted = [...new Set([...clips.map((c) => c.comic), ...Object.keys(COMICS)])].filter((n) => slugOf[n] && STY[slugOf[n]])

// ---------- comic level ----------
function graph(slug) { const p = path.join(T, 'comedians', slug, 'comedian-graph.json'); return fs.existsSync(p) ? J(p) : null }
function maryNum(m) { // only a measured numeric modulator counts (e.g. Louis: manic {arousal, valence, power}); prose inferences are skipped
  if (!m || typeof m !== 'object') return null
  for (const v of Object.values(m)) if (v && typeof v === 'object' && [v.arousal, v.valence, v.power].every((x) => Number.isFinite(x))) return { arousal: v.arousal, valence: v.valence, power: v.power }
  return null
}
function topOps(pri, k = 5) { return Object.fromEntries(Object.entries(pri || {}).filter(([o, x]) => OPERATORS.includes(o) && x > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map(([o, x]) => [o, r3(x)])) }
const comics = {}
for (const name of wanted) {
  const slug = slugOf[name], g = graph(slug), s = STY[slug], ld = Array.isArray(LD[slug]) ? LD[slug] : []
  comics[name] = {
    slug,
    archetype: g?.engine?.delivery_archetype || null,
    mary: maryNum(g?.engine?.mary_coords),
    energy: Number.isFinite(g?.identity?.profile?.energy) ? g.identity.profile.energy : null,
    holdMs: Number.isFinite(g?.identity?.profile?.punchline_hold_ms) ? g.identity.profile.punchline_hold_ms : null,
    ops: topOps(OPS[slug]?.normalized_priors, 15), // measured on the comic's transcripts (operator_frequency.json), all non-zero operators
    sty: Object.fromEntries(STY_KEYS.map((k) => [k, r3(s?.[k])])),
    laugh: ld.length ? { mean: r3(mean(ld.map((x) => x.mean_laugh_pred))), p90: r3(mean(ld.map((x) => x.p90_laugh_pred))), hot: r3(mean(ld.map((x) => x.hot_unit_frac))), specials: ld.length } : null,
  }
}
// stylometry z-score scale across all 18 characters2 comics, so distances mean the same thing as the roster grows
const styScale = Object.fromEntries(STY_KEYS.map((k) => {
  const v = Object.values(STY).map((s) => s?.[k]).filter(Number.isFinite), m = mean(v)
  return [k, { mean: r3(m), sd: r3(Math.sqrt(mean(v.map((x) => (x - m) ** 2))) || 1) }]
}))

// roster mean operator mix (all 18 comics): struct_sim compares each mix's lift over this, since every comic leans on split_knowledge
const opsMean = Object.fromEntries(OPERATORS.map((o) => [o, r3(mean(Object.values(OPS).map((x) => +x?.normalized_priors?.[o] || 0)))]))

// ---------- special join (§2 method 1: the title names the special) ----------
const STOP = new Set('the a an of and or to in on at for with from my your his her our their is are was be it its this that how why what when who live special clip part pt full best stand up standup comedy netflix is joke outtake'.split(' '))
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const toks = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w))
function c2Specials(slug) { const d = path.join(T, 'transcripts', 'bits_annotated', slug); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.bits.json')).map((f) => f.replace(/\.bits\.json$/, '')) : [] }
function matchSpecial(c) {
  const P = COMICS[c.comic]; if (!P || /outtake/i.test(c.title)) return null // an outtake is by definition not in the special
  const tt = new Set(norm(c.title).split(' '))
  const nameT = new Set(norm(c.comic).split(' '))
  let best = null
  for (const s of P.specials || []) {
    const st = toks(s.title).filter((w) => !nameT.has(w))
    if (!st.length || st.every((w) => /^\d+$/.test(w))) continue // a bare year ("2017") is too generic to trust
    if (st.every((w) => tt.has(w)) && (!best || st.length > best.st.length)) best = { s, st }
  }
  if (!best) return null
  // our special -> the characters2 transcript of the same special (all title tokens in the slug; the plain cut beats an extended one)
  const cands = c2Specials(slugOf[c.comic]).filter((sl) => best.st.every((w) => norm(sl).split(' ').includes(w)))
    .sort((a, b) => /extended|epilogue/.test(a) - /extended|epilogue/.test(b) || a.length - b.length)
  return { ref: best.s.id, title: best.s.title, runtimeMin: best.s.runtimeMin || null, special_id: cands[0] || null, specialTokens: best.st }
}
function bitsOf(slug, special) { const p = path.join(T, 'transcripts', 'bits_annotated', slug, special + '.bits.json'); return fs.existsSync(p) ? J(p).bits || [] : [] }
function specialDur(slug, special, runtimeMin) {
  if (runtimeMin) return { sec: Math.round(runtimeMin * 60), source: 'runtime' }
  const words = STY[slug]?.per_special?.find((x) => x.special === special)?.words || bitsOf(slug, special).reduce((s, b) => s + (b.n_words || 0), 0)
  return { sec: Math.round((words / 150) * 60), source: 'words/150wpm (estimate)' }
}
// title anchor: the clip title's own topic words (minus the special's name), found clustered in one place of the special's bits
function anchor(c, m, bits, dur) {
  const nameT = new Set([...norm(c.comic).split(' '), ...m.specialTokens])
  const words = [...new Set(toks(c.title).filter((w) => !nameT.has(w) && w.length >= 3 && !/^\d+$/.test(w)))]
  if (!words.length || !bits.length) return null
  const stem = (w) => w.slice(0, Math.max(4, Math.min(6, w.length - 1)))
  const pre = words.map(stem)
  const hit = bits.map((b) => { const bw = norm(b.text).split(' '); return pre.filter((p) => bw.some((x) => x.startsWith(p))).length })
  const W = 5, win = hit.map((_, i) => hit.slice(i, i + W).reduce((s, x) => s + x, 0))
  let bi = 0; win.forEach((x, i) => { if (x > win[bi]) bi = i })
  const second = Math.max(0, ...win.filter((_, i) => Math.abs(i - bi) > 10))
  const need = Math.max(2, Math.min(words.length, 3))
  if (win[bi] < need || win[bi] < 1.5 * second) return null
  let first = bi; while (first < bi + W - 1 && !hit[first]) first++
  const pos = bits[first].feat?.pos_in_special ?? first / bits.length
  return { t_start: Math.max(0, Math.round(pos * dur - 10)), words, score: win[bi], second }
}

const specials = {}
let matched = 0, anchored = 0
for (const c of clips) {
  if (c.kind !== 'human') continue
  const m = matchSpecial(c)
  c.special_ref = m?.ref || null
  c.special_id = m?.special_id || null
  delete c.t_start; delete c.t_source
  if (!c.special_id) continue
  matched++
  const slug = slugOf[c.comic], bits = bitsOf(slug, c.special_id), dur = specialDur(slug, c.special_id, m.runtimeMin)
  const a = anchor(c, m, bits, dur.sec)
  if (a) { c.t_start = a.t_start; c.t_source = 'title-anchor'; anchored++ }
  console.log(`${c.id} ${c.comic} | ${c.title} -> ${c.special_id}${a ? ` @ ~${a.t_start}s (words ${a.words.join(',')}; window ${a.score} vs ${a.second})` : ''}`)
  if (!specials[c.special_id]) {
    const ps = STY[slug]?.per_special?.find((x) => x.special === c.special_id), ld = (LD[slug] || []).find((x) => x.special === c.special_id)
    const opc = {}; for (const b of bits) for (const o of b.ops || []) opc[o] = (opc[o] || 0) + 1
    const tot = Object.values(opc).reduce((s, x) => s + x, 0) || 1
    specials[c.special_id] = {
      comic: c.comic, title: m.title, ref: m.ref, durSec: dur.sec, durSource: dur.source, bits: bits.length,
      ops: topOps(Object.fromEntries(Object.entries(opc).map(([o, n]) => [o, n / tot])), 15),
      sty: ps ? Object.fromEntries(STY_KEYS.map((k) => [k, r3(ps[k])])) : null,
      laugh: ld ? { mean: r3(ld.mean_laugh_pred), p90: r3(ld.p90_laugh_pred), hot: r3(ld.hot_unit_frac) } : null,
    }
  }
}
let head = ''; try { head = fs.readFileSync(path.join(C2, '.git', 'HEAD'), 'utf8').trim(); if (head.startsWith('ref: ')) head = fs.readFileSync(path.join(C2, '.git', head.slice(5)), 'utf8').trim() } catch {}
const out = {
  _note: 'Derived from prx0r/characters2 (theory/comedians/*/comedian-graph.json, theory/transcripts/ml/{stylometry,operator_frequency,laugh_density}.json and bits_annotated op counts). Regenerate with node tools/import-theory.mjs. Archetype/energy/hold are characters2 hypotheses (7 comics have graphs); ops/stylometry/laugh are measured on transcripts. No transcript text is included.',
  source: { repo: 'prx0r/characters2', commit: head.slice(0, 7) || null, imported: new Date().toISOString().slice(0, 10) },
  operators: OPERATORS, opsMean, styScale, comics, specials,
}
fs.writeFileSync('site/theory.json', JSON.stringify(out))
fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1) + '\n')
console.log(`theory.json: ${Object.keys(comics).length} comics, ${Object.keys(specials).length} specials (${(JSON.stringify(out).length / 1024).toFixed(1)} KB); clips matched ${matched}, anchored ${anchored}`)
