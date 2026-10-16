// Browser e2e for sign-up: real site/ bundle in headless Chromium -> Google sign-in (GIS mocked, ID token signed by a
// local JWKS mock) -> onboarding sheet -> Save, against `wrangler dev --local` (local D1). Checks what the person sees.
// Usage (from api/): node test/onboard-browser.mjs            all scenarios, laptop-sized window (1340x620)
//                    node test/onboard-browser.mjs --prod     load the LIVE www.funnier.si bundle instead of ../site,
//                                                            with api.funnier.si routed to the local worker
// Needs Chromium (CHROME=/usr/bin/chromium) and puppeteer-core (resolved from PUPPETEER_DIR, ./node_modules or /tmp/smoke).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), SITE = path.resolve(API_DIR, '../site')
let puppeteer = null
for (const d of [process.env.PUPPETEER_DIR, API_DIR, '/tmp/smoke'].filter(Boolean)) { try { puppeteer = createRequire(path.join(d, '/'))('puppeteer-core'); break } catch {} }
const CHROME = process.env.CHROME || '/usr/bin/chromium'
if (!puppeteer || !fs.existsSync(CHROME)) { console.log('SKIP: needs puppeteer-core and Chromium (set PUPPETEER_DIR / CHROME)'); process.exit(0) }
const PROD = process.argv.includes('--prod')
const PAGE = PROD ? 'https://www.funnier.si/' : 'http://127.0.0.1:8080/'
const VW = Number(process.env.VW || 1340), VH = Number(process.env.VH || 620)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test1', alg: 'RS256', use: 'sig' }
const jwksSrv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ keys: [jwk] })) })
await new Promise((r) => jwksSrv.listen(8798, '127.0.0.1', r))
const CID = 'test-client.apps.googleusercontent.com'
const idToken = (sub) => new SignJWT({ email: sub + '@example.com', email_verified: true, name: 'Test ' + sub, picture: 'https://lh3.googleusercontent.com/a/x' })
  .setProtectedHeader({ alg: 'RS256', kid: 'test1' }).setIssuer('https://accounts.google.com').setAudience(CID).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)

const sh = (c) => execSync(c, { cwd: API_DIR, stdio: 'ignore' })
sh('npx wrangler d1 execute funnier --local --file schema.sql')
try { sh('npx wrangler d1 execute funnier --local --file migrations/0002_avatar_seed.sql') } catch {}
sh('npx wrangler d1 execute funnier --local --file migrations/0003_laughs_durations_audio.sql')
sh('npx wrangler d1 execute funnier --local --command "DELETE FROM users;"')
const PORT = 8797, API = `http://127.0.0.1:${PORT}`
const dev = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--var', `GOOGLE_CLIENT_ID:${CID}`, '--var', 'ALLOW_TEST_JWKS:1',
  '--var', 'TEST_JWKS_URL:http://127.0.0.1:8798/jwks', '--var', 'SESSION_SECRET:local-test-secret-not-for-prod'], { cwd: API_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let wlog = ''; dev.stdout.on('data', (d) => (wlog += d)); dev.stderr.on('data', (d) => (wlog += d))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
const site = http.createServer((q, s) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'
  if (p === '/config.json') { s.writeHead(200, { 'content-type': 'application/json' }); return s.end(JSON.stringify({ apiBase: API, googleClientId: CID, shareBase: 'http://127.0.0.1:8080/' })) }
  const f = path.join(SITE, p); if (!f.startsWith(SITE) || !fs.existsSync(f)) { s.writeHead(404); return s.end('') }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s)
})
await new Promise((r) => site.listen(8080, '127.0.0.1', r))
const stop = () => { try { process.kill(-dev.pid) } catch {} jwksSrv.close(); site.close() }

const relay = async (r, url) => { // answer an intercepted request from node (live site via the env proxy, or the local worker)
  const h = { ...r.headers() }; delete h.host
  const x = await fetch(url, { method: r.method(), headers: h, body: r.postData() })
  const hh = {}; x.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/.test(k)) hh[k] = v })
  r.respond({ status: x.status, headers: hh, body: Buffer.from(await x.arrayBuffer()) })
}
let browser
try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(API + '/'); if (r.ok) break } catch {} await sleep(500) }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const seen = (page) => page.evaluate(() => {
    const sh = document.querySelector('#sheet'), f = sh?.querySelector('[data-err=form]'), r = f?.getBoundingClientRect()
    const inView = (el) => { const b = el?.getBoundingClientRect(); return !!b && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight }
    return { open: !!sh && !sh.hidden, form: f?.textContent || '', formVisible: inView(f), focus: document.activeElement?.id || '', nameErrVisible: inView(sh?.querySelector('[data-err=username]')) && inView(sh?.querySelector('#obuser')),
      fieldErrs: Object.fromEntries([...(sh?.querySelectorAll('.oberr[data-err]') || [])].filter((e) => e.dataset.err !== 'form' && e.textContent).map((e) => [e.dataset.err, e.textContent])),
      toast: document.querySelector('#toast')?.textContent || '' }
  })
  // scroll the sheet like a person (mouse wheel) and click Save where it is on screen
  const clickSave = async (page) => {
    await page.mouse.move(VW / 2, VH / 2)
    for (let i = 0; i < 8; i++) { await page.mouse.wheel({ deltaY: 120 }); await sleep(80) }
    await sleep(400)
    const b = await page.evaluate(() => { const r = document.querySelector('#obform button[type=submit]')?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    if (!b || b.y > VH || b.y < 0) throw new Error('Save button not reachable by scrolling: ' + JSON.stringify(b))
    await page.mouse.click(b.x, b.y); await sleep(1500)
  }
  const me = async (page) => { const t = JSON.parse(await page.evaluate(() => localStorage.getItem('funnier.session') || 'null')); if (!t) return null; return (await (await fetch(API + '/me', { headers: { authorization: 'Bearer ' + t } })).json()) }
  const start = async (sub) => {
    const cred = await idToken(sub), ctx = await browser.createBrowserContext(), page = await ctx.newPage()
    await page.setViewport({ width: VW, height: VH })
    const errors = []; page.on('pageerror', (e) => errors.push(e.message))
    await page.setRequestInterception(true)
    page.on('request', (r) => {
      const u = r.url()
      if (u.startsWith('https://accounts.google.com/gsi/client')) return r.respond({ status: 200, contentType: 'text/javascript', body: `window.google={accounts:{id:{initialize(o){window.__gis=o},renderButton(h){const b=document.createElement('button');b.id='fakegsi';b.type='button';b.textContent='Sign in with Google (test)';b.onclick=()=>window.__gis.callback({credential:${JSON.stringify(cred)}});h.appendChild(b)},disableAutoSelect(){},prompt(){}}}}` })
      if (PROD && u.startsWith('https://www.funnier.si/config.json')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiBase: 'https://api.funnier.si', googleClientId: CID, shareBase: 'https://www.funnier.si/' }) })
      if (PROD && u.startsWith('https://www.funnier.si/')) return relay(r, u).catch(() => r.abort())
      if (PROD && u.startsWith('https://api.funnier.si/')) return relay(r, API + u.slice('https://api.funnier.si'.length)).catch(() => r.abort())
      if (u.startsWith('http://127.0.0.1')) return r.continue()
      return r.respond({ status: 204, body: '' }) // YouTube, fonts, thumbnails: offline
    })
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#userbtn', { timeout: 20000 }); await sleep(1500)
    await page.click('#userbtn'); await page.waitForSelector('#fakegsi', { timeout: 10000 }); await page.click('#fakegsi')
    await page.waitForSelector('#sheet:not([hidden]) #obform', { timeout: 10000 })
    return { page, ctx, errors }
  }

  { // 1. defaults: just press Save
    const { page, ctx, errors } = await start('def')
    await sleep(3000) // the screening keeps running behind the sheet
    await clickSave(page)
    const s = await seen(page), m = await me(page)
    ok(!s.open && /Welcome/.test(s.toast) && m?.user?.username && m.user.avatar_seed && m.needsProfile === false, `defaults: Save closes the sheet, welcomes, and the profile is stored (${m?.user?.username}, ${m?.user?.avatar_seed}, ${m?.user?.country})`)
    ok(!errors.length, 'defaults: no page errors ' + errors.join(' | '))
    await ctx.close()
  }
  { // 2. optional fields filled
    const { page, ctx } = await start('full')
    await page.type('#obyear', '1994'); await page.select('#obcc', 'GB'); await page.click('input[name=obsex][value=female]')
    await clickSave(page)
    const s = await seen(page), m = await me(page)
    ok(!s.open && m?.user?.birth_year === 1994 && m.user.country === 'GB' && m.user.sex_at_birth === 'female', 'full: year/country/sex saved')
    await ctx.close()
  }
  { // 3. a natural name with a space: the reason is shown next to Save and the field comes into view, then a fixed name saves
    const { page, ctx } = await start('bad')
    await page.click('#obuser', { clickCount: 3 }); await page.type('#obuser', 'Prior Trades')
    await clickSave(page)
    let s = await seen(page)
    ok(s.open && /Username/.test(s.form) && s.fieldErrs.username && s.focus === 'obuser' && s.nameErrVisible, `bad name: the field + its reason scroll into view and get focus; the reason is also by Save (${JSON.stringify(s)})`)
    await page.evaluate(() => { document.querySelector('#obuser').value = '' }); await page.type('#obuser', 'Prior_Trades')
    await clickSave(page)
    s = await seen(page); const m = await me(page)
    ok(!s.open && m?.user?.username === 'Prior_Trades', `bad name: fixed name saves (${JSON.stringify(s)})`)
    await ctx.close()
  }
  { // 4. year typo is caught before sending
    const { page, ctx } = await start('yr')
    await page.type('#obyear', '199')
    await clickSave(page)
    const s = await seen(page)
    ok(s.open && s.fieldErrs.birth_year && /Year of birth/.test(s.form) && s.formVisible, 'year typo: message by Save + field error')
    await ctx.close()
  }
  { // 5. session no longer valid when saving: explained, with a way to sign in again
    const { page, ctx } = await start('exp')
    await page.evaluate(() => localStorage.setItem('funnier.session', JSON.stringify('expired.token.x')))
    await clickSave(page)
    const s = await seen(page)
    ok(s.open && /sign-in has expired/i.test(s.form) && s.formVisible && await page.$('.obsignin'), `expired session: says so + Sign in again button (${s.form})`)
    await ctx.close()
  }
  { // 6. API unreachable: says so
    const { page, ctx } = await start('net')
    await page.evaluate(() => { const f = window.fetch; window.fetch = (u, o) => (String(u).includes('/me/profile') ? Promise.reject(new TypeError('Failed to fetch')) : f(u, o)) })
    await clickSave(page)
    const s = await seen(page)
    ok(s.open && /reach Funnier/.test(s.form) && s.formVisible, `network failure: says so (${s.form})`)
    await ctx.close()
  }
} catch (e) { console.log('ERROR', e.stack); fails.push('exception') }
finally { try { await browser?.close() } catch {} stop() }
if (fails.length) console.log('--- wrangler log tail ---\n' + wlog.slice(-2000))
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0)
