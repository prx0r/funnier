// Browser check for profiles + share cards: the real site/ bundle in headless Chromium, a tiny fake API, and
// www.funnier.si/u/<name> emulated the way funnier-web serves it (index.html with <base href="/">).
// Renders every share card template (feed + story) and the OG card to PNG and checks their size; screenshots go to
// $OUT (default /tmp/funnier-cards). Usage (from api/): node test/profile-browser.mjs   Needs Chromium + puppeteer-core.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), SITE = path.resolve(API_DIR, '../site')
let puppeteer = null
for (const d of [process.env.PUPPETEER_DIR, API_DIR, '/tmp/smoke'].filter(Boolean)) { try { puppeteer = createRequire(path.join(d, '/'))('puppeteer-core'); break } catch {} }
const CHROME = process.env.CHROME || '/usr/bin/chromium'
if (!puppeteer || !fs.existsSync(CHROME)) { console.log('SKIP: needs puppeteer-core and Chromium'); process.exit(0) }
const OUT = process.env.OUT || '/tmp/funnier-cards'; fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const STUB = `window.YT = { Player: class { constructor(id, o) { this.o = o; this.t = 0; this.s = -1; setTimeout(() => o.events?.onReady?.({}), 20) }
  playVideo() { this.s = 1 } pauseVideo() { this.s = 2 } getPlayerState() { return this.s } mute() {} unMute() {} isMuted() { return false } setVolume() {} getCurrentTime() { return this.t } getDuration() { return 60 } seekTo() {} destroy() {} } }
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10)`
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
const FRIEND = { user: { username: 'PunchyPanda7', avatar_seed: 'k3j9x0q2ab' }, self: false, friend: true, vis_profile: 'public', vis_diary: 'friends', favs: ['Chris Rock', 'Norm Macdonald'], pins: [], sets: [],
  chart: { v: 1, n: 9, dims: { absurd: 40, deadpan: 35, observational: 62, dark: 70, story: 50, wordplay: 55, rant: 80, selfdep: 45 }, line: 'You like righteous rants and dark turns: 77% Chris Rock-adjacent.', ops: [], sty: {}, top: ['rant', 'dark'] } }
const og = []
const J = (s, o, st = 200) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)) }
const site = http.createServer(async (q, s) => {
  const u = new URL(q.url, 'http://x'); let p = decodeURIComponent(u.pathname)
  if (p.startsWith('/api/')) {
    const a = p.slice(4), body = await new Promise((r) => { const b = []; q.on('data', (c) => b.push(c)); q.on('end', () => r(Buffer.concat(b))) })
    if (a === '/me') return J(s, { user: { id: 'u1', username: 'DeadpanDuck42', avatar_seed: 'hmbm7a3jvv', email: 'x@y' }, needsProfile: false })
    if (a === '/me/profile-data' && q.method === 'GET') return J(s, { favs: [], pins: [], chart: null, vis_profile: 'public', vis_diary: 'friends', updated_at: null, specials: {}, sets: [] })
    if (a === '/me/profile-data') { const b = JSON.parse(body.toString() || '{}'); return J(s, { ok: true, ...b, vis_profile: 'public', vis_diary: 'friends', updated_at: new Date().toISOString() }) }
    if (a === '/me/og') { og.push(body); return J(s, { ok: true }) }
    if (a === '/me/taste') return J(s, { friends: [{ username: 'PunchyPanda7', avatar_seed: 'k3j9x0q2ab', shared: 4, agree: 3, match: 75 }] })
    if (a === '/u/PunchyPanda7') return J(s, FRIEND)
    if (a === '/me/invites') return J(s, { invites: [], totals: { sent: 0, opened: 0, voted: 0 } })
    return J(s, { ok: true })
  }
  if (p === '/config.json') return J(s, { apiBase: 'http://127.0.0.1:8082/api', googleClientId: '', shareBase: 'https://www.funnier.si/' })
  if (/^\/u\/[A-Za-z0-9_]{3,20}\/?$/.test(p)) { // funnier-web: the app shell at /u/<name>
    s.writeHead(200, { 'content-type': 'text/html' }); return s.end(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').replace('<head>', '<head><base href="/">'))
  }
  if (p.endsWith('/')) p += 'index.html'
  const f = path.join(SITE, p); if (!f.startsWith(SITE) || !fs.existsSync(f)) { s.writeHead(404); return s.end('') }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s)
})
await new Promise((r) => site.listen(8082, '127.0.0.1', r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--no-proxy-server'] })
const clips = JSON.parse(fs.readFileSync(path.join(SITE, 'clips.json'), 'utf8')).filter((c) => c.status !== 'removed' && c.kind === 'human')
const norm = clips.filter((c) => c.comic === 'Norm Macdonald'), oth = clips.filter((c) => c.comic !== 'Norm Macdonald')
const votes = norm.slice(0, 5).map((c, i) => ({ a: c.id, b: oth[i * 7 % oth.length].id, winner: c.id, createdAt: new Date(Date.now() - 1e6 + i * 1000).toISOString(), decisionMs: 1100 }))
  .concat(oth.slice(20, 26).map((c, i) => ({ a: c.id, b: oth[(i * 11 + 40) % oth.length].id, winner: i % 2 ? c.id : oth[(i * 11 + 40) % oth.length].id, createdAt: new Date(Date.now() - 5e5 + i * 1000).toISOString() })))
  .filter((v) => v.a !== v.b && clips.find((c) => c.id === v.a).comic !== clips.find((c) => c.id === v.b).comic)

async function open(device, url) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage()
  if (device === 'phone') await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  else await page.setViewport({ width: 1340, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('youtube.com/iframe_api')) return r.respond({ status: 200, contentType: 'text/javascript', body: STUB })
    if (u.startsWith('http://127.0.0.1:8082/')) return r.continue()
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) { // real fonts (fetched with curl so a sandbox proxy works); none offline
      try { const body = execFileSync('curl', ['-sfL', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', u], { timeout: 15000 }); return r.respond({ status: 200, contentType: /css/.test(u) ? 'text/css' : 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body }) } catch { return r.respond({ status: 204, body: '' }) }
    }
    r.respond({ status: 204, body: '' })
  })
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)))
  await page.evaluateOnNewDocument((votes) => {
    localStorage.setItem('funnier.onboardSeen', 'true'); localStorage.setItem('funnier.gestHinted', 'true'); localStorage.setItem('funnier.session', '"tok"')
    localStorage.setItem('funnier.favs', JSON.stringify(['Norm Macdonald', 'Mark Normand', 'Louis C.K.', 'Jerry Seinfeld']))
    localStorage.setItem('funnier.votes', JSON.stringify(votes))
    localStorage.setItem('funnier.specials', JSON.stringify({ 'norm-nothing-special': { seen: true, stars: 4.5, note: 'The moth joke.', at: '2026-10-15T10:00:00.000Z' } }))
  }, votes)
  await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {})
  await sleep(1500)
  return { page, errs }
}
try {
  // 1) the shareable path
  { const { page, errs } = await open('desktop', 'http://127.0.0.1:8082/u/PunchyPanda7')
    const st = await page.evaluate(() => ({ h: location.hash, p: location.pathname, name: document.querySelector('.up-hero h1')?.textContent, css: getComputedStyle(document.body).backgroundColor }))
    ok(st.h === '#u/PunchyPanda7' && st.p === '/' && /PunchyPanda7/.test(st.name || '') && st.css === 'rgb(7, 7, 10)', `/u/<name> loads the app (styles via <base>) and opens the profile (${JSON.stringify(st)})`)
    await page.screenshot({ path: OUT + '/public-desktop.png', fullPage: true })
    ok(errs.length === 0, 'no page errors on /u/<name>' + (errs.length ? ': ' + errs.join(' | ') : '')) }
  // 2) own profile, desktop + phone; OG upload
  for (const dev of ['desktop', 'phone']) {
    const { page, errs } = await open(dev, 'http://127.0.0.1:8082/#profile')
    await sleep(1500)
    const st = await page.evaluate(() => ({ svg: !!document.querySelector('.up-radar svg polygon.hcs'), line: document.querySelector('.up-line')?.textContent, w: document.documentElement.scrollWidth, vw: innerWidth }))
    ok(st.svg && /adjacent/.test(st.line || ''), `${dev}: own profile renders the chart (${st.line})`)
    const gl = await page.evaluate(() => ({ g: !!document.querySelector('.up-hero .up-glyph svg.sigil'), name: document.querySelector('.up-hero .sg-name')?.textContent, meta: !!document.querySelector('.up-model svg.metasvg'), gw: document.querySelector('.up-hero .up-glyph')?.getBoundingClientRect().width }))
    ok(gl.g && /^The /.test(gl.name || '') && gl.meta && gl.gw > 150, `${dev}: hero glyph + computed type name (${gl.name}, ${Math.round(gl.gw)}px) + meta-axes`)
    ok(st.w <= st.vw + 1, `${dev}: no horizontal overflow (${st.w} vs ${st.vw})`)
    await page.screenshot({ path: `${OUT}/me-${dev}.png`, fullPage: true })
    if (dev === 'desktop') {
      await sleep(1500)
      ok(og.length >= 1 && og[0][0] === 0x89 && og[0].readUInt32BE(16) === 1200 && og[0].readUInt32BE(20) === 630 && og[0].length < 1024 * 1024, `OG card uploaded as a 1200x630 PNG (${og.length}, ${og[0]?.length} bytes)`)
      if (og[0]) fs.writeFileSync(OUT + '/og.png', og[0])
      // every template, feed + story
      await page.evaluate(() => document.querySelector('.up-hero [data-act="share"]').click()); await sleep(800)
      for (const k of ['type', 'chart', 'mml', 'funny', 'four']) for (const sz of ['feed', 'story']) {
        await page.evaluate((k, sz) => { document.querySelector(`#sheet [data-tpl="${k}"]`).click(); document.querySelector(`#sheet [data-size="${sz}"]`).click() }, k, sz)
        await sleep(900)
        const r = await page.evaluate(() => { const c = document.querySelector('#sheet .ss-cv'); return { w: c.width, h: c.height, url: c.toDataURL('image/png') } })
        const buf = Buffer.from(r.url.split(',')[1], 'base64'); fs.writeFileSync(`${OUT}/card-${k}-${sz}.png`, buf)
        ok(r.w === 1080 && r.h === (sz === 'feed' ? 1350 : 1920) && buf.length > 40000, `${k} ${sz}: ${r.w}x${r.h} PNG, ${Math.round(buf.length / 1024)} KB, exportable (no tainted canvas)`)
      }
      await page.screenshot({ path: OUT + '/studio.png' })
      await page.evaluate(() => document.querySelector('#sheet [data-ob="close"]').click())
      // overlay + Me vs friend card
      await page.evaluate(() => { location.hash = 'vs/PunchyPanda7' }); await sleep(1200)
      const vs = await page.evaluate(() => ({ n: document.querySelectorAll('.vs-chart polygon.hcs').length, pct: document.querySelector('.vs-pct')?.textContent }))
      ok(vs.n === 2 && /%/.test(vs.pct || ''), `overlay page: 2 charts, match ${vs.pct}`)
      await page.screenshot({ path: OUT + '/vs-desktop.png', fullPage: true })
      await page.evaluate(() => document.querySelector('[data-vsshare="0"]').click()); await sleep(1200)
      const r = await page.evaluate(() => { const c = document.querySelector('#sheet .ss-cv'); return { w: c.width, h: c.height, url: c.toDataURL('image/png') } })
      const buf = Buffer.from(r.url.split(',')[1], 'base64'); fs.writeFileSync(`${OUT}/card-vs-feed.png`, buf)
      ok(r.w === 1080 && r.h === 1350 && buf.length > 40000, `vs feed: ${r.w}x${r.h}, ${Math.round(buf.length / 1024)} KB`)
    }
    ok(errs.length === 0, `${dev}: no page errors` + (errs.length ? ': ' + errs.join(' | ') : ''))
  }
} catch (e) { fails.push(String(e)); console.log('ERROR', e) } finally { await browser.close(); site.close() }
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
