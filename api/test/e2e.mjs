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
execSync(`npx wrangler d1 execute funnier --local --command "DELETE FROM votes; DELETE FROM friends; DELETE FROM invites; DELETE FROM invite_opens; DELETE FROM users; DELETE FROM laughs; DELETE FROM clip_durations; DELETE FROM clip_audio;"`, { stdio: 'ignore' })
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
  r = await J('POST', '/auth/logout', t1); ok(r.s === 200 && /funnier_session=;/.test(r.h.get('set-cookie') || ''), 'logout clears the cookie')
} catch (e) { fails.push(String(e)); console.log('ERROR', e, log.slice(-2000)) } finally { stop() }
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
