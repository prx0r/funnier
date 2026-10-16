// funnier-api: Google sign-in + accounts, votes, friends, invites, taste match, clash stats, laughs, learned clip durations and crowd loudness on Cloudflare Workers + D1.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
const SIG_BOOL = ['skippedAhead', 'leftSkipped', 'rightSkipped']
export function cleanSignals(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = {}
  for (const [k, mx] of Object.entries(SIG_INT)) { const v = Number(x[k]); if (x[k] != null && Number.isFinite(v) && v >= 0) o[k] = Math.min(mx, Math.round(v)) }
  for (const k of SIG_ARR) if (Array.isArray(x[k])) { const a = x[k].slice(0, 20).map(Number).filter((v) => Number.isFinite(v) && v >= 0).map((v) => Math.min(36000, Math.round(v))); if (a.length) o[k] = a }
  for (const k of SIG_BOOL) if (x[k] === true) o[k] = true
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
    DB.prepare('DELETE FROM humour_profiles WHERE user_id = ?').bind(id),
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

// the interpretable humour profile, fitted offline from bit theory features (tools/humour.mjs); null until there is enough data
app.get('/me/humour', auth, async (c) => {
  const r = await c.env.DB.prepare('SELECT profile, updated_at FROM humour_profiles WHERE user_id = ?').bind(c.get('user').id).first()
  let p = null; try { p = r ? JSON.parse(r.profile) : null } catch {}
  return c.json({ humour: p, updated: r?.updated_at || null })
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
