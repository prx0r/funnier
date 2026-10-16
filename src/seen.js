// Seen tracking: one watch-log entry per clip, the "never again" rule for the ROTATION, and how seen clips are
// deprioritised. Pure functions, shared by the client (src/app.js), the smoke tests and the Worker's merge semantics.
//
// Entry (localStorage funnier.watches[clipId], synced to D1 `watches` via /me/watches):
//   first, last   ISO timestamps (first time / last time the clip was on screen)
//   secs          seconds of real playback (max over sessions, one decimal)
//   pos           furthest position reached by real playback, seconds into the video
//   frac          furthest fraction of the SCREENED window actually watched, 0..1 (min of position and seconds watched)
//   finished      the clip was watched to its end (see TIERS) — sticky, never unset
//   shows         times it was mounted and started on screen
//   passed        times it was in a clash that ended in a pass (no pick)
//   rewatches     times a finished clip was played again from an explicit link (#clash, invite, history, daily banner)
//
// TIERS (rotation only; profiles, rails, history and links never hide anything, they only dim watched clips):
//   finished  ENDED (or the editorial end of its window) reached without skipping ahead, or frac >= FINISH_FRAC (0.9).
//             NEVER served again by For you / Training / Explore / the daily fallback / autoplay pairing.
//   glance    not finished, and secs < GLANCE_SEC (10 s) or frac < GLANCE_FRAC (0.25): may come back later, with a
//             recency penalty (multiplier 0.1 just after, recovering towards 0.6 over ~DECAY_DAYS).
//   partial   anything in between: treated as seen; allowed back ONLY when the unseen + glance pool runs dry.
export const FINISH_FRAC = 0.9, GLANCE_FRAC = 0.25, GLANCE_SEC = 10, DECAY_DAYS = 7
// author diversity (x-algorithm style): each additional appearance of the same comic in this session multiplies its
// score by AUTHOR_DECAY, never below AUTHOR_FLOOR
export const AUTHOR_DECAY = 0.6, AUTHOR_FLOOR = 0.2

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)
const iso = (t) => (typeof t === 'string' && !isNaN(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null)
const r1 = (x) => Math.round(x * 10) / 10, r3 = (x) => Math.round(x * 1000) / 1000

export function tierOf(w) {
  if (!w) return null
  if (w.finished || num(w.frac) >= FINISH_FRAC) return 'finished'
  if (num(w.secs) < GLANCE_SEC || num(w.frac) < GLANCE_FRAC) return 'glance'
  return 'partial'
}
export const isFinished = (w) => tierOf(w) === 'finished'

// one entry, validated (for merges, sync input, migration)
export function cleanEntry(w) {
  if (!w || typeof w !== 'object') return null
  const first = iso(w.first), last = iso(w.last) || first
  const o = {
    first: first || last, last, secs: r1(Math.max(0, Math.min(36000, num(w.secs)))), pos: r1(Math.max(0, Math.min(36000, num(w.pos)))),
    frac: r3(Math.max(0, Math.min(1, num(w.frac)))), finished: !!w.finished, shows: Math.max(0, Math.min(1e5, Math.round(num(w.shows)))),
    passed: Math.max(0, Math.min(1e5, Math.round(num(w.passed)))), rewatches: Math.max(0, Math.min(1e5, Math.round(num(w.rewatches)))),
  }
  if (o.frac >= FINISH_FRAC) o.finished = true
  return o
}
// merge two entries for the same clip: earliest first, latest last, max of the measures, finished = or
export function mergeEntry(a, b) {
  const A = cleanEntry(a), B = cleanEntry(b)
  if (!A) return B
  if (!B) return A
  const mn = (x, y) => (!x ? y : !y ? x : x < y ? x : y), mx = (x, y) => (!x ? y : !y ? x : x > y ? x : y)
  return cleanEntry({ first: mn(A.first, B.first), last: mx(A.last, B.last), secs: Math.max(A.secs, B.secs), pos: Math.max(A.pos, B.pos), frac: Math.max(A.frac, B.frac),
    finished: A.finished || B.finished, shows: Math.max(A.shows, B.shows), passed: Math.max(A.passed, B.passed), rewatches: Math.max(A.rewatches, B.rewatches) })
}
export function mergeLogs(a, b) {
  const out = { ...(a && typeof a === 'object' ? a : {}) }
  for (const [id, w] of Object.entries(b && typeof b === 'object' ? b : {})) { const m = mergeEntry(out[id], w); if (m) out[id] = m }
  return out
}

// record one screening of a clip into the log (returns the new entry). obs: { at, secs, pos, frac, finished, shown, passed, explicit }
// `shown` counts a new show (once per mount); an explicit-link play of an already-finished clip counts as a rewatch.
export function recordWatch(log, id, obs) {
  const at = iso(obs.at) || new Date().toISOString(), prev = cleanEntry(log[id])
  const w = prev || { first: at, last: at, secs: 0, pos: 0, frac: 0, finished: false, shows: 0, passed: 0, rewatches: 0 }
  const wasFinished = !!prev && isFinished(prev)
  w.last = at
  w.secs = Math.max(w.secs, num(obs.secs)); w.pos = Math.max(w.pos, num(obs.pos)); w.frac = Math.max(w.frac, Math.min(1, num(obs.frac)))
  if (obs.finished) w.finished = true
  if (obs.shown) { w.shows++; if (obs.explicit && wasFinished) w.rewatches++ }
  if (obs.passed) w.passed++
  return (log[id] = cleanEntry(w))
}

// the rotation's view of one clip: eligible at seen level L (0: unseen + glance, 1: + partial; finished never)
export function eligible(w, level = 0) {
  const t = tierOf(w)
  return t !== 'finished' && (t !== 'partial' || level >= 1)
}
// score multiplier in (0, 1]: unseen 1; glance 0.1 -> 0.6 as it ages; partial 0.05 -> 0.3 (only used at level 1)
export function freshness(w, nowMs = Date.now()) {
  const t = tierOf(w)
  if (!t) return 1
  if (t === 'finished') return 0
  const age = Math.max(0, (nowMs - Date.parse(w.last || w.first || 0)) / 86400e3), k = Math.exp(-age / DECAY_DAYS)
  return t === 'glance' ? 0.6 - 0.5 * k : 0.3 - 0.25 * k
}
// author-diversity multiplier for a comic already shown n times this session
export const authorMult = (n) => Math.max(AUTHOR_FLOOR, Math.pow(AUTHOR_DECAY, Math.max(0, n || 0)))

// migrate the legacy counters (funnier.seen = {id: count}) + whatever the vote / pass / skip records tell us.
// Votes carry leftWatchedSec / rightWatchedSec (+ rightFrac), skips their clip + watchedSec; durations from funnier.dur.
export function migrateLegacy({ seen = {}, votes = [], partials = [], passes = [], skips = [], dur = {}, clipDur = () => 0 } = {}) {
  const log = {}
  const touch = (id, at, secs, extra = {}) => {
    if (typeof id !== 'string' || !id) return
    const d = num(dur[id]) || num(clipDur(id)), s = num(secs)
    const frac = Number.isFinite(extra.frac) ? extra.frac : d > 0 ? s / d : 0
    const e = log[id] ? { ...log[id] } : { first: at, last: at, secs: 0, pos: 0, frac: 0, finished: false, shows: 0, passed: 0, rewatches: 0 }
    if (at && (!e.first || at < e.first)) e.first = at
    if (at && (!e.last || at > e.last)) e.last = at
    e.secs = Math.max(e.secs, s); e.frac = Math.max(e.frac, Math.min(1, frac)); e.shows++
    if (extra.passed) e.passed++
    log[id] = e
  }
  for (const v of [...votes, ...partials]) if (v && v.a && v.b) {
    const at = iso(v.createdAt)
    touch(v.a, at, v.leftWatchedSec)
    touch(v.b, at, v.rightWatchedSec, Number.isFinite(v.rightFrac) ? { frac: v.rightFrac } : {})
  }
  for (const p of passes) if (p && p.a && p.b) { const at = iso(p.at); touch(p.a, at, p.leftWatchedSec, { passed: true }); touch(p.b, at, p.rightWatchedSec, { passed: true }) }
  for (const s of skips) if (s && s.clip) touch(s.clip, iso(s.at), s.watchedSec)
  for (const [id, n] of Object.entries(seen || {})) { // counters only: no timing known -> a glance (comes back later)
    if (!log[id]) log[id] = { first: null, last: null, secs: 0, pos: 0, frac: 0, finished: false, shows: 0, passed: 0, rewatches: 0 }
    log[id].shows = Math.max(log[id].shows, Math.round(num(n)))
  }
  const out = {}
  for (const [id, e] of Object.entries(log)) { const c = cleanEntry({ ...e, first: e.first || '1970-01-01T00:00:00.000Z' }); if (c) out[id] = c }
  return out
}

// "3 Oct" (or "3 Oct 2025" in another year)
export function seenDate(t, nowMs = Date.now()) {
  const ms = Date.parse(t); if (!(ms > 86400e3)) return ''
  const d = new Date(ms), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${d.getDate()} ${M}${d.getFullYear() !== new Date(nowMs).getFullYear() ? ' ' + d.getFullYear() : ''}`
}
