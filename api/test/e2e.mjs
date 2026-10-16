// End-to-end test against `wrangler dev --local` with a mocked Google JWKS.
// Usage: node test/e2e.mjs            (starts the JWKS mock + wrangler dev itself, local D1, nothing remote)
//        BASE=https://...workers.dev node test/e2e.mjs --remote-smoke   (only the unauthenticated checks)
import http from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const ORIGIN = 'https://prx0r.github.io'
const fails = []
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function smoke(BASE) {
  const r = await fetch(BASE + '/me', { headers: { origin: ORIGIN } })
  ok(r.status === 401, `GET /me without a session -> 401 (got ${r.status})`)
  ok(r.headers.get('access-control-allow-origin') === ORIGIN, 'CORS allow-origin echoes https://prx0r.github.io')
  ok(r.headers.get('access-control-allow-credentials') === 'true', 'CORS allow-credentials true')
  const pf = await fetch(BASE + '/votes', { method: 'OPTIONS', headers: { origin: 'https://funnier.si', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })
  ok(pf.status === 204 && pf.headers.get('access-control-allow-origin') === 'https://funnier.si', `preflight from funnier.si allowed (${pf.status})`)
  const pw = await fetch(BASE + '/laughs', { method: 'OPTIONS', headers: { origin: 'https://www.funnier.si', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
  ok(pw.status === 204 && pw.headers.get('access-control-allow-origin') === 'https://www.funnier.si', `preflight from www.funnier.si allowed (${pw.status})`)
  ok(/authorization/i.test(pf.headers.get('access-control-allow-headers') || ''), 'preflight allows the authorization header')
  const bad = await fetch(BASE + '/me', { headers: { origin: 'https://evil.example' } })
  ok(!bad.headers.get('access-control-allow-origin'), 'unknown origin gets no CORS header')
  const st = await fetch(BASE + '/stats/clash/aaaaaaaaaaa/bbbbbbbbbbb')
  ok(st.status === 200, 'GET /stats/clash public -> 200')
  for (const p of ['/laughs/aaaaaaaaaaa', '/clips/durations', '/clips/audio']) {
    const x = await fetch(BASE + p, { headers: { origin: ORIGIN } }); let j = null; try { j = await x.json() } catch {}
    ok(x.status === 200 && j && x.headers.get('access-control-allow-origin') === ORIGIN, `GET ${p} public + CORS -> 200`)
  }
  const lp = await fetch(BASE + '/laughs', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
  ok(lp.status === 204 && lp.headers.get('access-control-allow-origin') === ORIGIN, `preflight POST /laughs allowed (${lp.status})`)
}

if (process.argv.includes('--remote-smoke')) {
  await smoke(process.env.BASE)
  console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
}

// ---- local: mock Google JWKS ----
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test1', alg: 'RS256', use: 'sig' }
const jwksSrv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ keys: [jwk] })) })
await new Promise((r) => jwksSrv.listen(8798, '127.0.0.1', r))
const CID = 'test-client.apps.googleusercontent.com'
const idToken = (sub, extra = {}, aud = CID) => new SignJWT({ email: sub + '@example.com', email_verified: true, name: 'Test ' + sub, picture: 'https://lh3.googleusercontent.com/a/x', ...extra })
  .setProtectedHeader({ alg: 'RS256', kid: 'test1' }).setIssuer('https://accounts.google.com').setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)

execSync('npx wrangler d1 execute funnier --local --file schema.sql', { stdio: 'ignore' })
try { execSync('npx wrangler d1 execute funnier --local --file migrations/0002_avatar_seed.sql', { stdio: 'ignore' }) } catch {} // already applied -> duplicate column
execSync('npx wrangler d1 execute funnier --local --file migrations/0003_laughs_durations_audio.sql', { stdio: 'ignore' }) // idempotent
execSync('npx wrangler d1 execute funnier --local --file migrations/0004_watch_signals.sql', { stdio: 'ignore' }) // idempotent
try { execSync('npx wrangler d1 execute funnier --local --file migrations/0005_votes_signals.sql', { stdio: 'ignore' }) } catch {} // already applied -> duplicate column
execSync('npx wrangler d1 execute funnier --local --file migrations/0006_profiles.sql', { stdio: 'ignore' }) // idempotent
try { execSync('npx wrangler d1 execute funnier --local --file migrations/0007_humour_passport.sql', { stdio: 'ignore' }) } catch {} // already applied -> duplicate column
execSync('npx wrangler d1 execute funnier --local --file migrations/0008_characters_versions.sql', { stdio: 'ignore' }) // idempotent
execSync(`npx wrangler d1 execute funnier --local --command "DELETE FROM votes; DELETE FROM friends; DELETE FROM invites; DELETE FROM invite_opens; DELETE FROM users; DELETE FROM laughs; DELETE FROM clip_durations; DELETE FROM clip_audio; DELETE FROM watch_events; DELETE FROM humour_profiles; DELETE FROM profiles; DELETE FROM specials_log; DELETE FROM sets; DELETE FROM characters; DELETE FROM model_versions;"`, { stdio: 'ignore' })
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`
const dev = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1',
  '--var', `GOOGLE_CLIENT_ID:${CID}`, '--var', 'ALLOW_TEST_JWKS:1', '--var', 'TEST_JWKS_URL:http://127.0.0.1:8798/jwks', '--var', 'SESSION_SECRET:local-test-secret-not-for-prod'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let log = ''; dev.stdout.on('data', (d) => (log += d)); dev.stderr.on('data', (d) => (log += d))
const stop = () => { try { process.kill(-dev.pid) } catch {} jwksSrv.close() }
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break } catch {} await sleep(500) }
  await smoke(BASE)
  const J = async (method, p, tok, b) => { const r = await fetch(BASE + p, { method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json() } catch {} return { s: r.status, j, h: r.headers } }

  let r = await J('POST', '/auth/google', null, { credential: await idToken('g1', {}, 'someone-else') })
  ok(r.s === 401, 'ID token with the wrong audience -> 401')
  r = await J('POST', '/auth/google', null, { credential: 'garbage' })
  ok(r.s === 401, 'garbage credential -> 401')
  r = await J('POST', '/auth/google', null, { credential: await idToken('g1') })
  ok(r.s === 200 && r.j?.token && r.j.needsProfile === true, 'valid Google ID token -> session + needsProfile')
  ok(/funnier_session=.*HttpOnly.*Secure.*SameSite=None/i.test(r.h.get('set-cookie') || ''), 'sets HttpOnly; Secure; SameSite=None cookie')
  const t1 = r.j.token
  r = await J('GET', '/me', t1); ok(r.s === 200 && r.j.user.email === 'g1@example.com', 'GET /me with bearer -> 200')
  r = await J('PUT', '/me/profile', t1, { username: 'no spaces!' }); ok(r.s === 400 && r.j.fields?.username, 'bad username -> 400')
  r = await J('PUT', '/me/profile', t1, { birth_year: new Date().getUTCFullYear() - 10 }); ok(r.s === 400 && r.j.error === 'too_young', 'under 13 -> rejected')
  r = await J('PUT', '/me/profile', t1, { avatar_id: 'banana' }); ok(r.s === 400, 'unknown legacy avatar id -> 400')
  r = await J('PUT', '/me/profile', t1, { avatar_seed: 'x'.repeat(41) }); ok(r.s === 400 && r.j.fields?.avatar_seed, 'avatar seed over 40 chars -> 400')
  r = await J('PUT', '/me/profile', t1, { avatar_seed: 'bad seed!' }); ok(r.s === 400 && r.j.fields?.avatar_seed, 'avatar seed with spaces/symbols -> 400')
  r = await J('PUT', '/me/profile', t1, { avatar_id: 'wink' }); ok(r.s === 200 && r.j.user.avatar_seed === 'preset-wink', 'legacy avatar_id maps to deterministic seed preset-wink')
  r = await J('PUT', '/me/profile', t1, { sex_at_birth: 'other' }); ok(r.s === 400, 'bad sex_at_birth -> 400')
  r = await J('PUT', '/me/profile', t1, { username: 'DeadpanDuck42', avatar_seed: 'k3j9x0q2ab', birth_year: 1990, country: 'gb', sex_at_birth: 'skip' })
  ok(r.s === 200 && r.j.needsProfile === false && r.j.user.country === 'GB', 'full profile saved')

  // ---- onboarding save exactly as the sheet sends it (default fields only, then everything), over a www.funnier.si origin ----
  {
    const W = async (method, p, tok, b) => { const x = await fetch(BASE + p, { method, headers: { origin: 'https://www.funnier.si', 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await x.json() } catch {} return { s: x.status, j, h: x.headers } }
    let o = await W('POST', '/auth/google', null, { credential: await idToken('onb1') }); const to = o.j?.token
    ok(o.s === 200 && to && o.j.needsProfile === true, 'onboarding: fresh sign-in needs a profile')
    o = await W('PUT', '/me/profile', to, { username: 'Prior Trades', avatar_seed: 'hmbm7a3jvv', country: 'KH' })
    ok(o.s === 400 && o.j.fields?.username && !o.j.fields.country && o.h.get('access-control-allow-origin') === 'https://www.funnier.si', 'onboarding: a username with a space -> 400 with a username field error (CORS ok)')
    o = await W('PUT', '/me/profile', to, { username: 'SnarkyMoose20', avatar_seed: 'hmbm7a3jvv', country: 'KH' })
    ok(o.s === 200 && o.j.user.username === 'SnarkyMoose20' && o.j.user.avatar_seed === 'hmbm7a3jvv' && o.j.needsProfile === false, 'onboarding: defaults only (name + device mascot + country) saves and completes the profile')
    o = await W('GET', '/me', to); ok(o.s === 200 && o.j.user.username === 'SnarkyMoose20' && o.j.needsProfile === false, 'onboarding: GET /me shows the saved profile')
    o = await W('PUT', '/me/profile', to, { username: 'SnarkyMoose20', avatar_seed: 'qcrktb7wyk', country: 'GB', birth_year: 1994, sex_at_birth: 'female' })
    ok(o.s === 200 && o.j.user.birth_year === 1994 && o.j.user.country === 'GB' && o.j.user.sex_at_birth === 'female' && o.j.user.avatar_seed === 'qcrktb7wyk', 'onboarding: optional year/country/sex save too')
    o = await W('POST', '/auth/google', null, { credential: await idToken('onb1') }); ok(o.s === 200 && o.j.needsProfile === false && o.j.user.username === 'SnarkyMoose20', 'onboarding: signing in again keeps the profile (no second onboarding)')
    o = await W('PUT', '/me/profile', 'not-a-token', { username: 'Whatever_1' }); ok(o.s === 401 && o.h.get('access-control-allow-origin') === 'https://www.funnier.si', 'onboarding: a stale session -> 401 the client can explain')
  }

  r = await J('POST', '/auth/google', null, { credential: await idToken('g2') }); const t2 = r.j.token
  r = await J('PUT', '/me/profile', t2, { username: 'deadpanduck42' }); ok(r.s === 409, 'username unique (case-insensitive) -> 409')
  r = await J('PUT', '/me/profile', t2, { username: 'PunchyPanda7', avatar_id: 'grin', birth_year: 1985, country: 'US', sex_at_birth: 'female' }); ok(r.s === 200, 'second profile saved')

  const A = 'clipAAAAAAA', B = 'clipBBBBBBB'
  r = await J('POST', '/invites', t1, { a: A, b: B, pick: 'a' }); const code = r.j?.code
  ok(r.s === 200 && /^[A-Za-z0-9]{8}$/.test(code || '') && r.j.urls.includes('https://www.funnier.si/#i/' + code) && r.j.url === 'https://www.funnier.si/#i/' + code, 'POST /invites -> code, primary www.funnier.si URL + github.io')
  r = await J('POST', '/invites', t1, { a: A, b: B, pick: 'a' }); ok(r.j?.code === code, 're-sharing the same clash reuses the code')
  r = await J('GET', '/invites/' + code, null); ok(r.s === 200 && r.j.inviter.username === 'DeadpanDuck42' && r.j.inviter.avatar_seed === 'k3j9x0q2ab' && r.j.inviter.google_avatar === null && r.j.open_id, 'anonymous open: inviter username/avatar + open_id')
  const anonOpen = r.j.open_id
  r = await J('POST', `/invites/${code}/voted`, null, { open_id: anonOpen }); ok(r.s === 200, 'anonymous opener marks voted')
  r = await J('GET', '/invites/' + code, t2); const open2 = r.j.open_id; ok(r.s === 200 && r.j.friends === false, 'signed-in open recorded')
  r = await J('GET', '/invites/' + code, t1); ok(r.j.self === true && r.j.open_id === null, "inviter's own open is not counted")
  r = await J('POST', '/votes', t2, { votes: [{ a: A, b: B, winner: B, ms: 900, createdAt: new Date(Date.now() - 5000).toISOString() }] }); ok(r.s === 200 && r.j.saved === 1, 'POST /votes batch')
  r = await J('POST', `/invites/${code}/accept`, t2, { open_id: open2 }); ok(r.s === 200 && r.j.friend.username === 'DeadpanDuck42', 'accept invite -> friendship')
  r = await J('POST', `/invites/${code}/accept`, t1, {}); ok(r.s === 400, 'cannot accept your own invite')
  r = await J('GET', '/me/invites', t1)
  ok(r.s === 200 && r.j.totals.sent === 1 && r.j.invites[0].opens === 2 && r.j.invites[0].voted === 2 && r.j.invites[0].people[0]?.username === 'PunchyPanda7', 'GET /me/invites: opens + voted + who')
  r = await J('GET', `/clash/${B}/${A}/friends`, t1); ok(r.s === 200 && r.j.friends.length === 1 && r.j.friends[0].winner === B && r.j.friends[0].avatar_seed === 'preset-grin', "friends' votes on the pair (either order)")

  // latest wins
  r = await J('POST', '/votes', t2, { votes: [{ a: B, b: A, winner: A, createdAt: new Date().toISOString() }] })
  r = await J('GET', `/clash/${A}/${B}/friends`, t1); ok(r.j.friends[0].winner === A, 'latest vote on a pair wins')
  r = await J('POST', '/votes', t2, { votes: [{ a: A, b: B, winner: B, createdAt: '2020-01-01T00:00:00Z' }] })
  r = await J('GET', `/clash/${A}/${B}/friends`, t1); ok(r.j.friends[0].winner === A, 'an older vote does not overwrite a newer one')

  // taste: needs 3 shared pairs
  const pairs = [['p1aaaaaaaaa', 'p1bbbbbbbbb'], ['p2aaaaaaaaa', 'p2bbbbbbbbb'], ['p3aaaaaaaaa', 'p3bbbbbbbbb']]
  await J('POST', '/votes', t1, { votes: [{ a: A, b: B, winner: A }, { a: pairs[0][0], b: pairs[0][1], winner: pairs[0][0] }] })
  await J('POST', '/votes', t2, { votes: [{ a: pairs[0][0], b: pairs[0][1], winner: pairs[0][0] }] })
  r = await J('GET', '/me/taste', t1); ok(r.s === 200 && r.j.friends[0].shared === 2 && r.j.friends[0].match === null, 'taste match hidden under 3 shared pairs')
  await J('POST', '/votes', t1, { votes: [{ a: pairs[1][0], b: pairs[1][1], winner: pairs[1][1] }] })
  await J('POST', '/votes', t2, { votes: [{ a: pairs[1][0], b: pairs[1][1], winner: pairs[1][0] }] })
  r = await J('GET', '/me/taste', t1); ok(r.j.friends[0].shared === 3 && r.j.friends[0].match === 67, `taste match = agreement on shared pairs (got ${r.j.friends[0].match}%)`)
  ok(r.j.friends[0].avatar_seed === 'preset-grin' && r.j.friends[0].google_avatar === null, 'taste list carries the friend avatar_seed (legacy preset mapped)')

  // stats: per-country only with >= 5
  for (let i = 0; i < 5; i++) {
    const t = (await J('POST', '/auth/google', null, { credential: await idToken('cc' + i) })).j.token
    await J('PUT', '/me/profile', t, { country: 'DE' })
    await J('POST', '/votes', t, { votes: [{ a: A, b: B, winner: i < 3 ? A : B }] })
  }
  r = await J('GET', `/stats/clash/${A}/${B}`)
  ok(r.s === 200 && r.j.total === 7 && r.j.countries.length === 1 && r.j.countries[0].cc === 'DE' && r.j.countries[0].pctA === 60, `global split + per-country only at >=5 (total ${r.j.total}, ${JSON.stringify(r.j.countries)})`)
  r = await J('POST', '/votes', t1, { votes: [{ a: A, b: A, winner: A }] }); ok(r.j.skipped === 1, 'invalid vote rows are skipped')

  // ---- watch signals (§3a/§3b): optional, sanitised, stored as JSON with the on-screen order; skips/passes as events ----
  const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute funnier --local --json --command "${q}"`, { encoding: 'utf8' }))[0].results
  const SA = 'sigAAAAAAAA', SB = 'sigBBBBBBBB'
  r = await J('POST', '/votes', t1, { votes: [{ a: SB, b: SA, winner: SA, createdAt: new Date().toISOString(),
    signals: { leftWatchedSec: 41.6, rightWatchedSec: 33, rightPct: 0.9 * 100, replays: 2, rightSeekTargets: [72, 'x', -5, 118.4], rightSeekFrom: [80, 125], skippedAhead: true, evil: 'drop me', leftSkipped: 'yes', policy: { m: 'training', pm: 400, pp: 31250.7, f: [600, 200, 500], z: [1, 2], q: 480, v: 'screen-1-default', bad: 1 } } }] })
  ok(r.s === 200 && r.j.saved === 1, 'vote with signals accepted')
  let row = sql(`SELECT signals FROM votes WHERE a = '${SA}' AND b = '${SB}'`)[0]; let sg = JSON.parse(row?.signals || 'null')
  ok(sg && sg.shown[0] === SB && sg.leftWatchedSec === 42 && sg.rightPct === 90 && sg.replays === 2 && JSON.stringify(sg.rightSeekTargets) === '[72,118]' && sg.skippedAhead === true && !('evil' in sg) && !('leftSkipped' in sg), `signals sanitised + stored in shown order (${row?.signals})`)
  ok(sg?.policy?.m === 'training' && sg.policy.pm === 400 && sg.policy.pp === 31251 && JSON.stringify(sg.policy.f) === '[600,200,500]' && !sg.policy.z && !('bad' in sg.policy), `logged screening policy kept, sanitised (${JSON.stringify(sg?.policy)})`)
  r = await J('POST', '/votes', t1, { votes: [{ a: SB, b: SA, winner: SB, createdAt: new Date(Date.now() + 1000).toISOString() }] })
  row = sql(`SELECT winner, signals FROM votes WHERE a = '${SA}' AND b = '${SB}'`)[0]
  ok(row.winner === SB && JSON.parse(row.signals || 'null')?.replays === 2, 'a later vote without signals keeps the earlier signals (backward compatible)')
  r = await J('POST', '/votes', t2, { votes: [{ a: SA, b: SB, winner: SA }] }); ok(r.s === 200 && r.j.saved === 1, 'old-style vote without signals still saves')
  const at = new Date().toISOString()
  const evs = [{ kind: 'skip', a: SA, b: SB, stage: 'right-skip', clip: SB, watchedSec: 12.4, signals: { rightSkippedAt: 95, rightSkipped: true }, createdAt: at },
    { kind: 'pass', a: SA, b: SB, stage: 'vote', ms: 3100, signals: { leftSeekTargets: [10] }, createdAt: at }, { kind: 'laugh', a: SA, b: SB, createdAt: at }, { kind: 'skip', a: SA, b: SA, createdAt: at }]
  r = await J('POST', '/events', t1, { events: evs }); ok(r.s === 200 && r.j.saved === 2 && r.j.skipped === 2, `POST /events saves skips + passes, drops bad rows (${JSON.stringify(r.j)})`)
  r = await J('POST', '/events', t1, { events: evs.slice(0, 2) }); const nev = sql(`SELECT COUNT(*) AS n FROM watch_events WHERE a = '${SA}'`)[0].n
  ok(nev === 2, `re-syncing the same events does not duplicate them (${nev})`)
  row = sql(`SELECT stage, clip, watched_sec, signals FROM watch_events WHERE kind = 'skip' AND a = '${SA}'`)[0]
  ok(row.stage === 'right-skip' && row.clip === SB && row.watched_sec === 12 && JSON.parse(row.signals).rightSkippedAt === 95, 'skip event stores clip, stage, skippedAt')
  r = await J('POST', '/events', null, { events: evs }); ok(r.s === 401, 'POST /events needs a session')
  // ---- daily clash done on any device ----
  r = await J('GET', '/me/daily/2026-10-16', t2); ok(r.s === 200 && r.j.done === false, `GET /me/daily before watching -> not done (${JSON.stringify(r.j)})`)
  r = await J('POST', '/events', t2, { events: [{ kind: 'pass', a: 'dlyAAAAAAAA', b: 'dlyBBBBBBBB', stage: 'vote', daily: '2026-10-16', createdAt: new Date().toISOString() }] })
  r = await J('GET', '/me/daily/2026-10-16', t2); ok(r.s === 200 && r.j.done === true && r.j.voted === false, `a pass at the daily's ballot = done, not voted (${JSON.stringify(r.j)})`)
  r = await J('POST', '/votes', t2, { votes: [{ a: 'dlyAAAAAAAA', b: 'dlyBBBBBBBB', winner: 'dlyAAAAAAAA', daily: '2026-10-17', createdAt: new Date().toISOString() }] })
  r = await J('GET', '/me/daily/2026-10-17', t2); ok(r.s === 200 && r.j.done === true && r.j.voted === true, 'a daily vote = done')
  r = await J('GET', '/me/daily/2026-10-17', null); ok(r.s === 401, 'GET /me/daily needs a session')
  r = await J('GET', '/me/daily/notadate', t2); ok(r.s === 400, 'GET /me/daily rejects a bad date')
  r = await J('GET', '/me/humour', t1); ok(r.s === 200 && r.j.humour === null, 'GET /me/humour -> null before the offline fit has run')
  execSync(`npx wrangler d1 execute funnier --local --command "INSERT OR REPLACE INTO humour_profiles (user_id, profile, updated_at) SELECT id, '{\\"n\\":12,\\"line\\":\\"You laugh hardest at split knowledge.\\"}', '2026-10-16' FROM users WHERE email = 'g1@example.com'"`, { stdio: 'ignore' })
  r = await J('GET', '/me/humour', t1); ok(r.s === 200 && r.j.humour?.n === 12 && /split knowledge/.test(r.j.humour.line), `GET /me/humour returns the offline profile (${JSON.stringify(r.j)})`)

  // ---- laughs: anonymous with a device id, 1 per 0.7s per user/device, 1-second histogram ----
  const LC = 'laughClip01', dev = 'devAAAA1111', dev2 = 'devBBBB2222'
  r = await J('POST', '/laughs', null, { clip: LC, t: 12.4 }); ok(r.s === 400 && r.j.error === 'device_required', 'anonymous laugh without a device id -> 400')
  r = await J('POST', '/laughs', null, { clip: 'bad clip!', t: 1, device: dev }); ok(r.s === 400, 'laugh on a bad clip id -> 400')
  r = await J('POST', '/laughs', null, { clip: LC, t: 12.4, device: dev }); ok(r.s === 200, 'anonymous laugh with a device id -> 200')
  r = await J('POST', '/laughs', null, { clip: LC, t: 12.9, device: dev }); ok(r.s === 429 && r.j.error === 'rate_limited', 'second laugh within 0.7s from the same device -> 429')
  r = await J('POST', '/laughs', null, { clip: LC, t: 12.7, device: dev2 }); ok(r.s === 200, 'another device is not rate-limited')
  r = await J('POST', '/laughs', t1, { clip: LC, t: 30, device: dev }); ok(r.s === 200, 'signed-in laugh counts per user, not per device')
  await sleep(750)
  r = await J('POST', '/laughs', null, { clip: LC, t: 3, device: dev }); ok(r.s === 200, 'after 0.7s the same device can laugh again')
  r = await J('GET', '/laughs/' + LC); ok(r.s === 200 && r.j.bins.length === 31 && r.j.bins[12] === 2 && r.j.bins[3] === 1 && r.j.bins[30] === 1 && r.j.total === 4 && r.j.max === 2, `GET /laughs/:clip -> 1-second histogram (${JSON.stringify(r.j?.bins?.filter(Boolean))})`)
  // ---- learned durations ----
  r = await J('POST', '/clips/durations', null, { durs: { durClip001: 245.2, durClip002: 61, 'bad id!': 10, durClip003: -4 } }); ok(r.s === 200 && r.j.saved === 2, 'POST /clips/durations keeps only valid ids/values')
  for (let i = 0; i < 3; i++) await J('POST', '/clips/durations', null, { clip: 'durClip002', dur: 61 })
  await J('POST', '/clips/durations', null, { clip: 'durClip002', dur: 600 })
  r = await J('GET', '/clips/durations'); ok(r.s === 200 && r.j.durs.durClip001 === 245.2 && r.j.durs.durClip002 === 61, `GET /clips/durations merges reports, ignores an outlier (${JSON.stringify(r.j?.durs)})`)
  // ---- crowd loudness: 3dB steps, normalised to the quietest clip, clamped -40..0 ----
  r = await J('POST', '/clips/audio', null, { clip: 'audLoud0001', dir: 'meh', device: dev }); ok(r.s === 400, 'bad audio dir -> 400')
  for (const d of ['dev00000001', 'dev00000002', 'dev00000003', 'dev00000004']) await J('POST', '/clips/audio', null, { clip: 'audLoud0001', dir: 'loud', device: d })
  await J('POST', '/clips/audio', null, { clip: 'audLoud0001', dir: 'loud', device: 'dev00000001' }) // same device again: still one vote
  r = await J('GET', '/clips/audio'); const al = r.j?.clips?.audLoud0001
  ok(r.s === 200 && al?.loud === 4 && al.db === 6 && al.offset === -40 && r.j.default_offset === 0, `"too loud" x4 -> +6dB -> that clip attenuated (${JSON.stringify(al)}, default ${r.j?.default_offset})`)
  for (const d of ['dev00000005', 'dev00000006', 'dev00000007']) await J('POST', '/clips/audio', null, { clip: 'audQuiet001', dir: 'quiet', device: d })
  r = await J('GET', '/clips/audio')
  ok(r.j.ref_db === -6 && r.j.clips.audQuiet001.offset === 0 && r.j.default_offset === -40 && r.j.clips.audLoud0001.offset === -40, `"too quiet" lowers everything else instead (ref ${r.j.ref_db}dB, others ${r.j.default_offset}, quiet clip ${r.j.clips.audQuiet001?.offset})`)
  // ---- profiles (v5): favourites, pins, chart snapshot, visibility, specials diary, OG image ----
  {
    let p = await J('GET', '/me/profile-data', t1)
    ok(p.s === 200 && Array.isArray(p.j.favs) && p.j.favs.length === 0 && p.j.vis_profile === 'public' && p.j.vis_diary === 'friends' && p.j.chart === null, `GET /me/profile-data defaults (public profile, friends-only diary) ${JSON.stringify(p.j)}`)
    p = await J('PUT', '/me/profile-data', t1, { favs: ['A', 'B', 'C', 'D', 'E'] }); ok(p.s === 400 && p.j.fields?.favs, 'more than 4 favourites -> 400')
    p = await J('PUT', '/me/profile-data', t1, { pins: ['bad id!'] }); ok(p.s === 400 && p.j.fields?.pins, 'bad pinned clip id -> 400')
    p = await J('PUT', '/me/profile-data', t1, { vis_profile: 'everyone' }); ok(p.s === 400, 'bad visibility -> 400')
    const chart = { n: 12, dims: { absurd: 81, deadpan: 93, observational: 25, dark: 140, story: 45, wordplay: 49, rant: 11, selfdep: 20, evil: 5 }, ops: [{ k: 'split_knowledge', label: 'dramatic irony', v: 79 }, { k: 'nope', v: 1 }],
      sty: { energy: 28, hold: 83 }, top: ['deadpan', 'absurd'], line: 'You like long holds and anti-jokes: 91% Norm-adjacent.', mml: 'doing a 40-second pause before the punchline',
      adjacent: { comic: 'Norm Macdonald', short: 'Norm', pct: 91 }, funniest: { id: 'n3LMSflEN54', title: 'The Most Convoluted Joke Ever', comic: 'Norm Macdonald' }, html: '<script>' }
    p = await J('PUT', '/me/profile-data', t1, { favs: ['Norm Macdonald', 'Louis C.K.', 'Norm Macdonald'], pins: ['n3LMSflEN54', 'clipAAAAAAA'], chart })
    { const c2 = { n: 3, model: 'funnier-engine/2.0', dims: { absurd: 60, deadpan: 70, observational: 40, dark: 50 }, band: { absurd: [40, 80], deadpan: [90, 10], evil: [1, 2] }, cl: { absurd: 'low', deadpan: 'bogus' }, conf: { absurd: 6.25 } }
      const r2 = await J('PUT', '/me/profile-data', t1, { chart: c2 })
      ok(r2.s === 200 && r2.j.chart.model === 'funnier-engine/2.0' && JSON.stringify(r2.j.chart.band) === '{"absurd":[40,80]}' && JSON.stringify(r2.j.chart.cl) === '{"absurd":"low"}' && r2.j.chart.conf.absurd === 6.3, `engine v2 chart: band/confidence sanitised (${JSON.stringify(r2.j.chart.band)} ${JSON.stringify(r2.j.chart.cl)})`)
      await J('PUT', '/me/profile-data', t1, { chart }) }
    ok(p.s === 200 && p.j.favs.length === 2 && p.j.pins.length === 2 && p.j.chart.dims.dark === 100 && !('evil' in p.j.chart.dims) && p.j.chart.ops.length === 1 && !('html' in p.j.chart), `PUT /me/profile-data: favourites deduped, chart sanitised (${JSON.stringify(p.j.chart?.dims)})`)
    p = await J('PUT', '/me/specials', t1, { log: { 'norm-nothing-special': { seen: true, stars: 4.3, note: 'The moth joke.', at: new Date(Date.now() - 60000).toISOString() }, 'BAD ID': { seen: true } } })
    ok(p.s === 200 && p.j.saved === 1 && p.j.specials['norm-nothing-special'].stars === 4.5, 'PUT /me/specials: stars rounded to halves, bad ids skipped')
    p = await J('PUT', '/me/specials', t1, { log: { 'norm-nothing-special': { seen: false, stars: 0, note: '', at: new Date(Date.now() - 3600e3).toISOString() } } })
    ok(p.j.specials['norm-nothing-special']?.stars === 4.5, 'an older diary edit does not overwrite a newer one')
    // public view: anonymous sees chart + favourites but not the friends-only diary
    p = await J('GET', '/u/deadpanduck42', null)
    ok(p.s === 200 && p.j.user.username === 'DeadpanDuck42' && p.j.chart?.dims?.deadpan === 93 && p.j.favs[0] === 'Norm Macdonald' && !p.j.specials && p.j.self === false && !('email' in p.j.user), 'GET /u/:username (case-insensitive): public chart + favourites, diary hidden from strangers, no email')
    p = await J('GET', '/u/DeadpanDuck42', t2); ok(p.s === 200 && p.j.friend === true && p.j.specials?.['norm-nothing-special']?.note === 'The moth joke.', 'a friend sees the friends-only diary')
    p = await J('GET', '/u/DeadpanDuck42', t1); ok(p.j.self === true && p.j.specials, 'the owner sees everything')
    p = await J('GET', '/u/nobody_here', null); ok(p.s === 404, 'unknown username -> 404')
    await J('PUT', '/me/profile-data', t1, { vis_profile: 'friends' })
    p = await J('GET', '/u/DeadpanDuck42', null); ok(p.s === 200 && p.j.hidden === true && !p.j.chart && p.j.user.username === 'DeadpanDuck42', 'friends-only profile: strangers get the name + mascot only')
    p = await J('GET', '/u/DeadpanDuck42', t2); ok(p.j.chart?.dims && !p.j.hidden, 'friends-only profile: a friend sees the chart')
    await J('PUT', '/me/profile-data', t1, { vis_profile: 'public' })
    // Humour Passport (funnier.humour/v1): stored cleaned, public JSON at /u/<name>/humour.json, any origin, only when public
    { const feats = { ax_deadpan: { w: 1.2, sd: 0.4, n: 6, label: 'deadpan', group: 'axis' }, ax_rant: { w: -0.5, sd: 0.5, n: 3, label: 'rants', group: 'axis' }, energy: { w: -0.4, sd: 0.5, n: 4, label: 'high energy', group: 'sty' }, 'BAD KEY': { w: 1 }, op_unmask: { w: 99, sd: 1, n: 1, group: 'op' } }
      const pass = { schema: 'funnier.humour/v1', model: 'funnier-engine/2.0', created: new Date().toISOString(), n: { votes: 12, skips: 2, favs: 1 }, features: feats, axes: { deadpan: { v: 83, lo: 70, hi: 91, conf: 'medium', n: 6 }, rant: { v: 27, lo: 10, hi: 50, conf: 'low', n: 3 } }, favs: ['Norm Macdonald'], topClips: [{ id: 'n3LMSflEN54', title: 'Moth', comic: 'Norm Macdonald' }], votes: [{ a: 'n3LMSflEN54', b: 'clipAAAAAAA', winner: 'n3LMSflEN54' }], html: '<script>' }
      let r = await J('PUT', '/me/profile-data', t1, { humour: { ...pass, schema: 'nope' } }); ok(r.s === 400 && r.j.fields?.humour, 'PUT humour: a non-passport is rejected')
      r = await J('PUT', '/me/profile-data', t1, { humour: pass })
      ok(r.s === 200 && r.j.humour?.features?.ax_deadpan?.w === 1.2 && !r.j.humour.features['BAD KEY'] && r.j.humour.features.op_unmask.w === 4 && !('html' in r.j.humour) && /^[0-9a-f]{8}$/.test(r.j.humour.hash) && r.j.humour.type.k === 'deadpan', `PUT humour: passport cleaned (type ${r.j.humour?.type?.full}, hash ${r.j.humour?.hash})`)
      let hj = await fetch(BASE + '/u/deadpanduck42/humour.json', { headers: { origin: 'https://chat.example' } }), hb = await hj.json()
      ok(hj.status === 200 && hj.headers.get('access-control-allow-origin') === '*' && hb.schema === 'funnier.humour/v1' && hb.user === 'DeadpanDuck42' && hb.votes?.length === 1, 'GET /u/<name>/humour.json: public passport, any origin (opted-in history included)')
      await J('PUT', '/me/profile-data', t1, { vis_profile: 'friends' })
      hj = await fetch(BASE + '/u/DeadpanDuck42/humour.json'); ok(hj.status === 403, 'humour.json only when the profile is public (friends-only -> 403)')
      await J('PUT', '/me/profile-data', t1, { vis_profile: 'public' })
      hj = await fetch(BASE + '/u/nobody_here/humour.json'); ok(hj.status === 404, 'humour.json: unknown user -> 404')
      // characters trained from scratch + immutable versions
      let cr = await J('PUT', '/characters/cabc12345', t1, { name: 'Gravel Gus', bio: 'A deadpan gravedigger.', avatar_seed: 'gus01', passport: pass })
      ok(cr.s === 200 && cr.j.character.visibility === 'private' && cr.j.character.passport?.hash && !cr.j.character.passport.votes, `PUT /characters/:id creates a private character (no raw votes in its passport)`)
      cr = await J('PUT', '/characters/cabc12345', t2, { name: 'Hijack' }); ok(cr.s === 403, "someone else can't edit it")
      cr = await J('PUT', '/characters/BAD', t1, { name: 'x y' }); ok(cr.s === 400, 'bad id -> 400')
      cr = await J('GET', '/c/cabc12345', null); ok(cr.s === 403, 'a private character is hidden from strangers')
      cr = await J('GET', '/c/cabc12345', t1); ok(cr.s === 200 && cr.j.own === true && cr.j.chat === false, 'the owner sees it (chat slot off)')
      const ver = { id: (cr.j.character.passport.hash) + '-' + Date.now().toString(36), name: 'The Slow-Burn Straight Face', at: new Date().toISOString(), passport: pass }
      let vr = await J('POST', '/me/versions', t1, { subject: 'cabc12345', version: ver }); ok(vr.s === 200 && vr.j.hash === cr.j.character.passport.hash, 'POST /me/versions: an immutable passport version for the character')
      vr = await J('POST', '/me/versions', t1, { subject: 'cabc12345', version: { ...ver, name: 'changed' } }); vr = await J('GET', '/me/versions?subject=cabc12345', t1)
      ok(vr.j.versions.length === 1 && vr.j.versions[0].name === 'The Slow-Burn Straight Face' && vr.j.versions[0].passport?.schema === 'funnier.humour/v1', 'versions are immutable (a re-post changes nothing)')
      vr = await J('POST', '/me/versions', t2, { subject: 'cabc12345', version: ver }); ok(vr.s === 403, "you can't version someone else's character")
      await J('PUT', '/me/versions', t1, {}); vr = await J('POST', '/me/versions', t1, { subject: 'me', version: { ...ver, id: ver.id.replace(/-.*/, '-me1234') } }); ok(vr.s === 200, 'your own model can be versioned too')
      await J('PUT', '/characters/cabc12345', t1, { visibility: 'public' })
      cr = await J('GET', '/c/cabc12345', null); ok(cr.s === 200 && cr.j.character.name === 'Gravel Gus' && cr.j.versions.length === 1 && cr.j.owner?.username === 'DeadpanDuck42', 'public character page: /c/<id> with versions and owner')
      vr = await J('GET', '/c/cabc12345/v/' + ver.id, null); ok(vr.s === 200 && vr.j.passport?.hash === cr.j.character.passport.hash, 'a public version passport is readable')
      let fk = await J('POST', '/characters/cabc12345/fork', t2, { id: 'cfork00001' })
      ok(fk.s === 200 && fk.j.character.parent_id === 'cabc12345' && fk.j.character.parent_hash === cr.j.character.passport.hash && fk.j.character.visibility === 'private', 'fork: a private copy with parent_id + the snapshot hash')
      cr = await J('GET', '/c/cabc12345', null); ok(cr.j.forks === 0, 'private forks are not counted publicly')
      const ch = await fetch(BASE + '/c/cabc12345/chat', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' }); ok(ch.status === 501, 'POST /c/:id/chat is a disabled slot (501) until a key is configured')
      p = await J('GET', '/u/DeadpanDuck42', null); ok(p.j.characters?.length === 1 && p.j.characters[0].id === 'cabc12345' && !p.j.characters[0].passport, 'public profile lists public characters')
      cr = await J('DELETE', '/characters/cabc12345', t2); ok(cr.s === 403, "can't delete someone else's character")
      cr = await J('DELETE', '/characters/cfork00001', t2); ok(cr.s === 200, 'owner deletes a character') }
    // OG image
    const png = new Uint8Array(400); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let og = await fetch(BASE + '/og/u/DeadpanDuck42.png'); ok(og.status === 404, 'no OG image yet -> 404')
    og = await fetch(BASE + '/me/og', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'image/png', authorization: 'Bearer ' + t1 }, body: png }); ok(og.status === 200, `POST /me/og stores a PNG (${og.status})`)
    og = await fetch(BASE + '/me/og', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'image/png', authorization: 'Bearer ' + t1 }, body: new Uint8Array(400) }); ok(og.status === 415, 'non-PNG bytes -> 415')
    og = await fetch(BASE + '/og/u/deadpanduck42.png'); const ob = new Uint8Array(await og.arrayBuffer())
    ok(og.status === 200 && og.headers.get('content-type') === 'image/png' && ob.length === 400 && ob[1] === 0x50, `GET /og/u/:name.png serves it (${og.status}, ${ob.length} bytes)`)
    await J('PUT', '/me/profile-data', t1, { vis_profile: 'private' })
    og = await fetch(BASE + '/og/u/DeadpanDuck42.png'); ok(og.status === 404, 'private profile -> no OG image')
    p = await J('GET', '/u/DeadpanDuck42', t2); ok(p.j.hidden === true, 'private profile hidden even from friends')
    await J('PUT', '/me/profile-data', t1, { vis_profile: 'public' })
  }
  r = await J('POST', '/auth/logout', t1); ok(r.s === 200 && /funnier_session=;/.test(r.h.get('set-cookie') || ''), 'logout clears the cookie')
} catch (e) { fails.push(String(e)); console.log('ERROR', e, log.slice(-2000)) } finally { stop() }
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
