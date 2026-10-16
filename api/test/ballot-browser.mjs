// Browser check for the screening: the real site/ bundle in headless Chromium with a stub YouTube IFrame API
// (no network). Plays a clash to the ballot and taps a FUNNIER button the way a phone (touch) and a laptop (mouse) do.
// Usage (from api/): node test/ballot-browser.mjs     Needs Chromium + puppeteer-core (as test/onboard-browser.mjs).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), SITE = path.resolve(API_DIR, '../site')
let puppeteer = null
for (const d of [process.env.PUPPETEER_DIR, API_DIR, '/tmp/smoke'].filter(Boolean)) { try { puppeteer = createRequire(path.join(d, '/'))('puppeteer-core'); break } catch {} }
const CHROME = process.env.CHROME || '/usr/bin/chromium'
if (!puppeteer || !fs.existsSync(CHROME)) { console.log('SKIP: needs puppeteer-core and Chromium'); process.exit(0) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }

// a YT.Player stand-in: a div that "plays" by advancing time; durations 60s; states like the real API
const STUB = `window.YT = { Player: class { constructor(id, o) { this.o = o; this.t = o.playerVars?.start || 0; this.s = -1; this.m = false; this.vid = o.videoId; window.__P = (window.__P || []).concat(this)
  const el = document.getElementById(id); const f = document.createElement('div'); f.style.cssText = 'position:absolute;inset:0;background:#123'; f.id = id; el.replaceWith(f)
  setInterval(() => { if (this.s === 1) this.t += 0.25 * (window.__SPEED || 1); if (this.t >= 60 && this.s === 1) { this.s = 0; o.events?.onStateChange?.({ data: 0 }) } }, 250)
  setTimeout(() => o.events?.onReady?.({}), 20) }
  playVideo() { if (window.__BLOCK_SOUND && !this.m) { this.s = 2; return } this.s = 1 } pauseVideo() { this.s = 2 } getPlayerState() { return this.s } mute() { this.m = true } unMute() { this.m = false } isMuted() { return this.m }
  setVolume() {} getCurrentTime() { return this.t } getDuration() { return 60 } seekTo(t) { this.t = t } destroy() {} loadVideoById(x) { this.vid = typeof x === 'string' ? x : x.videoId; this.t = (x && x.startSeconds) || 0; this.s = 1 } } }
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10)`
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }
const site = http.createServer((q, s) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'
  if (p === '/config.json') { s.writeHead(200, { 'content-type': 'application/json' }); return s.end('{}') }
  const f = path.join(SITE, p); if (!f.startsWith(SITE) || !fs.existsSync(f)) { s.writeHead(404); return s.end('') }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s)
})
await new Promise((r) => site.listen(8081, '127.0.0.1', r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })

async function open(device, init = {}) {
  const ctx = await browser.createBrowserContext() // fresh storage per run
  const page = await ctx.newPage()
  if (device === 'phone') await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  else await page.setViewport({ width: 1340, height: 760 })
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('youtube.com/iframe_api')) return r.respond({ status: 200, contentType: 'text/javascript', body: STUB })
    if (u.startsWith('http://127.0.0.1:8081/')) return r.continue()
    r.respond({ status: 204, body: '' }) // thumbnails, fonts, api: nothing leaves the machine
  })
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)))
  await page.evaluateOnNewDocument((init) => { localStorage.setItem('funnier.onboardSeen', 'true'); localStorage.setItem('funnier.gestHinted', 'true'); for (const [k, v] of Object.entries(init.ls || {})) localStorage.setItem(k, v); if (init.block) window.__BLOCK_SOUND = true }, init)
  await page.goto('http://127.0.0.1:8081/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.slide')?.dataset.stage === 'left', { timeout: 8000 })
  return { page, errs }
}
const toBallot = async (page) => {
  await page.evaluate(() => { window.__SPEED = 400 })
  await page.waitForFunction(() => document.querySelector('.slide:last-child')?.dataset.stage === 'vote', { timeout: 15000 })
  await page.evaluate(() => { window.__SPEED = 1 })
  await sleep(450) // the ballot fades in
}
const center = (page, sel) => page.evaluate((s) => { const r = [...document.querySelectorAll(s)].pop().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }, sel)
const voted = (page) => page.evaluate(() => ({ won: !!document.querySelector('.slide:last-child .pick.won'), n: JSON.parse(localStorage.getItem('funnier.votes') || '[]').length + JSON.parse(localStorage.getItem('funnier.partials') || '[]').length }))

for (const device of ['phone', 'laptop']) {
  const { page, errs } = await open(device)
  await toBallot(page)
  const c = await center(page, '.slide:last-child .pick.L')
  const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('.pick') ? 'pick' : e.className || e.tagName) : null }, c)
  ok(top === 'pick', `${device}: nothing sits over the FUNNIER button (top element: ${top})`)
  if (device === 'phone') { // a real finger: down, a few px of drift, up
    const cdp = await page.target().createCDPSession()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] }); await sleep(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 3, y: c.y - 8 }] }); await sleep(40)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 4, y: c.y - 14 }] }); await sleep(40)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 5, y: c.y - 22 }] }); await sleep(40) // a sloppy thumb: 22px of drift
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else await page.mouse.click(c.x, c.y)
  await sleep(250)
  const v = await voted(page)
  ok(v.won && v.n === 1, `${device}: tapping FUNNIER registers the pick (won=${v.won}, picks=${v.n})`)
  ok(errs.length === 0, `${device}: no page errors ${errs.slice(0, 2).join(' | ')}`)
  await page.close()
}
// sound: always try WITH sound; refused -> muted silently (never a prompt); the first interaction anywhere unmutes
for (const block of [false, true]) {
  const { page } = await open('laptop', { block })
  await sleep(block ? 1400 : 900)
  const st = await page.evaluate(() => { const p = (window.__P || []).find((x) => x.s === 1); return { muted: p ? p.m : null, playing: !!p, prompt: !!document.getElementById('soundpill') || /tap for sound/i.test(document.body.innerText) } })
  if (!block) ok(st.playing && st.muted === false && !st.prompt, `autoplay with sound when allowed, no prompt (${JSON.stringify(st)})`)
  else {
    ok(st.playing && st.muted === true && !st.prompt, `sound refused: plays muted, silently (${JSON.stringify(st)})`)
    await page.mouse.wheel({ deltaY: 30 }); await sleep(150) // any interaction, even a scroll-wheel nudge
    const after = await page.evaluate(() => { const p = (window.__P || []).find((x) => x.s === 1); return { muted: p ? p.m : null, pref: localStorage.getItem('funnier.sound') } })
    ok(after.muted === false && after.pref === '"on"', `first interaction (wheel) unmutes + stores funnier.sound=on (${JSON.stringify(after)})`)
  }
  await page.close()
}
// device-aware: a phone gets the 75s cap, a laptop 150s; a vertical clip renders in a 9:16 screen
{
  const { page } = await open('phone')
  const r = await page.evaluate(() => { const s = document.querySelector('.slide:last-child .screen.big'); const b = s.getBoundingClientRect(); return { w: b.width, h: innerHeight } })
  ok(r.w <= 390, `phone: the screen fits the width (${Math.round(r.w)}px)`)
  await page.evaluate(() => { const s = document.querySelector('.slide:last-child .screen.L'); s.classList.add('vert') })
  await sleep(700)
  const v = await page.evaluate(() => { const f = document.querySelector('.slide:last-child .screen.L .frame').getBoundingClientRect(); return { w: f.width, h: f.height } })
  ok(Math.abs(v.w / v.h - 9 / 16) < 0.02, `vertical clip: 9:16 player (${Math.round(v.w)}x${Math.round(v.h)})`)
  await page.close()
}
await browser.close(); site.close()
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
