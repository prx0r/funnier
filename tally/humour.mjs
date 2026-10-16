// Funnier humour algorithm (characters2 docs/FUNNIER-INTEGRATION.md §4c), run offline.
// Per signed-in user: a weighted, L2-regularised logistic regression over characters2 bit theory features
// (15 comedy-theory operators one-hot + has_punch, punch_ratio, pos_in_special), labelled from watch signals:
//   1 = laughed there   (a jump back: the stretch between where they jumped TO and FROM was rewatched)
//   0 = swiped from it  (the ~15s before a clip was skipped / swiped away)
// Bits come from the time map (tally/bitmap.mjs): clips with special_id + t_start give the exact bits on screen;
// clips matched to a special without t_start fall back to that special's operator mix (weight 0.35); other clips of
// a comic characters2 covers fall back to the comic's measured operator priors (weight 0.2); comics with no theory
// data (e.g. Mark Normand) contribute nothing. Each profile records how much of it rests on each basis.
//
// CLI (from funnier/; needs a characters2 clone; reads D1 with wrangler, writes humour_profiles, which GET /me/humour serves):
//   node tally/humour.mjs [--c2 ../../characters2] [--remote | --local] [--dry]
// Bit text never leaves this machine: only the fitted weights and one line of prose are stored.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bitsInWindow } from './bitmap.mjs'

export const OPS = ['split_knowledge', 'repeat_variation', 'double_interpret', 'status_invert', 'rigidify', 'juxtapose', 'literalize', 'mistake_identity',
  'literalize_or_other', 'expose_self_blindness', 'false_analogy', 'identity_contradict', 'unmask', 'role_reverse', 'character_violation']
export const OP_LABEL = {
  split_knowledge: 'dramatic irony', repeat_variation: 'callbacks and repetition', double_interpret: 'double meanings', status_invert: 'status flips',
  rigidify: 'rigid, mechanical behaviour', juxtapose: 'odd juxtapositions', literalize: 'taking things literally', mistake_identity: 'mistaken identity',
  literalize_or_other: 'literal-minded turns', expose_self_blindness: 'people blind to themselves', false_analogy: 'bogus logic',
  identity_contradict: 'self-contradiction', unmask: 'unmasking pretence', role_reverse: 'role reversals', character_violation: 'characters breaking type',
}
export const FEATURES = [...OPS, 'has_punch', 'punch_ratio', 'pos_in_special']
const W_BIT = 1, W_SPECIAL = 0.35, W_COMIC = 0.2, SWIPE_LOOKBACK = 15
export const MIN_EVENTS = 6, MIN_EACH = 2

const bitVec = (b) => [...OPS.map((o) => ((b.ops || []).includes(o) ? 1 : 0)), b.feat.has_punch || 0, b.feat.punch_ratio || 0, b.feat.pos_in_special || 0]
const mixVec = (ops) => [...OPS.map((o) => +ops?.[o] || 0), 0.5, 0.3, 0.5]

// ---------- watch signals -> labelled moments ----------
// votes: { a, b, signals: { shown: [left, right], leftSeekTargets, leftSeekFrom, leftSkippedAt, right... } }
// events (skips / passes): { a, b, signals } with a = clip one, b = clip two
export function moments(votes, events) {
  const out = []
  const fromSig = (sg, left, right) => {
    for (const [side, id] of [['left', left], ['right', right]]) {
      if (!id) continue
      const to = sg[side + 'SeekTargets'] || [], fr = sg[side + 'SeekFrom'] || []
      to.forEach((t, i) => out.push({ clip: id, y: 1, t0: t, t1: Number.isFinite(fr[i]) ? fr[i] : t + 10 }))
      if (Number.isFinite(sg[side + 'SkippedAt'])) out.push({ clip: id, y: 0, t0: Math.max(0, sg[side + 'SkippedAt'] - SWIPE_LOOKBACK), t1: sg[side + 'SkippedAt'] })
    }
  }
  for (const v of votes || []) { const sg = v?.signals; if (!sg) continue; const [l, r] = Array.isArray(sg.shown) ? sg.shown : [v.a, v.b]; fromSig(sg, l, r) }
  for (const e of events || []) { const sg = e?.signals; if (sg) fromSig(sg, e.a, e.b) }
  return out
}

// ---------- moments -> feature rows ----------
export function rows(ms, { clipsById, theory, loadBits }) {
  const R = []
  for (const m of ms) {
    const c = clipsById[m.clip]; if (!c) continue
    const sp = c.special_id ? theory.specials?.[c.special_id] : null
    const bits = sp && c.t_start != null ? bitsInWindow(c, sp, loadBits(theory.comics?.[c.comic]?.slug, c.special_id), m.t0, m.t1) : []
    if (bits.length) { for (const b of bits) R.push({ x: bitVec(b), y: m.y, w: W_BIT / bits.length, basis: 'bit' }); continue }
    if (sp) { R.push({ x: mixVec(sp.ops), y: m.y, w: W_SPECIAL, basis: 'special' }); continue }
    const cm = theory.comics?.[c.comic]
    if (cm?.ops) R.push({ x: mixVec(cm.ops), y: m.y, w: W_COMIC, basis: 'comic' })
  }
  return R
}

// ---------- weighted L2 logistic regression (gradient ascent) ----------
export function fitLogistic(R, { lambda = 1, iters = 800, lr = 1.2 } = {}) {
  const d = FEATURES.length, w = new Array(d).fill(0); let b = 0
  const W = R.reduce((s, r) => s + r.w, 0) || 1
  for (let it = 0; it < iters; it++) {
    const g = w.map((x) => (-lambda * x) / W); let gb = 0
    for (const r of R) { let z = b; for (let j = 0; j < d; j++) z += w[j] * r.x[j]; const e = r.w * (r.y - 1 / (1 + Math.exp(-z))); for (let j = 0; j < d; j++) g[j] += (e * r.x[j]) / W; gb += e / W }
    for (let j = 0; j < d; j++) w[j] += lr * g[j]
    b += lr * gb
  }
  return { w: Object.fromEntries(FEATURES.map((f, j) => [f, Math.round(w[j] * 1000) / 1000])), b: Math.round(b * 1000) / 1000 }
}

// ---------- the profile, in prose ----------
export function profile(ms, R) {
  const laughs = ms.filter((m) => m.y === 1).length, swipes = ms.length - laughs
  const basis = { bit: 0, special: 0, comic: 0 }; for (const r of R) basis[r.basis] += r.w
  for (const k in basis) basis[k] = Math.round(basis[k] * 100) / 100
  const ready = ms.length >= MIN_EVENTS && laughs >= MIN_EACH && swipes >= MIN_EACH && R.length > 0
  const base = { n: ms.length, laughs, swipes, basis, ready, updated: new Date().toISOString() }
  if (!R.length) return { ...base, weights: null, top: [], avoid: [], line: null }
  const { w, b } = fitLogistic(R)
  const support = Object.fromEntries(OPS.map((o, j) => [o, R.reduce((s, r) => s + r.w * r.x[j], 0)]))
  const ranked = OPS.filter((o) => support[o] >= 0.3).sort((x, y) => w[y] - w[x])
  const top = ranked.filter((o) => w[o] > 0.05).slice(0, 2), avoid = ranked.filter((o) => w[o] < -0.1 && !top.includes(o)).slice(-1)
  let line = null
  if (top.length) {
    line = `You laugh hardest at ${top.map((o) => OP_LABEL[o]).join(' and ')}`
    if (w.has_punch > 0.3) line += ', set up tight and hit hard'
    line += avoid.length ? `, and drift off at ${OP_LABEL[avoid[0]]}.` : '.'
  }
  return { ...base, weights: w, bias: b, top, avoid, line }
}

// ---------- CLI: D1 -> profiles -> D1 ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
  const C2 = path.resolve(arg('--c2') || process.env.CHARACTERS2 || '../../characters2')
  const where = process.argv.includes('--local') ? '--local' : '--remote', dry = process.argv.includes('--dry')
  const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const clips = J('clips.json'), theory = J('site/theory.json')
  const clipsById = Object.fromEntries(clips.map((c) => [c.id, c]))
  const cache = {}
  const loadBits = (slug, special) => {
    const k = slug + '/' + special
    if (!(k in cache)) { const p = path.join(C2, 'theory', 'transcripts', 'bits_annotated', slug || '-', special + '.bits.json'); cache[k] = fs.existsSync(p) ? J(p).bits || [] : [] }
    return cache[k]
  }
  const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'funnier', where, '--json', '--command', sql], { cwd: 'api', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }))[0].results
  const parse = (s) => { try { return JSON.parse(s) } catch { return null } }
  const votes = d1('SELECT user_id, a, b, signals FROM votes WHERE signals IS NOT NULL').map((r) => ({ ...r, signals: parse(r.signals) }))
  const events = d1('SELECT user_id, kind, a, b, signals FROM watch_events WHERE signals IS NOT NULL').map((r) => ({ ...r, signals: parse(r.signals) }))
  const users = [...new Set([...votes, ...events].map((r) => r.user_id))]
  const sql = []
  for (const u of users) {
    const ms = moments(votes.filter((v) => v.user_id === u), events.filter((e) => e.user_id === u))
    if (!ms.length) continue
    const p = profile(ms, rows(ms, { clipsById, theory, loadBits }))
    console.log(u.slice(0, 8), JSON.stringify({ n: p.n, laughs: p.laughs, swipes: p.swipes, basis: p.basis, ready: p.ready, line: p.line }))
    sql.push(`INSERT OR REPLACE INTO humour_profiles (user_id, profile, updated_at) VALUES ('${u.replace(/'/g, "''")}', '${JSON.stringify(p).replace(/'/g, "''")}', '${p.updated}');`)
  }
  console.log(`${users.length} users with signals, ${sql.length} profiles`)
  if (sql.length && !dry) {
    const f = path.join(fs.mkdtempSync('/tmp/humour-'), 'profiles.sql')
    fs.writeFileSync(f, sql.join('\n') + '\n')
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'funnier', where, '--file', f], { cwd: 'api', stdio: 'ignore' })
    console.log('written to D1', where)
  }
}
