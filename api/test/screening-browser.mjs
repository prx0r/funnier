// Browser regression for the four screening fixes (2026-10-16), real site/ bundle in headless Chromium with a stub
// YouTube API whose videos have their clips.json lengths: (1) every clip plays to its very end (no equal-length or cap
// truncation; a long uncut set plays its closing window), (2) the ballot is a 10 s window (ring, auto-pass, Pass button), (3) a desktop never gets a vertical
// clip in any mode (sampled rounds, #clash links), (4) the Daily Clash pill hides once today's pair has been watched
// to its ballot, however it was reached, immediately and after a reload.
// Usage (from api/): node test/screening-browser.mjs   Needs Chromium + puppeteer-core (as test/ballot-browser.mjs).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module'
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), SITE = path.resolve(API_DIR, '../site')
let puppeteer = null
for (const d of [process.env.PUPPETEER_DIR, API_DIR, '/tmp/smoke'].filter(Boolean)) { try { puppeteer = createRequire(path.join(d, '/'))('puppeteer-core'); break } catch {} }
const CHROME = process.env.CHROME || '/usr/bin/chromium'
if (!puppeteer || !fs.existsSync(CHROME)) { console.log('SKIP: needs puppeteer-core and Chromium'); process.exit(0) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const CLIPS = JSON.parse(fs.readFileSync(path.join(SITE, 'clips.json'), 'utf8')), BY = Object.fromEntries(CLIPS.map((c) => [c.id, c]))
const DUR = Object.fromEntries(CLIPS.map((c) => [c.id, c.dur || c.sec || 95]))
const STUB = (durs) => `window.__DUR=${JSON.stringify(durs)};window.YT = { Player: class { constructor(id, o) { this.o = o; this.t = o.playerVars?.start || 0; this.s = -1; this.m = false; this.vid = o.videoId; this.d = window.__DUR[o.videoId] || 95; window.__P = (window.__P || []).concat(this)
  const el = document.getElementById(id); const f = document.createElement('div'); f.style.cssText = 'position:absolute;inset:0;background:#123'; f.id = id; el.replaceWith(f)
  setInterval(() => { if (this.s === 1) this.t = Math.min(this.d, this.t + 0.25 * (window.__SPEED || 1)); if (this.t >= this.d && this.s === 1) { this.s = 0; o.events?.onStateChange?.({ data: 0 }) } }, 250)
  setTimeout(() => o.events?.onReady?.({}), 20) }
  playVideo() { this.s = this.t >= this.d ? 0 : 1 } pauseVideo() { if (this.s === 1) this.s = 2 } getPlayerState() { return this.s } mute() { this.m = true } unMute() { this.m = false } isMuted() { return this.m }
  setVolume() {} getCurrentTime() { return this.t } getDuration() { return this.d } seekTo(t) { this.t = t } destroy() {} } }
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10)`
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }
const site = http.createServer((q, s) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'
  if (p === '/config.json') { s.writeHead(200, { 'content-type': 'application/json' }); return s.end('{}') }
  const f = path.join(SITE, p); if (!f.startsWith(SITE) || !fs.existsSync(f)) { s.writeHead(404); return s.end('') }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s)
})
await new Promise((r) => site.listen(8082, '127.0.0.1', r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
async function open(device, { hash = '', durs = DUR } = {}) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage()
  if (device === 'phone') await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  else await page.setViewport({ width: 1440, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', (r) => { const u = r.url(); if (u.includes('youtube.com/iframe_api')) return r.respond({ status: 200, contentType: 'text/javascript', body: STUB(durs) }); if (u.startsWith('http://127.0.0.1:8082/')) return r.continue(); r.respond({ status: 204, body: '' }) })
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)))
  await page.evaluateOnNewDocument(() => { if (sessionStorage.getItem('__i')) return; sessionStorage.setItem('__i', '1'); localStorage.setItem('funnier.onboardSeen', 'true'); localStorage.setItem('funnier.gestHinted', 'true') })
  await page.goto('http://127.0.0.1:8082/' + hash, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.slide:last-child')?.dataset.stage === 'left', { timeout: 10000 })
  return { page, errs, ctx }
}
const stageOf = (page) => page.evaluate(() => document.querySelector('.slide:last-child')?.dataset.stage)
const pill = (page) => page.evaluate(() => !document.querySelector('#daily').hidden)
const toBallot = async (page) => { await page.evaluate(() => { window.__SPEED = 400 }); await page.waitForFunction(() => document.querySelector('.slide:last-child')?.dataset.stage === 'vote', { timeout: 20000 }); await page.evaluate(() => { window.__SPEED = 1 }); await sleep(400) }
// how far each side really played before the screening moved on
async function playThrough(page) {
  const seen = [[1e9, 0], [1e9, 0]]
  await page.evaluate(() => { window.__SPEED = 80 })
  for (let i = 0; i < 1200; i++) {
    const s = await stageOf(page); if (s === 'vote') break
    const t = await page.evaluate(() => window.__P.slice(-2).map((p) => p.t)), k = s === 'left' ? 0 : s === 'right' ? 1 : -1
    if (k >= 0) { seen[k][0] = Math.min(seen[k][0], t[k]); seen[k][1] = Math.max(seen[k][1], t[k]) }
    await sleep(40)
  }
  await page.evaluate(() => { window.__SPEED = 1 })
  return seen
}

// (1) a 63s vs 46s clash: both play to their ends (the old equal-length rule cut the 63s clip at 46s)
{ const { page, errs, ctx } = await open('desktop', { hash: '#clash/gN02rRbOlUE/xnUWpegM9oY', durs: { ...DUR, gN02rRbOlUE: 63, xnUWpegM9oY: 46 } })
  const [L, R] = await playThrough(page)
  ok(L[1] >= 63 - 0.01 && R[1] >= 46 - 0.01, `63s vs 46s: clip one played to ${L[1].toFixed(1)}s, clip two to ${R[1].toFixed(1)}s (their ends)`)
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | ')); await ctx.close() }
// (1b) a long uncut set (404s, needsCut) vs a clip clips.json has no length for (player says 400s): each plays its closing window to the end
{ const long = CLIPS.find((c) => c.format !== 'vertical' && c.dur > 300 && c.start == null && c.status !== 'removed'), unk = CLIPS.find((c) => c.format !== 'vertical' && !c.dur && !c.sec && c.comic !== long.comic && c.status !== 'removed')
  const { page, ctx } = await open('desktop', { hash: `#clash/${long.id}/${unk.id}`, durs: { ...DUR, [unk.id]: 400 } })
  const [L, R] = await playThrough(page)
  ok(Math.abs(L[0] - (long.dur - 150)) < 1 && L[1] >= long.dur - 0.01, `long set (${long.dur}s): plays its last 150s, ${L[0].toFixed(0)}..${L[1].toFixed(0)}s (trimmed from the start, never the end)`)
  ok(R[0] >= 249 && R[1] >= 399.99, `unknown length (400s per the player): moves to its closing window and plays to the end, ${R[0].toFixed(0)}..${R[1].toFixed(0)}s`)
  // (2) the 10 s ballot: a draining ring; no pick in 10 s = an auto-pass (a pass, never a vote); the Pass button still works
  ok(await page.evaluate(() => !!document.querySelector('.slide:last-child .ballot .ring .rfg') && !!document.querySelector('.slide:last-child .vpass')), 'ballot shows the countdown ring and the Pass button')
  await sleep(6500); ok(await stageOf(page) === 'vote', 'ballot still open at ~7s')
  await sleep(4500)
  const P1 = await page.evaluate(() => ({ passes: JSON.parse(localStorage.getItem('funnier.passes') || '[]'), votes: JSON.parse(localStorage.getItem('funnier.votes') || '[]').length, st: document.querySelector('.slide:last-child')?.dataset.stage }))
  ok(P1.passes.length === 1 && P1.passes[0].timedOut === true && P1.passes[0].decisionMs >= 9900 && P1.passes[0].decisionMs < 11500 && P1.votes === 0 && P1.st !== 'vote', `no pick in 10s = an auto-pass, not a vote (${P1.passes[0]?.decisionMs}ms, stage now ${P1.st})`)
  await page.waitForFunction(() => ['left', 'intro'].includes(document.querySelector('.slide:last-child')?.dataset.stage), { timeout: 8000 }); await toBallot(page)
  await page.click('.slide:last-child .vpass'); await sleep(900)
  ok(await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('funnier.passes') || '[]'); return p.length === 2 && !p[1].timedOut && Number.isInteger(p[1].decisionMs) }), 'Pass button records a (non-timed-out) pass and moves on'); await ctx.close() }
// (3) desktop: never a vertical clip; phone still gets them
{ const { page, ctx } = await open('desktop')
  const r = await page.evaluate(() => { let v = 0, n = 0; for (let i = 0; i < 400; i++) { const p = window.__funnierTest.pickPair(); if (!p) continue; n++; v += p.filter((c) => c.format === 'vertical').length } return { v, n } })
  ok(r.n >= 350 && r.v === 0, `desktop: ${r.n} sampled rounds, ${r.v} vertical clips`)
  const vids = CLIPS.filter((c) => c.format === 'vertical' && c.status !== 'removed'), h = CLIPS.find((c) => c.format !== 'vertical' && c.comic !== vids[0].comic)
  await page.evaluate((hs) => { location.hash = hs }, `#clash/${vids[0].id}/${h.id}`); await sleep(3500)
  const ids = await page.evaluate(() => window.__P.slice(-2).map((p) => p.vid))
  ok(!ids.includes(vids[0].id) && ids.every((id) => BY[id]?.format !== 'vertical'), `desktop #clash link with a vertical Short: not played (${ids.join(' vs ')})`)
  await ctx.close()
  const ph = await open('phone')
  const rp = await ph.page.evaluate(() => { let v = 0; for (let i = 0; i < 200; i++) { const p = window.__funnierTest.pickPair(); if (p) v += p.filter((c) => c.format === 'vertical').length } return v })
  ok(rp > 0, `phone: vertical clips still served (${rp} in 200 rounds)`); await ph.ctx.close() }
// (4) the daily pill: banner play + vote, banner play + Pass, the same pair from a #clash link + vote
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
const D = JSON.parse(fs.readFileSync(path.join(SITE, 'daily.json'), 'utf8')).find((x) => x.date === today)
if (!D) console.log('SKIP daily: no editorial entry today')
else for (const how of ['banner+vote', 'banner+pass', 'link+vote']) {
  const { page, errs, ctx } = await open('desktop', { hash: how === 'link+vote' ? `#clash/${D.a}/${D.b}` : '' })
  if (how !== 'link+vote') { ok(await pill(page), `${how}: pill shows before`); await page.click('#daily [data-dh="play"]'); await sleep(400); await page.waitForFunction(() => document.querySelector('.slide:last-child')?.dataset.stage === 'left', { timeout: 8000 }) }
  ok(!(await pill(page)), `${how}: pill hidden while today's clash plays`)
  await toBallot(page)
  if (how.endsWith('vote')) await page.click('.slide:last-child .pick.L'); else await page.click('.slide:last-child .vpass')
  await sleep(2000); ok(!(await pill(page)), `${how}: pill gone after`)
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); ok(!(await pill(page)), `${how}: still gone after a reload`)
  if (how.endsWith('vote')) ok(await page.evaluate((d) => JSON.parse(localStorage.getItem('funnier.votes') || '[]').some((v) => v.daily === d), today), `${how}: the vote is tagged as today's daily`)
  ok(errs.length === 0, `${how}: no page errors ${errs.slice(0, 2).join(' | ')}`); await ctx.close()
}
await browser.close(); site.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0)
