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
  ok(/authorization/i.test(pf.headers.get('access-control-allow-headers') || ''), 'preflight allows the authorization header')
  const bad = await fetch(BASE + '/me', { headers: { origin: 'https://evil.example' } })
  ok(!bad.headers.get('access-control-allow-origin'), 'unknown origin gets no CORS header')
  const st = await fetch(BASE + '/stats/clash/aaaaaaaaaaa/bbbbbbbbbbb')
  ok(st.status === 200, 'GET /stats/clash public -> 200')
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
execSync(`npx wrangler d1 execute funnier --local --command "DELETE FROM votes; DELETE FROM friends; DELETE FROM invites; DELETE FROM invite_opens; DELETE FROM users;"`, { stdio: 'ignore' })
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

  r = await J('POST', '/auth/google', null, { credential: await idToken('g2') }); const t2 = r.j.token
  r = await J('PUT', '/me/profile', t2, { username: 'deadpanduck42' }); ok(r.s === 409, 'username unique (case-insensitive) -> 409')
  r = await J('PUT', '/me/profile', t2, { username: 'PunchyPanda7', avatar_id: 'grin', birth_year: 1985, country: 'US', sex_at_birth: 'female' }); ok(r.s === 200, 'second profile saved')

  const A = 'clipAAAAAAA', B = 'clipBBBBBBB'
  r = await J('POST', '/invites', t1, { a: A, b: B, pick: 'a' }); const code = r.j?.code
  ok(r.s === 200 && /^[A-Za-z0-9]{8}$/.test(code || '') && r.j.urls.includes('https://funnier.si/#i/' + code), 'POST /invites -> code + funnier.si / github.io URLs')
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
  r = await J('POST', '/auth/logout', t1); ok(r.s === 200 && /funnier_session=;/.test(r.h.get('set-cookie') || ''), 'logout clears the cookie')
} catch (e) { fails.push(String(e)); console.log('ERROR', e, log.slice(-2000)) } finally { stop() }
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
