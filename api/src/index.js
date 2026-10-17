// funnier-api: Google sign-in + accounts, public profiles (favourites, humour chart, diary), votes, friends, invites, taste match, clash stats, laughs, learned clip durations and crowd loudness on Cloudflare Workers + D1.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { cleanPassport } from '../../src/passport.js'
import { cleanFilter, cleanScope, isFeed, slugify, CURATED, SLUG as CAT_SLUG } from '../../src/feeds.js' // feeds + categories (shared with the client)
import { cleanPolicy } from '../../src/policy.js' // logged screening policy (off-policy training) // Humour Passport schema (shared with the client)
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'

// legacy preset ids (v1 profiles); each maps to a deterministic avatar seed 'preset-<id>'
export const AVATARS = ['grin', 'deadpan', 'wink', 'shock', 'smirk', 'cool', 'nerd', 'tash', 'sleepy', 'tongue', 'monocle', 'clown']
const SEED = /^[A-Za-z0-9_-]{1,40}$/ // avatar seed: the client renders a mascot from it (mascot-avatars)
export const seedOf = (u) => (u?.avatar_seed && SEED.test(u.avatar_seed) ? u.avatar_seed : u?.avatar_id && AVATARS.includes(u.avatar_id) ? 'preset-' + u.avatar_id : null)
const ORIGINS = ['https://prx0r.github.io', 'https://www.funnier.si', 'https://funnier.si']
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const COOKIE = 'funnier_session'
const SESSION_DAYS = 60
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs'
const CLIP = /^[A-Za-z0-9_.:-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const USERNAME = /^[A-Za-z0-9_]{3,20}$/ // shown as typed, unique case-insensitively
const SHARE_BASES = ['https://www.funnier.si/', 'https://prx0r.github.io/characters/']
const WHY_MAX = 40
// watch signals (lexicon #signals): whole seconds, all optional; anything else is dropped
const SIG_INT = { leftWatchedSec: 36000, rightWatchedSec: 36000, rightPct: 100, replays: 1000, leftSkippedAt: 36000, rightSkippedAt: 36000 }
const SIG_ARR = ['leftSeekTargets', 'leftSeekFrom', 'rightSeekTargets', 'rightSeekFrom']
const SIG_BOOL = ['skippedAhead', 'leftSkipped', 'rightSkipped', 'timedOut'] // timedOut: a pass because the 10 s ballot ran out (events only)
export function cleanSignals(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = {}
  for (const [k, mx] of Object.entries(SIG_INT)) { const v = Number(x[k]); if (x[k] != null && Number.isFinite(v) && v >= 0) o[k] = Math.min(mx, Math.round(v)) }
  for (const k of SIG_ARR) if (Array.isArray(x[k])) { const a = x[k].slice(0, 20).map(Number).filter((v) => Number.isFinite(v) && v >= 0).map((v) => Math.min(36000, Math.round(v))); if (a.length) o[k] = a }
  for (const k of SIG_BOOL) if (x[k] === true) o[k] = true
  const pol = cleanPolicy(x.policy); if (pol) o.policy = pol
  return Object.keys(o).length ? JSON.stringify(o) : null
}

const app = new Hono()
app.use('*', cors({
  origin: (o) => (ORIGINS.includes(o) || LOCAL.test(o || '') ? o : null),
  credentials: true,
  allowHeaders: ['content-type', 'authorization', 'x-funnier-device'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))
app.onError((err, c) => { console.error(err); return c.json({ error: 'server_error' }, 500) })
app.notFound((c) => c.json({ error: 'not_found' }, 404))

// ---------- helpers ----------
let jwks = null, jwksUrl = null
function googleKeys(env) {
  const url = env.ALLOW_TEST_JWKS === '1' && env.TEST_JWKS_URL ? env.TEST_JWKS_URL : GOOGLE_JWKS
  if (!jwks || jwksUrl !== url) { jwks = createRemoteJWKSet(new URL(url)); jwksUrl = url }
  return jwks
}
const secretKey = (env) => new TextEncoder().encode(env.SESSION_SECRET || '')
async function signSession(env, uid) {
  return new SignJWT({ uid }).setProtectedHeader({ alg: 'HS256' }).setIssuer('funnier-api').setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(secretKey(env))
}
async function sessionUid(c) {
  if (!c.env.SESSION_SECRET) return null
  const h = c.req.header('authorization') || ''
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : getCookie(c, COOKIE)
  if (!tok) return null
  try { const { payload } = await jwtVerify(tok, secretKey(c.env), { issuer: 'funnier-api', algorithms: ['HS256'] }); return typeof payload.uid === 'string' ? payload.uid : null } catch { return null }
}
async function currentUser(c) {
  const uid = await sessionUid(c); if (!uid) return null
  return c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first()
}
const auth = async (c, next) => {
  const u = await currentUser(c)
  if (!u) { if (c.req.method !== 'GET') console.log('401', c.req.method, c.req.path, c.req.header('authorization') ? 'bearer' : getCookie(c, COOKIE) ? 'cookie' : 'none'); return c.json({ error: 'unauthorized' }, 401) }
  c.set('user', u); await next()
}
const pub = (u) => u && ({ username: u.username || null, avatar_seed: seedOf(u), google_avatar: seedOf(u) ? null : u.google_avatar || null })
const self = (u) => ({
  id: u.id, email: u.email, name: u.name, google_avatar: u.google_avatar, username: u.username, avatar_seed: seedOf(u),
  birth_year: u.birth_year, country: u.country, sex_at_birth: u.sex_at_birth, created_at: u.created_at,
  scope: u.scope || null, feed: u.feed || null,
})
// only the public part is required; year of birth, country and sex at birth are optional (the sheet says so)
const needsProfile = (u) => !u.username || !seedOf(u)
const sorted = (a, b) => (a < b ? [a, b] : [b, a])
const now = () => new Date().toISOString()
function code(n = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', r = crypto.getRandomValues(new Uint8Array(n))
  return [...r].map((x) => abc[x % abc.length]).join('')
}
async function body(c) { try { return await c.req.json() } catch { return null } }
const pct = (x, n) => (n ? Math.round((100 * x) / n) : 0)

// ---------- auth ----------
app.get('/', (c) => c.json({ ok: true, service: 'funnier-api', signIn: !!c.env.GOOGLE_CLIENT_ID }))

app.post('/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.SESSION_SECRET) return c.json({ error: 'sign_in_not_configured' }, 503)
  const b = await body(c), cred = b?.credential
  if (typeof cred !== 'string' || cred.length > 4096) return c.json({ error: 'missing_credential' }, 400)
  let p
  try {
    ({ payload: p } = await jwtVerify(cred, googleKeys(c.env), { issuer: ['accounts.google.com', 'https://accounts.google.com'], audience: c.env.GOOGLE_CLIENT_ID }))
  } catch { return c.json({ error: 'invalid_credential' }, 401) }
  if (!p.sub) return c.json({ error: 'invalid_credential' }, 401)
  const DB = c.env.DB
  let u = await DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(String(p.sub)).first()
  const email = typeof p.email === 'string' ? p.email : null, name = typeof p.name === 'string' ? p.name : null
  const pic = typeof p.picture === 'string' && /^https:\/\//.test(p.picture) ? p.picture : null
  if (!u) {
    const id = crypto.randomUUID()
    await DB.prepare('INSERT INTO users (id, google_sub, email, name, google_avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, String(p.sub), email, name, pic, now()).run()
    u = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
  } else {
    await DB.prepare('UPDATE users SET email = ?, name = ?, google_avatar = ? WHERE id = ?').bind(email, name, pic, u.id).run()
    u = { ...u, email, name, google_avatar: pic }
  }
  const token = await signSession(c.env, u.id)
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: SESSION_DAYS * 86400 })
  return c.json({ token, user: self(u), needsProfile: needsProfile(u) })
})

app.post('/auth/logout', (c) => { deleteCookie(c, COOKIE, { path: '/', secure: true, sameSite: 'None' }); return c.json({ ok: true }) })

// ---------- me ----------
app.get('/me', auth, (c) => { const u = c.get('user'); return c.json({ user: self(u), needsProfile: needsProfile(u) }) })

app.put('/me/profile', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, set = {}, errs = {}
  if ('username' in b) { const v = String(b.username ?? '').trim(); if (!USERNAME.test(v)) errs.username = '3 to 20 letters, numbers or _'; else set.username = v }
  if ('avatar_seed' in b) { const v = String(b.avatar_seed ?? '').trim(); if (!SEED.test(v)) errs.avatar_seed = '1 to 40 letters, numbers, _ or -'; else set.avatar_seed = v }
  else if ('avatar_id' in b) { if (!AVATARS.includes(b.avatar_id)) errs.avatar_id = 'pick one of the preset avatars'; else set.avatar_seed = 'preset-' + b.avatar_id } // legacy clients
  if ('birth_year' in b) {
    const y = Number(b.birth_year), max = new Date().getUTCFullYear() - 13
    if (!Number.isInteger(y) || y < 1900) errs.birth_year = 'enter a year between 1900 and ' + max
    else if (y > max) return c.json({ error: 'too_young', message: 'Funnier profiles are for people aged 13 and over.' }, 400)
    else set.birth_year = y
  }
  if ('country' in b) { const v = String(b.country ?? '').toUpperCase(); if (!/^[A-Z]{2}$/.test(v)) errs.country = 'two-letter ISO country code'; else set.country = v }
  if ('scope' in b) { const v = cleanScope(b.scope); if (!v) errs.scope = "'global' or a region key"; else set.scope = v }
  if ('feed' in b) { if (!isFeed(b.feed)) errs.feed = 'trending, foryou, underdog, vibes or cat:<slug>'; else set.feed = b.feed }
  if ('sex_at_birth' in b) { if (!['male', 'female', 'skip'].includes(b.sex_at_birth)) errs.sex_at_birth = 'male, female or skip'; else set.sex_at_birth = b.sex_at_birth }
  if (Object.keys(errs).length) { console.log('profile 400', JSON.stringify({ fields: Object.keys(errs) })); return c.json({ error: 'invalid', fields: errs }, 400) }
  if (!Object.keys(set).length) return c.json({ user: self(u), needsProfile: needsProfile(u) })
  if (set.username) {
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').bind(set.username, u.id).first()
    if (taken) { console.log('profile 409 username_taken'); return c.json({ error: 'username_taken', fields: { username: 'already taken' } }, 409) }
  }
  const keys = Object.keys(set)
  try {
    await c.env.DB.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => set[k]), u.id).run()
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return c.json({ error: 'username_taken', fields: { username: 'already taken' } }, 409)
    throw e
  }
  const nu = { ...u, ...set }
  return c.json({ user: self(nu), needsProfile: needsProfile(nu) })
})

app.delete('/me', auth, async (c) => {
  const id = c.get('user').id, DB = c.env.DB
  await DB.batch([
    DB.prepare('DELETE FROM votes WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM watch_events WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM watches WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM category_follows WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM categories WHERE creator_id = ? AND public = 0').bind(id),
    DB.prepare('UPDATE categories SET creator_id = NULL WHERE creator_id = ?').bind(id),
    DB.prepare('DELETE FROM humour_profiles WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM specials_log WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM sets WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM characters WHERE owner_id = ?').bind(id),
    DB.prepare('DELETE FROM model_versions WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM friends WHERE user_id = ? OR friend_id = ?').bind(id, id),
    DB.prepare('DELETE FROM invite_opens WHERE code IN (SELECT code FROM invites WHERE inviter_id = ?)').bind(id),
    DB.prepare('UPDATE invite_opens SET opener_user_id = NULL WHERE opener_user_id = ?').bind(id),
    DB.prepare('DELETE FROM invites WHERE inviter_id = ?').bind(id),
    DB.prepare('DELETE FROM laughs WHERE user_or_device = ?').bind('u:' + id),
    DB.prepare('DELETE FROM clip_audio WHERE user_or_device = ?').bind('u:' + id),
    DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ])
  deleteCookie(c, COOKIE, { path: '/', secure: true, sameSite: 'None' })
  return c.json({ ok: true })
})

// ---------- votes ----------
app.post('/votes', auth, async (c) => {
  const u = c.get('user'), b = await body(c), list = Array.isArray(b?.votes) ? b.votes : Array.isArray(b) ? b : b && b.a ? [b] : []
  if (!list.length) return c.json({ error: 'no_votes' }, 400)
  if (list.length > 500) return c.json({ error: 'too_many', max: 500 }, 400)
  const DB = c.env.DB, stmts = [], pairs = [], seen = new Set()
  let skipped = 0
  for (const v of list) {
    if (!v || !CLIP.test(v.a || '') || !CLIP.test(v.b || '') || v.a === v.b || (v.winner !== v.a && v.winner !== v.b)) { skipped++; continue }
    const [a, bb] = sorted(v.a, v.b)
    const t = typeof v.createdAt === 'string' && !isNaN(Date.parse(v.createdAt)) ? new Date(Math.min(Date.parse(v.createdAt), Date.now())).toISOString() : now()
    const ms = Number.isInteger(v.ms ?? v.decisionMs) && (v.ms ?? v.decisionMs) >= 0 && (v.ms ?? v.decisionMs) < 3600e3 ? v.ms ?? v.decisionMs : null
    const why = typeof v.why === 'string' ? v.why.slice(0, WHY_MAX) : null
    const daily = typeof v.daily === 'string' && DAY.test(v.daily) ? v.daily : null
    // signals keep the clash's on-screen order (left = v.a), so they are stored with the as-shown order
    const sg = cleanSignals(v.signals), sig = sg ? JSON.stringify({ shown: [v.a, v.b], ...JSON.parse(sg) }) : null
    stmts.push(DB.prepare(`INSERT INTO votes (user_id, a, b, winner, why, ms, daily, cc, signals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, a, b) DO UPDATE SET winner = excluded.winner, why = excluded.why, ms = excluded.ms, daily = excluded.daily, cc = excluded.cc,
        signals = COALESCE(excluded.signals, votes.signals), created_at = excluded.created_at
      WHERE excluded.created_at >= votes.created_at`).bind(u.id, a, bb, v.winner, why, ms, daily, u.country || null, sig, t))
    const k = a + '|' + bb
    if (!seen.has(k)) { seen.add(k); pairs.push([a, bb]) }
  }
  for (const [a, bb] of pairs) stmts.push(DB.prepare(`UPDATE invite_opens SET voted = 1 WHERE opener_user_id = ? AND voted = 0 AND code IN
      (SELECT code FROM invites WHERE (clash_a = ? AND clash_b = ?) OR (clash_a = ? AND clash_b = ?))`).bind(u.id, a, bb, bb, a))
  if (stmts.length) await DB.batch(stmts)
  return c.json({ ok: true, saved: list.length - skipped, skipped })
})

// ---------- watch events: skips ("Not funny", swipe away) and passes, with their signals (the swipe labels, §4c) ----------
const STAGES = ['intro', 'left', 'right', 'vote', 'done', 'left-skip', 'right-skip']
app.post('/events', auth, async (c) => {
  const u = c.get('user'), b = await body(c), list = Array.isArray(b?.events) ? b.events : []
  if (!list.length) return c.json({ error: 'no_events' }, 400)
  if (list.length > 200) return c.json({ error: 'too_many', max: 200 }, 400)
  const DB = c.env.DB, stmts = []
  let skipped = 0
  for (const e of list) {
    if (!e || !['skip', 'pass'].includes(e.kind) || !CLIP.test(e.a || '') || !CLIP.test(e.b || '') || e.a === e.b || (e.clip != null && !CLIP.test(e.clip)) ||
      typeof e.createdAt !== 'string' || isNaN(Date.parse(e.createdAt))) { skipped++; continue }
    const t = new Date(Math.min(Date.parse(e.createdAt), Date.now())).toISOString()
    const ws = Number(e.watchedSec), ms = Number(e.ms)
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO watch_events (user_id, kind, a, b, stage, clip, watched_sec, ms, daily, signals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.id, e.kind, e.a, e.b, STAGES.includes(e.stage) ? e.stage : null, e.clip || null, Number.isFinite(ws) && ws >= 0 ? Math.min(36000, Math.round(ws)) : null,
        Number.isInteger(ms) && ms >= 0 && ms < 3600e3 ? ms : null, typeof e.daily === 'string' && DAY.test(e.daily) ? e.daily : null, cleanSignals(e.signals), t))
  }
  if (stmts.length) await DB.batch(stmts)
  return c.json({ ok: true, saved: list.length - skipped, skipped })
})

// ---------- seen tracking: the per-clip watch log (src/seen.js), merged with max / or semantics ----------
app.get('/me/watches', auth, async (c) => {
  const r = await c.env.DB.prepare('SELECT clip_id, first_seen, last_seen, secs, max_pos, frac, finished, shows, passed, rewatches FROM watches WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20000').bind(c.get('user').id).all()
  return c.json({ watches: (r.results || []).map((x) => ({ clip: x.clip_id, first: x.first_seen, last: x.last_seen, secs: x.secs, pos: x.max_pos, frac: x.frac, finished: !!x.finished, shows: x.shows, passed: x.passed, rewatches: x.rewatches })) })
})
app.post('/me/watches', auth, async (c) => {
  const u = c.get('user'), b = await body(c), list = Array.isArray(b?.watches) ? b.watches : []
  if (!list.length) return c.json({ error: 'no_watches' }, 400)
  if (list.length > 500) return c.json({ error: 'too_many', max: 500 }, 400)
  const DB = c.env.DB, stmts = [], lim = Date.now() + 5 * 60e3
  let skipped = 0
  const T = (x) => (typeof x === 'string' && !isNaN(Date.parse(x)) ? new Date(Math.min(Date.parse(x), lim)).toISOString() : null)
  const N = (x, mx) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.min(mx, n) : 0 }
  for (const w of list) {
    const first = T(w?.first) || T(w?.last), last = T(w?.last) || first
    if (!w || !CLIP.test(w.clip || '') || !first) { skipped++; continue }
    const frac = Math.round(1000 * N(w.frac, 1)) / 1000, fin = w.finished === true || frac >= 0.9 ? 1 : 0
    stmts.push(DB.prepare(`INSERT INTO watches (user_id, clip_id, first_seen, last_seen, secs, max_pos, frac, finished, shows, passed, rewatches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, clip_id) DO UPDATE SET first_seen = MIN(watches.first_seen, excluded.first_seen), last_seen = MAX(watches.last_seen, excluded.last_seen),
        secs = MAX(watches.secs, excluded.secs), max_pos = MAX(watches.max_pos, excluded.max_pos), frac = MAX(watches.frac, excluded.frac),
        finished = MAX(watches.finished, excluded.finished), shows = MAX(watches.shows, excluded.shows), passed = MAX(watches.passed, excluded.passed),
        rewatches = MAX(watches.rewatches, excluded.rewatches)`)
      .bind(u.id, w.clip, first, last < first ? first : last, Math.round(10 * N(w.secs, 36000)) / 10, Math.round(10 * N(w.pos, 36000)) / 10, frac, fin,
        Math.round(N(w.shows, 1e5)), Math.round(N(w.passed, 1e5)), Math.round(N(w.rewatches, 1e5))))
  }
  if (stmts.length) await DB.batch(stmts)
  return c.json({ ok: true, saved: stmts.length, skipped })
})

// ---------- categories: saved prompt feeds (src/feeds.js); public ones are community categories ----------
const catRow = (r, followers = 0, mine = false) => ({ slug: r.slug, title: r.title, prompt: r.prompt || null, filter: jparse(r.filter, null), public: !!r.public, curated: !r.creator_id && CURATED.some((x) => x.slug === r.slug), followers, mine })
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
app.get('/categories', async (c) => {
  c.header('cache-control', 'public, max-age=120')
  const r = await c.env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM category_follows f WHERE f.slug = c.slug) AS n FROM categories c WHERE c.public = 1 ORDER BY n DESC, c.created_at DESC LIMIT 200`).all()
  const rows = (r.results || []).map((x) => catRow(x, x.n))
  const have = new Set(rows.map((x) => x.slug))
  const curated = CURATED.filter((x) => !have.has(x.slug)).map((x) => ({ slug: x.slug, title: x.title, prompt: null, filter: x.filter, public: true, curated: true, followers: 0, mine: false }))
  return c.json({ categories: [...curated, ...rows] })
})
app.get('/me/categories', auth, async (c) => {
  const u = c.get('user'), DB = c.env.DB
  const own = await DB.prepare('SELECT * FROM categories WHERE creator_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id).all()
  const fol = await DB.prepare('SELECT slug FROM category_follows WHERE user_id = ? ORDER BY created_at').bind(u.id).all()
  return c.json({ own: (own.results || []).map((x) => catRow(x, 0, true)), follows: (fol.results || []).map((x) => x.slug) })
})
app.post('/categories', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, DB = c.env.DB
  const title = cleanTitle(b.title), filter = cleanFilter(b.filter), prompt = typeof b.prompt === 'string' ? b.prompt.replace(/[\u0000-\u001f<>]/g, '').slice(0, 120) : null
  if (title.length < 3 || !filter) return c.json({ error: 'invalid', fields: { ...(title.length < 3 ? { title: '3 to 40 characters' } : {}), ...(!filter ? { filter: 'nothing to filter on' } : {}) } }, 400)
  let slug = typeof b.slug === 'string' && CAT_SLUG.test(b.slug) ? b.slug : slugify(title)
  if (!CAT_SLUG.test(slug)) return c.json({ error: 'invalid', fields: { title: 'needs letters or numbers' } }, 400)
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM categories WHERE creator_id = ?').bind(u.id).first()
  const prev = await DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first()
  if (prev && prev.creator_id !== u.id) { // someone else's slug (or curated): take a free variant
    if (CURATED.some((x) => x.slug === slug) || prev) { for (let i = 2; i < 50; i++) { const s2 = (slug.slice(0, 36) + '-' + i); if (!(await DB.prepare('SELECT 1 FROM categories WHERE slug = ?').bind(s2).first())) { slug = s2; break } } }
  } else if (!prev && CURATED.some((x) => x.slug === slug)) slug = slug.slice(0, 36) + '-2'
  if (!prev && (n?.n || 0) >= 50) return c.json({ error: 'too_many', max: 50 }, 400)
  const t = now(), pubFlag = b.public === false ? 0 : 1
  await DB.prepare(`INSERT INTO categories (slug, title, prompt, filter, creator_id, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (slug) DO UPDATE SET title = excluded.title, prompt = excluded.prompt, filter = excluded.filter, public = excluded.public, updated_at = excluded.updated_at WHERE categories.creator_id = excluded.creator_id`)
    .bind(slug, title, prompt, JSON.stringify(filter), u.id, pubFlag, t, t).run()
  await DB.prepare('INSERT OR IGNORE INTO category_follows (user_id, slug, created_at) VALUES (?, ?, ?)').bind(u.id, slug, t).run()
  const row = await DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first()
  return c.json({ category: catRow(row, 0, true) })
})
app.delete('/categories/:slug', auth, async (c) => {
  const u = c.get('user'), slug = c.req.param('slug')
  const r = await c.env.DB.prepare('DELETE FROM categories WHERE slug = ? AND creator_id = ?').bind(slug, u.id).run()
  await c.env.DB.prepare('DELETE FROM category_follows WHERE user_id = ? AND slug = ?').bind(u.id, slug).run()
  return c.json({ ok: true, deleted: r.meta?.changes || 0 })
})
app.post('/me/categories/follow', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, list = Array.isArray(b.follows) ? b.follows : [{ slug: b.slug, on: b.on }]
  const DB = c.env.DB, stmts = [], t = now()
  for (const x of list.slice(0, 100)) {
    if (!x || !CAT_SLUG.test(x.slug || '')) continue
    stmts.push(x.on === false ? DB.prepare('DELETE FROM category_follows WHERE user_id = ? AND slug = ?').bind(u.id, x.slug) : DB.prepare('INSERT OR IGNORE INTO category_follows (user_id, slug, created_at) VALUES (?, ?, ?)').bind(u.id, x.slug, t))
  }
  if (!stmts.length) return c.json({ error: 'invalid' }, 400)
  await DB.batch(stmts)
  return c.json({ ok: true, saved: stmts.length })
})
// ---------- trending: anonymous per-clip watch aggregates over the last N hours (completion for data/trending.json) ----------
app.get('/stats/trending', async (c) => {
  c.header('access-control-allow-origin', '*'); c.header('cache-control', 'public, max-age=300')
  const h = Math.max(1, Math.min(168, parseInt(c.req.query('hours') || '72', 10) || 72)), since = new Date(Date.now() - h * 3600e3).toISOString()
  const r = await c.env.DB.prepare('SELECT clip_id, COUNT(*) AS shows, SUM(finished) AS fin FROM watches WHERE last_seen >= ? GROUP BY clip_id HAVING COUNT(*) >= 1 LIMIT 20000').bind(since).all()
  const clips = {}
  for (const x of r.results || []) clips[x.clip_id] = { shows: x.shows, finished: x.fin || 0 }
  return c.json({ hours: h, since, clips })
})

// ---------- public, read-only, anonymised export for the tally (D1 votes + passes/skips reach the leaderboard) ----------
// voter = 'd1:' + first 16 hex of HMAC-SHA256(EXPORT_SALT, user_id). No email, name, username, country or user id.
// Paginated by (created_at, rowid): ?since=<ISO> (inclusive lower bound) &cursor=<next from the last page> &limit=1..1000.
let saltKey = null, saltFor = null
async function voterHash(env, uid) {
  if (!saltKey || saltFor !== env.EXPORT_SALT) { saltKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.EXPORT_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); saltFor = env.EXPORT_SALT }
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, new TextEncoder().encode('funnier-voter:' + uid)))
  return 'd1:' + [...sig.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const EXPORT_MAX_AGE = 300
async function exportPage(c, kind) {
  c.header('access-control-allow-origin', '*'); c.header('vary', 'origin')
  if (!c.env.EXPORT_SALT) return c.json({ error: 'export_not_configured' }, 503)
  const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request(new URL(c.req.url).toString(), { method: 'GET' })
  if (cache) { const hit = await cache.match(key); if (hit) return hit }
  const since = c.req.query('since'), cur = c.req.query('cursor') || '', limit = Math.max(1, Math.min(1000, parseInt(c.req.query('limit') || '500', 10) || 500))
  const s0 = since && !isNaN(Date.parse(since)) ? new Date(Date.parse(since)).toISOString() : '1970-01-01T00:00:00.000Z'
  const m = cur.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)~(\d{1,15})$/)
  const [ct, cr] = m ? [m[1], Number(m[2])] : [s0, -1]
  const table = kind === 'votes' ? 'votes' : 'watch_events'
  const cols = kind === 'votes' ? 'rowid AS rid, user_id, a, b, winner, ms, daily, signals, created_at' : 'rowid AS rid, user_id, kind, a, b, stage, clip, watched_sec, ms, daily, signals, created_at'
  const r = await c.env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE created_at >= ? AND (created_at > ? OR (created_at = ? AND rowid > ?)) ORDER BY created_at, rowid LIMIT ?`).bind(s0, ct, ct, cr, limit + 1).all()
  const rows = r.results || [], more = rows.length > limit, page = rows.slice(0, limit)
  const out = []
  for (const x of page) {
    const sg = jparse(x.signals, null), signals = sg && typeof sg === 'object' ? sg : undefined
    const base = { a: x.a, b: x.b, createdAt: x.created_at, voter: await voterHash(c.env, x.user_id), ...(Number.isInteger(x.ms) ? { ms: x.ms } : {}), ...(x.daily ? { daily: x.daily } : {}),
      ...(signals ? { signals } : {}), ...(signals?.policy ? { policy: signals.policy } : {}) }
    out.push(kind === 'votes' ? { ...base, winner: x.winner, basis: 'watched', source: 'd1' }
      : { ...base, kind: x.kind, ...(x.stage ? { stage: x.stage } : {}), ...(x.clip ? { clip: x.clip } : {}), ...(Number.isInteger(x.watched_sec) ? { watchedSec: x.watched_sec } : {}), source: 'd1' })
  }
  const last = page[page.length - 1]
  const res = c.json({ kind, since: s0, count: out.length, next: more && last ? `${last.created_at}~${last.rid}` : null, [kind]: out })
  res.headers.set('cache-control', `public, max-age=${EXPORT_MAX_AGE}`)
  if (cache) { const p = cache.put(key, res.clone()).catch(() => {}); try { c.executionCtx.waitUntil(p) } catch {} }
  return res
}
app.get('/export/votes', (c) => exportPage(c, 'votes'))
app.get('/export/events', (c) => exportPage(c, 'events'))

// the interpretable humour profile, fitted offline from bit theory features (tools/humour.mjs); null until there is enough data
app.get('/me/humour', auth, async (c) => {
  const r = await c.env.DB.prepare('SELECT profile, updated_at FROM humour_profiles WHERE user_id = ?').bind(c.get('user').id).first()
  let p = null; try { p = r ? JSON.parse(r.profile) : null } catch {}
  return c.json({ humour: p, updated: r?.updated_at || null })
})

// has this user finished a daily clash (voted on it, or watched it through to its ballot) on any device?
app.get('/me/daily/:date', auth, async (c) => {
  const u = c.get('user'), date = c.req.param('date')
  if (!DAY.test(date)) return c.json({ error: 'bad_date' }, 400)
  const v = await c.env.DB.prepare('SELECT 1 AS x FROM votes WHERE user_id = ? AND daily = ? LIMIT 1').bind(u.id, date).first()
  const e = v ? null : await c.env.DB.prepare("SELECT 1 AS x FROM watch_events WHERE user_id = ? AND daily = ? AND (kind = 'pass' OR stage = 'vote') LIMIT 1").bind(u.id, date).first()
  return c.json({ date, done: !!(v || e), voted: !!v })
})

app.get('/clash/:a/:b/friends', auth, async (c) => {
  const u = c.get('user'), { a: ra, b: rb } = c.req.param()
  if (!CLIP.test(ra) || !CLIP.test(rb)) return c.json({ error: 'bad_clip' }, 400)
  const [a, b] = sorted(ra, rb)
  const r = await c.env.DB.prepare(`SELECT u.username, u.avatar_id, u.avatar_seed, u.google_avatar, v.winner, v.created_at FROM friends f
    JOIN votes v ON v.user_id = f.friend_id AND v.a = ? AND v.b = ? JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY v.created_at DESC LIMIT 50`).bind(a, b, u.id).all()
  return c.json({ friends: (r.results || []).map((x) => ({ ...pub(x), winner: x.winner })) })
})

// ---------- invites ----------
app.post('/invites', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}
  if (!CLIP.test(b.a || '') || !CLIP.test(b.b || '') || b.a === b.b) return c.json({ error: 'bad_clip' }, 400)
  const pick = b.pick === 'a' || b.pick === 'b' ? b.pick : null
  // one code per inviter + clash + pick, so re-sharing doesn't mint new links
  const old = await c.env.DB.prepare('SELECT code FROM invites WHERE inviter_id = ? AND clash_a = ? AND clash_b = ? AND pick IS ?').bind(u.id, b.a, b.b, pick).first()
  let k = old?.code
  if (!k) {
    for (let i = 0; i < 4 && !k; i++) {
      const tryK = code()
      try { await c.env.DB.prepare('INSERT INTO invites (code, inviter_id, clash_a, clash_b, pick, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(tryK, u.id, b.a, b.b, pick, now()).run(); k = tryK } catch (e) { if (!/UNIQUE/i.test(String(e?.message))) throw e }
    }
    if (!k) return c.json({ error: 'try_again' }, 500)
  }
  return c.json({ code: k, urls: SHARE_BASES.map((s) => s + '#i/' + k), url: SHARE_BASES[0] + '#i/' + k })
})

app.get('/invites/:code', async (c) => {
  const k = c.req.param('code')
  if (!/^[A-Za-z0-9]{4,16}$/.test(k)) return c.json({ error: 'not_found' }, 404)
  const DB = c.env.DB
  const inv = await DB.prepare('SELECT i.*, u.username, u.avatar_id, u.avatar_seed, u.google_avatar FROM invites i JOIN users u ON u.id = i.inviter_id WHERE i.code = ?').bind(k).first()
  if (!inv) return c.json({ error: 'not_found' }, 404)
  const me = await currentUser(c), mine = me && me.id === inv.inviter_id
  let open_id = null, friends = false
  if (!mine) {
    const r = await DB.prepare('INSERT INTO invite_opens (code, opener_user_id, opened_at) VALUES (?, ?, ?) RETURNING id').bind(k, me?.id || null, now()).first()
    open_id = r?.id ?? null
    if (me) friends = !!(await DB.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').bind(me.id, inv.inviter_id).first())
  }
  return c.json({ code: k, a: inv.clash_a, b: inv.clash_b, pick: inv.pick, inviter: pub(inv), open_id, self: !!mine, friends })
})

app.post('/invites/:code/voted', async (c) => {
  const k = c.req.param('code'), b = (await body(c)) || {}, id = Number(b.open_id)
  if (!Number.isInteger(id)) return c.json({ error: 'bad_open' }, 400)
  const me = await currentUser(c)
  await c.env.DB.prepare('UPDATE invite_opens SET voted = 1, opener_user_id = COALESCE(opener_user_id, ?) WHERE id = ? AND code = ?').bind(me?.id || null, id, k).run()
  return c.json({ ok: true })
})

app.post('/invites/:code/accept', auth, async (c) => {
  const u = c.get('user'), k = c.req.param('code'), b = (await body(c)) || {}, DB = c.env.DB
  const inv = await DB.prepare('SELECT i.inviter_id, u.username, u.avatar_id, u.avatar_seed, u.google_avatar FROM invites i JOIN users u ON u.id = i.inviter_id WHERE i.code = ?').bind(k).first()
  if (!inv) return c.json({ error: 'not_found' }, 404)
  if (inv.inviter_id === u.id) return c.json({ error: 'own_invite' }, 400)
  const t = now(), stmts = [
    DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').bind(u.id, inv.inviter_id, t),
    DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').bind(inv.inviter_id, u.id, t),
  ]
  if (Number.isInteger(Number(b.open_id))) stmts.push(DB.prepare('UPDATE invite_opens SET opener_user_id = ? WHERE id = ? AND code = ? AND opener_user_id IS NULL').bind(u.id, Number(b.open_id), k))
  await DB.batch(stmts)
  return c.json({ ok: true, friend: pub(inv) })
})

app.get('/me/invites', auth, async (c) => {
  const u = c.get('user'), DB = c.env.DB
  const r = await DB.prepare(`SELECT i.code, i.clash_a, i.clash_b, i.pick, i.created_at, COUNT(o.id) AS opens, COALESCE(SUM(o.voted), 0) AS voted
    FROM invites i LEFT JOIN invite_opens o ON o.code = i.code WHERE i.inviter_id = ? GROUP BY i.code ORDER BY i.created_at DESC LIMIT 50`).bind(u.id).all()
  const who = await DB.prepare(`SELECT o.code, o.voted, o.opened_at, us.username, us.avatar_id, us.avatar_seed, us.google_avatar FROM invite_opens o
    JOIN invites i ON i.code = o.code JOIN users us ON us.id = o.opener_user_id WHERE i.inviter_id = ? ORDER BY o.opened_at DESC LIMIT 200`).bind(u.id).all()
  const by = {}
  for (const w of who.results || []) (by[w.code] = by[w.code] || []).push({ ...pub(w), voted: !!w.voted, opened_at: w.opened_at })
  const inv = (r.results || []).map((x) => ({ code: x.code, a: x.clash_a, b: x.clash_b, pick: x.pick, created_at: x.created_at, opens: x.opens, voted: x.voted, people: by[x.code] || [] }))
  const totals = { sent: inv.length, opened: inv.reduce((s, x) => s + (x.opens > 0 ? 1 : 0), 0), opens: inv.reduce((s, x) => s + x.opens, 0), voted: inv.reduce((s, x) => s + x.voted, 0) }
  return c.json({ invites: inv, totals })
})

app.get('/me/taste', auth, async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`SELECT f.friend_id, us.username, us.avatar_id, us.avatar_seed, us.google_avatar, f.created_at AS since,
      COUNT(v2.a) AS shared, COALESCE(SUM(CASE WHEN v1.winner = v2.winner THEN 1 ELSE 0 END), 0) AS agree
    FROM friends f JOIN users us ON us.id = f.friend_id
    LEFT JOIN votes v1 ON v1.user_id = f.user_id
    LEFT JOIN votes v2 ON v2.user_id = f.friend_id AND v2.a = v1.a AND v2.b = v1.b
    WHERE f.user_id = ? GROUP BY f.friend_id ORDER BY shared DESC`).bind(u.id).all()
  const friends = (r.results || []).map((x) => ({ ...pub(x), since: x.since, shared: x.shared, agree: x.agree, match: x.shared >= 3 ? pct(x.agree, x.shared) : null }))
  return c.json({ friends, min_shared: 3 })
})

// ---------- profiles: Four Favourites, pinned clips, humour chart snapshot, specials diary, sets, link-preview image ----------
const VIS = ['public', 'friends', 'private']
const SPECIAL = /^[a-z0-9-]{1,64}$/
const COMIC = /^[\p{L}\p{N} .,'&-]{1,60}$/u
const OG_MAX = 1024 * 1024
const DIM_KEYS = ['absurd', 'deadpan', 'observational', 'dark', 'story', 'wordplay', 'rant', 'selfdep', 'crowd']
const OPS_KEYS = ['split_knowledge', 'repeat_variation', 'double_interpret', 'status_invert', 'rigidify', 'juxtapose', 'literalize', 'mistake_identity',
  'literalize_or_other', 'expose_self_blindness', 'false_analogy', 'identity_contradict', 'unmask', 'role_reverse', 'character_violation']
const str = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : null)
const n100 = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(100, Math.round(Number(x)))) : null)
// the chart is computed on the owner's device; store only known keys, numbers clamped, strings capped
export function cleanChart(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const o = { v: 1, n: Math.max(0, Math.min(1e6, Math.round(Number(c.n) || 0))), dims: {}, sty: {} }
  for (const k of DIM_KEYS) { const v = n100(c.dims?.[k]); if (v != null) o.dims[k] = v }
  if (Object.keys(o.dims).length < 3) return null
  for (const k of ['energy', 'hold', 'pace']) { const v = n100(c.sty?.[k]); if (v != null) o.sty[k] = v }
  // humour engine v2: uncertainty band (lo, hi), confidence label and evidence (votes) per axis, model id
  if (typeof c.model === 'string' && /^[a-z0-9./-]{1,40}$/i.test(c.model)) o.model = c.model
  for (const k of Object.keys(o.dims)) {
    const b = c.band?.[k]; if (Array.isArray(b) && b.length === 2) { const lo = n100(b[0]), hi = n100(b[1]); if (lo != null && hi != null && lo <= hi) (o.band = o.band || {})[k] = [lo, hi] }
    if (['low', 'medium', 'high'].includes(c.cl?.[k])) (o.cl = o.cl || {})[k] = c.cl[k]
    const n = Number(c.conf?.[k]); if (Number.isFinite(n) && n >= 0) (o.conf = o.conf || {})[k] = Math.min(1e5, Math.round(n * 10) / 10)
  }
  o.ops = (Array.isArray(c.ops) ? c.ops : []).filter((x) => x && OPS_KEYS.includes(x.k)).slice(0, 6).map((x) => ({ k: x.k, label: str(x.label, 40) || x.k, v: n100(x.v) ?? 50 }))
  o.top = (Array.isArray(c.top) ? c.top : []).filter((k) => DIM_KEYS.includes(k)).slice(0, 2)
  for (const k of ['line', 'mml', 'serverLine']) { const s = str(c[k], 160); if (s) o[k] = s }
  if (c.adjacent && COMIC.test(String(c.adjacent.comic || ''))) o.adjacent = { comic: c.adjacent.comic, short: str(c.adjacent.short, 30) || c.adjacent.comic, pct: n100(c.adjacent.pct) ?? 50 }
  if (c.funniest && CLIP.test(String(c.funniest.id || ''))) o.funniest = { id: c.funniest.id, title: str(c.funniest.title, 120) || '', comic: str(c.funniest.comic, 60) || '' }
  return o
}
const jparse = (s, d) => { try { const x = JSON.parse(s); return x ?? d } catch { return d } }
async function profileRow(DB, uid) { return DB.prepare('SELECT user_id, favs, pins, chart, humour, vis_profile, vis_diary, og_at, updated_at FROM profiles WHERE user_id = ?').bind(uid).first() }
async function specialsOf(DB, uid) {
  const r = await DB.prepare('SELECT special_id, seen, stars, note, at FROM specials_log WHERE user_id = ? ORDER BY at DESC LIMIT 500').bind(uid).all()
  return Object.fromEntries((r.results || []).map((x) => [x.special_id, { seen: !!x.seen, stars: x.stars || 0, note: x.note || '', at: x.at }]))
}
const profOut = (p) => ({ favs: jparse(p?.favs, []), pins: jparse(p?.pins, []), chart: jparse(p?.chart, null), humour: jparse(p?.humour, null), vis_profile: p?.vis_profile || 'public', vis_diary: p?.vis_diary || 'friends', og_at: p?.og_at || null, updated_at: p?.updated_at || null })

app.get('/me/profile-data', auth, async (c) => {
  const u = c.get('user'), DB = c.env.DB
  const [p, sp, sets] = await Promise.all([profileRow(DB, u.id), specialsOf(DB, u.id), DB.prepare('SELECT id, kind, title, visibility, created_at FROM sets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(u.id).all()])
  return c.json({ ...profOut(p), specials: sp, sets: sets.results || [] })
})
app.put('/me/profile-data', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, set = {}, errs = {}
  if ('favs' in b) {
    const a = Array.isArray(b.favs) ? [...new Set(b.favs.map((x) => String(x ?? '').trim()))] : null
    if (!a || a.length > 4 || a.some((x) => !COMIC.test(x))) errs.favs = 'up to 4 comic names'; else set.favs = JSON.stringify(a)
  }
  if ('pins' in b) {
    const a = Array.isArray(b.pins) ? [...new Set(b.pins.map(String))] : null
    if (!a || a.length > 6 || a.some((x) => !CLIP.test(x))) errs.pins = 'up to 6 clip ids'; else set.pins = JSON.stringify(a)
  }
  if ('chart' in b) { if (b.chart === null) set.chart = null; else { const ch = cleanChart(b.chart); if (!ch) errs.chart = 'a chart with at least 3 dimensions'; else set.chart = JSON.stringify(ch) } }
  for (const k of ['vis_profile', 'vis_diary']) if (k in b) { if (!VIS.includes(b[k])) errs[k] = 'public, friends or private'; else set[k] = b[k] }
  if ('humour' in b) { if (b.humour === null) set.humour = null; else { const h = cleanPassport(b.humour); const s = h && JSON.stringify(h); if (!h || s.length > 96000) errs.humour = 'a funnier.humour/v1 passport'; else set.humour = s } }
  if (Object.keys(errs).length) return c.json({ error: 'invalid', fields: errs }, 400)
  const DB = c.env.DB, t = now()
  if (Object.keys(set).length) {
    const ks = Object.keys(set)
    await DB.prepare(`INSERT INTO profiles (user_id, ${ks.join(', ')}, updated_at) VALUES (?, ${ks.map(() => '?').join(', ')}, ?)
      ON CONFLICT (user_id) DO UPDATE SET ${ks.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`).bind(u.id, ...ks.map((k) => set[k]), t).run()
  }
  return c.json({ ok: true, ...profOut(await profileRow(DB, u.id)) })
})
// specials diary: batch upsert; the newest edit (at) wins; an entry with nothing left is removed
app.put('/me/specials', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, log = b.log && typeof b.log === 'object' && !Array.isArray(b.log) ? b.log : null
  if (!log) return c.json({ error: 'no_log' }, 400)
  const ents = Object.entries(log).slice(0, 500), DB = c.env.DB, stmts = []
  let skipped = 0
  for (const [id, e] of ents) {
    if (!SPECIAL.test(id) || !e || typeof e !== 'object') { skipped++; continue }
    const at = typeof e.at === 'string' && !isNaN(Date.parse(e.at)) ? new Date(Math.min(Date.parse(e.at), Date.now())).toISOString() : now()
    const st = Number(e.stars), stars = Number.isFinite(st) && st > 0 ? Math.min(5, Math.max(0.5, Math.round(st * 2) / 2)) : null
    const note = str(e.note, 280) || null, seen = e.seen || stars ? 1 : 0
    if (!seen && !note) { stmts.push(DB.prepare('DELETE FROM specials_log WHERE user_id = ? AND special_id = ? AND at <= ?').bind(u.id, id, at)); continue }
    stmts.push(DB.prepare(`INSERT INTO specials_log (user_id, special_id, seen, stars, note, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, special_id) DO UPDATE SET seen = excluded.seen, stars = excluded.stars, note = excluded.note, at = excluded.at WHERE excluded.at >= specials_log.at`).bind(u.id, id, seen, stars, note, at))
  }
  if (stmts.length) await DB.batch(stmts)
  return c.json({ ok: true, saved: ents.length - skipped, skipped, specials: await specialsOf(DB, u.id) })
})
// link-preview image (1200x630 PNG drawn by the owner's browser from their own chart; no third-party imagery)
app.post('/me/og', auth, async (c) => {
  const u = c.get('user'), ct = c.req.header('content-type') || ''
  if (!/^image\/png\b/.test(ct)) return c.json({ error: 'png_only' }, 415)
  const buf = new Uint8Array(await c.req.arrayBuffer())
  if (buf.length < 100 || buf.length > OG_MAX) return c.json({ error: 'bad_size', max: OG_MAX }, 413)
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return c.json({ error: 'png_only' }, 415)
  const t = now()
  await c.env.DB.prepare(`INSERT INTO profiles (user_id, og, og_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET og = excluded.og, og_at = excluded.og_at`).bind(u.id, buf, t, t).run()
  return c.json({ ok: true, og_at: t, bytes: buf.length })
})
// who may see what: self sees all; friends see public + friends; everyone else sees public
async function viewer(c, owner) {
  const me = await currentUser(c)
  if (!me) return { me: null, self: false, friend: false }
  if (me.id === owner.id) return { me, self: true, friend: false }
  const f = await c.env.DB.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').bind(me.id, owner.id).first()
  return { me, self: false, friend: !!f }
}
const canSee = (vis, v) => v.self || vis === 'public' || (vis === 'friends' && v.friend)
// the public Humour Passport: GET /u/<name>/humour.json (any origin may read it; only when the profile is public)
app.get('/u/:username/humour.json', async (c) => {
  c.header('access-control-allow-origin', '*'); c.header('vary', 'origin')
  const name = c.req.param('username')
  if (!USERNAME.test(name)) return c.json({ error: 'not_found' }, 404)
  const DB = c.env.DB, owner = await DB.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').bind(name).first()
  if (!owner) return c.json({ error: 'not_found' }, 404)
  const p = await DB.prepare('SELECT humour, vis_profile FROM profiles WHERE user_id = ?').bind(owner.id).first()
  if (!p?.humour) return c.json({ error: 'no_passport' }, 404)
  if ((p.vis_profile || 'public') !== 'public') return c.json({ error: 'not_public' }, 403)
  const h = jparse(p.humour, null); if (!h) return c.json({ error: 'no_passport' }, 404)
  c.header('cache-control', 'public, max-age=60')
  return c.json({ ...h, user: owner.username })
})
app.get('/u/:username', async (c) => {
  const name = c.req.param('username')
  if (!USERNAME.test(name)) return c.json({ error: 'not_found' }, 404)
  const DB = c.env.DB, owner = await DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(name).first()
  if (!owner) return c.json({ error: 'not_found' }, 404)
  const [p, v] = await Promise.all([profileRow(DB, owner.id), viewer(c, owner)])
  const P = profOut(p), out = { user: { ...pub(owner), since: owner.created_at }, self: v.self, friend: v.friend, vis_profile: P.vis_profile, vis_diary: P.vis_diary }
  if (canSee(P.vis_profile, v)) Object.assign(out, { favs: P.favs, pins: P.pins, chart: P.chart, og: !!p?.og_at, humour: P.humour ? { ...P.humour, votes: undefined } : null })
  else out.hidden = true
  if (canSee(P.vis_diary, v)) out.specials = await specialsOf(DB, owner.id)
  if (canSee(P.vis_profile, v)) out.characters = ((await DB.prepare(`SELECT * FROM characters WHERE owner_id = ? ${v.self ? '' : "AND visibility = 'public'"} ORDER BY created_at DESC LIMIT 50`).bind(owner.id).all()).results || []).map((x) => charOut(x, false))
  if (canSee(P.vis_profile, v)) out.sets = (await DB.prepare(`SELECT id, kind, title, created_at FROM sets WHERE user_id = ? AND visibility IN (${v.self ? "'public','friends','private'" : v.friend ? "'public','friends'" : "'public'"}) ORDER BY created_at DESC LIMIT 50`).bind(owner.id).all()).results || []
  if (!v.self) c.header('cache-control', 'private, max-age=30')
  return c.json(out)
})
// the public link-preview image; 404 when there is none or the profile isn't public (funnier-web falls back to the site card)
// ---------- characters (trained from scratch with the same engine) + model versions ----------
const CHAR_ID = /^c[a-z0-9]{8,16}$/, VER_ID = /^[0-9a-f]{8}-[a-z0-9]{4,12}$/, SEED_OK = /^[A-Za-z0-9_-]{1,40}$/
const charOut = (r, withPassport = true) => r && ({ id: r.id, parent_id: r.parent_id || null, parent_hash: r.parent_hash || null, name: r.name, bio: r.bio || '', avatar_seed: r.avatar_seed || null, visibility: r.visibility,
  ...(withPassport ? { passport: jparse(r.passport, null) } : { hash: jparse(r.passport, null)?.hash || null, type: jparse(r.passport, null)?.type?.full || null }), created_at: r.created_at, updated_at: r.updated_at })
app.get('/me/characters', auth, async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM characters WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100').bind(c.get('user').id).all()
  return c.json({ characters: (r.results || []).map((x) => charOut(x)) })
})
// create or update one of your characters (the client makes the id, so it works offline first)
app.put('/characters/:id', auth, async (c) => {
  const id = c.req.param('id'), u = c.get('user'), b = (await body(c)) || {}, DB = c.env.DB, errs = {}
  if (!CHAR_ID.test(id)) return c.json({ error: 'bad_id' }, 400)
  const cur = await DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first()
  if (cur && cur.owner_id !== u.id) return c.json({ error: 'not_yours' }, 403)
  const set = {}
  if ('name' in b || !cur) { const n = str(b.name, 40)?.trim(); if (!n || n.length < 2) errs.name = '2-40 characters'; else set.name = n }
  if ('bio' in b) set.bio = str(b.bio, 160)?.trim() || null
  if ('avatar_seed' in b) { if (b.avatar_seed && !SEED_OK.test(b.avatar_seed)) errs.avatar_seed = 'bad seed'; else set.avatar_seed = b.avatar_seed || null }
  if ('visibility' in b) { if (!['public', 'private'].includes(b.visibility)) errs.visibility = 'public or private'; else set.visibility = b.visibility }
  if ('passport' in b) { if (b.passport === null) set.passport = null; else { const h = cleanPassport(b.passport, { allowVotes: false }); if (!h) errs.passport = 'a funnier.humour/v1 passport'; else set.passport = JSON.stringify(h) } }
  if (!cur && b.parent_id) { if (!CHAR_ID.test(b.parent_id)) errs.parent_id = 'bad id'; else { set.parent_id = b.parent_id; set.parent_hash = /^[0-9a-f]{8}$/.test(b.parent_hash || '') ? b.parent_hash : null } }
  if (Object.keys(errs).length) return c.json({ error: 'invalid', fields: errs }, 400)
  const t = now()
  if (!cur) {
    const n = await DB.prepare('SELECT COUNT(*) AS n FROM characters WHERE owner_id = ?').bind(u.id).first()
    if ((n?.n || 0) >= 50) return c.json({ error: 'too_many' }, 429)
    const ks = Object.keys(set)
    await DB.prepare(`INSERT INTO characters (id, owner_id, ${ks.join(', ')}, created_at, updated_at) VALUES (?, ?, ${ks.map(() => '?').join(', ')}, ?, ?)`).bind(id, u.id, ...ks.map((k) => set[k]), t, t).run()
  } else if (Object.keys(set).length) {
    const ks = Object.keys(set)
    await DB.prepare(`UPDATE characters SET ${ks.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...ks.map((k) => set[k]), t, id).run()
  }
  return c.json({ ok: true, character: charOut(await DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first()) })
})
app.delete('/characters/:id', auth, async (c) => {
  const id = c.req.param('id'), u = c.get('user'), DB = c.env.DB
  const cur = await DB.prepare('SELECT owner_id FROM characters WHERE id = ?').bind(id).first()
  if (!cur) return c.json({ error: 'not_found' }, 404)
  if (cur.owner_id !== u.id) return c.json({ error: 'not_yours' }, 403)
  await DB.batch([DB.prepare('DELETE FROM characters WHERE id = ?').bind(id), DB.prepare('DELETE FROM model_versions WHERE user_id = ? AND subject = ?').bind(u.id, id)])
  return c.json({ ok: true })
})
// the public character page: /c/<id> (public, or the owner)
app.get('/c/:id', async (c) => {
  const id = c.req.param('id'), DB = c.env.DB
  if (!CHAR_ID.test(id)) return c.json({ error: 'not_found' }, 404)
  const r = await DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first()
  if (!r) return c.json({ error: 'not_found' }, 404)
  const me = await currentUser(c), own = me && me.id === r.owner_id
  if (r.visibility !== 'public' && !own) return c.json({ error: 'private' }, 403)
  const [owner, vs, kids] = await Promise.all([DB.prepare('SELECT username, avatar_seed, avatar_id FROM users WHERE id = ?').bind(r.owner_id).first(),
    DB.prepare('SELECT id, hash, name, votes, created_at FROM model_versions WHERE user_id = ? AND subject = ? ORDER BY created_at DESC LIMIT 50').bind(r.owner_id, id).all(),
    DB.prepare("SELECT COUNT(*) AS n FROM characters WHERE parent_id = ? AND visibility = 'public'").bind(id).first()])
  if (!own) c.header('cache-control', 'private, max-age=30')
  return c.json({ character: charOut(r), owner: owner ? pub(owner) : null, own: !!own, versions: vs.results || [], forks: kids?.n || 0, chat: c.env.CHAT_ENABLED === 'true' })
})
app.get('/c/:id/v/:vid', async (c) => {
  const id = c.req.param('id'), vid = c.req.param('vid'), DB = c.env.DB
  if (!CHAR_ID.test(id) || !VER_ID.test(vid)) return c.json({ error: 'not_found' }, 404)
  const r = await DB.prepare('SELECT owner_id, visibility FROM characters WHERE id = ?').bind(id).first(); if (!r) return c.json({ error: 'not_found' }, 404)
  const me = await currentUser(c); if (r.visibility !== 'public' && !(me && me.id === r.owner_id)) return c.json({ error: 'private' }, 403)
  const v = await DB.prepare('SELECT * FROM model_versions WHERE id = ? AND subject = ?').bind(vid, id).first(); if (!v) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: v.id, hash: v.hash, name: v.name, votes: v.votes, created_at: v.created_at, passport: jparse(v.passport, null) })
})
// fork / fine-tune: copy a public character (or your own) into a new private one you own, keeping parent_id + the snapshot hash
app.post('/characters/:id/fork', auth, async (c) => {
  const id = c.req.param('id'), u = c.get('user'), b = (await body(c)) || {}, DB = c.env.DB
  const r = await DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first()
  if (!r || (r.visibility !== 'public' && r.owner_id !== u.id)) return c.json({ error: 'not_found' }, 404)
  const nid = CHAR_ID.test(b.id || '') ? b.id : 'c' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  if (await DB.prepare('SELECT 1 FROM characters WHERE id = ?').bind(nid).first()) return c.json({ error: 'id_taken' }, 409)
  const t = now(), pp = jparse(r.passport, null)
  await DB.prepare('INSERT INTO characters (id, owner_id, parent_id, parent_hash, name, bio, avatar_seed, visibility, passport, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nid, u.id, r.id, pp?.hash || null, (str(b.name, 40)?.trim() || ('Son of ' + r.name).slice(0, 40)), r.bio, r.avatar_seed, 'private', r.passport, t, t).run()
  return c.json({ ok: true, character: charOut(await DB.prepare('SELECT * FROM characters WHERE id = ?').bind(nid).first()) })
})
// "Prompt them": the slot for a server-side LLM. Off until a key + CHAT_ENABLED=true are configured; the client hands
// the humour payload to the user's own assistant instead.
app.post('/c/:id/chat', async (c) => {
  if (c.env.CHAT_ENABLED !== 'true') return c.json({ error: 'chat_disabled', hint: 'Copy the humour payload into ChatGPT or Claude for now.' }, 501)
  return c.json({ error: 'not_implemented' }, 501)
})
// immutable model versions (a passport artifact each), yours or your characters'
app.post('/me/versions', auth, async (c) => {
  const u = c.get('user'), b = (await body(c)) || {}, DB = c.env.DB, v = b.version || {}
  const subject = b.subject === 'me' ? 'me' : CHAR_ID.test(b.subject || '') ? b.subject : null
  if (!subject) return c.json({ error: 'bad_subject' }, 400)
  if (subject !== 'me') { const r = await DB.prepare('SELECT owner_id FROM characters WHERE id = ?').bind(subject).first(); if (!r || r.owner_id !== u.id) return c.json({ error: 'not_yours' }, 403) }
  const p = cleanPassport(v.passport, { allowVotes: false })
  if (!VER_ID.test(v.id || '') || !p) return c.json({ error: 'invalid' }, 400)
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM model_versions WHERE user_id = ?').bind(u.id).first()
  if ((n?.n || 0) >= 500) return c.json({ error: 'too_many' }, 429)
  await DB.prepare('INSERT OR IGNORE INTO model_versions (id, user_id, subject, hash, name, votes, passport, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(v.id, u.id, subject, p.hash, str(v.name, 60) || null, p.n.votes, JSON.stringify(p), !isNaN(Date.parse(v.at)) ? new Date(Math.min(Date.parse(v.at), Date.now())).toISOString() : now()).run()
  return c.json({ ok: true, id: v.id, hash: p.hash })
})
app.get('/me/versions', auth, async (c) => {
  const s = c.req.query('subject') || 'me'
  const r = await c.env.DB.prepare('SELECT id, subject, hash, name, votes, passport, created_at FROM model_versions WHERE user_id = ? AND subject = ? ORDER BY created_at DESC LIMIT 100').bind(c.get('user').id, s).all()
  return c.json({ versions: (r.results || []).map((x) => ({ ...x, passport: jparse(x.passport, null) })) })
})
app.get('/og/u/:file', async (c) => {
  const m = c.req.param('file').match(/^([A-Za-z0-9_]{3,20})\.png$/)
  if (!m) return c.json({ error: 'not_found' }, 404)
  const r = await c.env.DB.prepare(`SELECT p.og, p.vis_profile FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.username = ? COLLATE NOCASE`).bind(m[1]).first()
  if (!r?.og || r.vis_profile !== 'public') return c.json({ error: 'not_found' }, 404)
  const bytes = r.og instanceof ArrayBuffer ? new Uint8Array(r.og) : Array.isArray(r.og) ? new Uint8Array(r.og) : r.og
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' } })
})

// ---------- clips: learned durations, crowd loudness, laughs (anonymous allowed: a random device id) ----------
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/
const LAUGH_GAP_MS = 700 // one laugh per 0.7s per user/device
const MAX_T = 6 * 3600
async function voterOf(c, b) {
  const uid = await sessionUid(c)
  if (uid) return 'u:' + uid
  const d = String(b?.device ?? c.req.header('x-funnier-device') ?? '')
  return DEVICE.test(d) ? 'd:' + d : null
}
export function audioOffsets(rows) { // rows: [{clip, loud, quiet}] -> per-clip volume offsets (YouTube can only attenuate)
  const STEP_DB = 3, out = {}
  let ref = 0
  for (const r of rows) {
    const n = r.loud + r.quiet, net = r.loud - r.quiet
    const steps = n >= 3 ? Math.round(Math.max(-4, Math.min(4, net / Math.sqrt(n)))) : 0
    const db = STEP_DB * steps || 0 // + = the crowd hears it louder than the rest
    out[r.clip] = { loud: r.loud, quiet: r.quiet, db }
    ref = Math.min(ref, db) // normalise to the quietest clip's level
  }
  const off = (db) => Math.max(-40, Math.min(0, Math.round(100 * Math.pow(10, (ref - db) / 20)) - 100))
  for (const k of Object.keys(out)) out[k].offset = off(out[k].db)
  return { clips: out, ref_db: ref, default_offset: off(0) }
}

app.get('/clips/durations', async (c) => {
  const r = await c.env.DB.prepare('SELECT clip, dur_sec, reports FROM clip_durations').all()
  const durs = {}
  for (const x of r.results || []) durs[x.clip] = Math.round(x.dur_sec * 10) / 10
  c.header('cache-control', 'public, max-age=300')
  return c.json({ durs })
})
app.post('/clips/durations', async (c) => {
  const b = (await body(c)) || {}
  const src = b.durs && typeof b.durs === 'object' ? b.durs : b.clip ? { [b.clip]: b.dur } : {}
  const list = Object.entries(src).filter(([k, v]) => CLIP.test(k) && Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= MAX_T).slice(0, 100)
  if (!list.length) return c.json({ error: 'no_durations' }, 400)
  const DB = c.env.DB, t = now()
  // a running mean (weight capped at 9 reports); a report >50% off an established value (3+ reports) is ignored
  await DB.batch(list.map(([k, v]) => DB.prepare(`INSERT INTO clip_durations (clip, dur_sec, reports, updated_at) VALUES (?1, ?2, 1, ?3)
    ON CONFLICT (clip) DO UPDATE SET
      dur_sec = CASE WHEN reports >= 3 AND ABS(excluded.dur_sec - dur_sec) > 0.5 * dur_sec THEN dur_sec ELSE (dur_sec * MIN(reports, 9) + excluded.dur_sec) / (MIN(reports, 9) + 1) END,
      reports = CASE WHEN reports >= 3 AND ABS(excluded.dur_sec - dur_sec) > 0.5 * dur_sec THEN reports ELSE reports + 1 END,
      updated_at = ?3`).bind(k, Number(v), t)))
  return c.json({ ok: true, saved: list.length })
})

app.get('/clips/audio', async (c) => {
  const r = await c.env.DB.prepare(`SELECT clip, SUM(CASE WHEN dir = 'loud' THEN 1 ELSE 0 END) AS loud, SUM(CASE WHEN dir = 'quiet' THEN 1 ELSE 0 END) AS quiet FROM clip_audio GROUP BY clip`).all()
  c.header('cache-control', 'public, max-age=120')
  return c.json(audioOffsets((r.results || []).map((x) => ({ clip: x.clip, loud: Number(x.loud) || 0, quiet: Number(x.quiet) || 0 }))))
})
app.post('/clips/audio', async (c) => {
  const b = (await body(c)) || {}
  if (!CLIP.test(b.clip || '') || !['loud', 'quiet'].includes(b.dir)) return c.json({ error: 'bad_request' }, 400)
  const who = await voterOf(c, b); if (!who) return c.json({ error: 'device_required' }, 400)
  await c.env.DB.prepare(`INSERT INTO clip_audio (clip, user_or_device, dir, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (clip, user_or_device) DO UPDATE SET dir = excluded.dir, created_at = excluded.created_at`).bind(b.clip, who, b.dir, now()).run()
  return c.json({ ok: true })
})

app.post('/laughs', async (c) => {
  const b = (await body(c)) || {}, t = Number(b.t)
  if (!CLIP.test(b.clip || '') || !Number.isFinite(t) || t < 0 || t > MAX_T) return c.json({ error: 'bad_request' }, 400)
  const who = await voterOf(c, b); if (!who) return c.json({ error: 'device_required' }, 400)
  const DB = c.env.DB, ms = Date.now()
  const last = await DB.prepare('SELECT MAX(created_at) AS at FROM laughs WHERE user_or_device = ?').bind(who).first()
  if (last?.at && ms - last.at < LAUGH_GAP_MS) return c.json({ error: 'rate_limited', retry_ms: LAUGH_GAP_MS - (ms - last.at) }, 429)
  await DB.prepare('INSERT INTO laughs (clip, t_sec, user_or_device, created_at) VALUES (?, ?, ?, ?)').bind(b.clip, Math.floor(t), who, ms).run()
  return c.json({ ok: true })
})
app.get('/laughs/:clip', async (c) => {
  const k = c.req.param('clip'); if (!CLIP.test(k)) return c.json({ error: 'bad_clip' }, 400)
  const r = await c.env.DB.prepare('SELECT t_sec, COUNT(*) AS n FROM laughs WHERE clip = ? GROUP BY t_sec ORDER BY t_sec').bind(k).all()
  const rows = r.results || [], len = rows.length ? rows[rows.length - 1].t_sec + 1 : 0, bins = new Array(len).fill(0)
  let total = 0
  for (const x of rows) { bins[x.t_sec] = x.n; total += x.n }
  c.header('cache-control', 'public, max-age=30')
  return c.json({ clip: k, bin_sec: 1, bins, total, max: bins.length ? Math.max(...bins) : 0 })
})

// ---------- public stats ----------
app.get('/stats/clash/:a/:b', async (c) => {
  const { a: ra, b: rb } = c.req.param()
  if (!CLIP.test(ra) || !CLIP.test(rb) || ra === rb) return c.json({ error: 'bad_clip' }, 400)
  const [a, b] = sorted(ra, rb), DB = c.env.DB
  const [tot, cc] = await DB.batch([
    DB.prepare('SELECT winner, COUNT(*) AS n FROM votes WHERE a = ? AND b = ? GROUP BY winner').bind(a, b),
    DB.prepare('SELECT cc, winner, COUNT(*) AS n FROM votes WHERE a = ? AND b = ? AND cc IS NOT NULL GROUP BY cc, winner').bind(a, b),
  ])
  const cnt = { [ra]: 0, [rb]: 0 }
  for (const x of tot.results || []) cnt[x.winner] = (cnt[x.winner] || 0) + x.n
  const total = cnt[ra] + cnt[rb]
  const per = {}
  for (const x of cc.results || []) { const p = (per[x.cc] = per[x.cc] || { cc: x.cc, total: 0, A: 0, B: 0 }); p.total += x.n; if (x.winner === ra) p.A += x.n; else p.B += x.n }
  const countries = Object.values(per).filter((p) => p.total >= 5).sort((x, y) => y.total - x.total).map((p) => ({ cc: p.cc, total: p.total, pctA: pct(p.A, p.total), pctB: 100 - pct(p.A, p.total) }))
  c.header('cache-control', 'public, max-age=30')
  return c.json({ a: ra, b: rb, total, countA: cnt[ra], countB: cnt[rb], pctA: pct(cnt[ra], total), pctB: total ? 100 - pct(cnt[ra], total) : 0, countries, min_country: 5 })
})

export default app
