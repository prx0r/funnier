// Share cards drawn on a <canvas> (exported as PNG): humour chart (4:5 feed / 9:16 story), "Make me laugh by…",
// "Funny / Not funny", "My comedy taste in 4 comics", "Me vs my friend", and the 1200x630 link-preview card.
// Only our own artwork: the mascot avatars, our typography, and Wikimedia Commons portraits (same-origin files under
// site/img, with their credit printed on the card). No meme templates, no video frames or YouTube thumbnails.
// Every card carries a small funnier.si/u/<username> watermark.
import { chartAxes, dimShort, CHART_COLORS } from './humour.js'

export const SIZES = { feed: [1080, 1350], story: [1080, 1920], og: [1200, 630] }
export const TEMPLATES = [
  { k: 'chart', label: 'Humour chart', sizes: ['feed', 'story'] },
  { k: 'mml', label: 'Make me laugh by…', sizes: ['feed', 'story'] },
  { k: 'funny', label: 'Funny / Not funny', sizes: ['feed', 'story'] },
  { k: 'four', label: 'My taste in 4', sizes: ['feed', 'story'] },
  { k: 'vs', label: 'Me vs friend', sizes: ['feed', 'story'], needs: 'friend' },
]
const BG = '#07070a', RED = '#e8102e', GOLD = '#f5c76b', TEXT = '#f3f1ec', MUTED = '#8d8b93', PANEL = '#131319', LINE = '#23232d'
const F = { display: 'Anton, Impact, sans-serif', sans: '"Inter Tight", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' }

export async function fontsReady() {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const want = ['400 80px Anton', '800 48px "Inter Tight"', '600 32px "Inter Tight"', '400 24px "JetBrains Mono"']
  await Promise.race([Promise.all(want.map((f) => document.fonts.load(f).catch(() => null))), new Promise((r) => setTimeout(r, 1500))])
}
// the chart's line is written to its owner ("You like…"); a card speaks as them ("I like…")
export const firstPerson = (t) => String(t || '').replace(/^You like /, 'I like ').replace(/^An open mind: nothing wins you over yet/, 'An open mind: nothing wins me over yet').replace(/^Still reading you\..*$/, 'Still calibrating my sense of humour.')
const imgCache = new Map()
export function loadImg(src) {
  if (!src) return Promise.resolve(null)
  if (imgCache.has(src)) return imgCache.get(src)
  const p = new Promise((res) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src })
  imgCache.set(src, p)
  return p
}
export const svgURL = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(String(svg || '').replace(/<svg /, '<svg width="512" height="512" '))

// ---------- primitives ----------
function bg(ctx, W, H, glow = RED, grain = true) {
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)
  let g = ctx.createRadialGradient(W / 2, -H * 0.05, 0, W / 2, -H * 0.05, H * 0.75)
  g.addColorStop(0, hexA(glow, 0.3)); g.addColorStop(1, hexA(glow, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  g = ctx.createRadialGradient(W / 2, H * 1.1, 0, W / 2, H * 1.1, H * 0.6)
  g.addColorStop(0, 'rgba(245,199,107,.10)'); g.addColorStop(1, 'rgba(245,199,107,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  // film grain: deterministic speckle
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  if (!grain) return
  ctx.fillStyle = 'rgba(255,255,255,.035)'
  for (let i = 0; i < (W * H) / 2600; i++) ctx.fillRect(rnd() * W, rnd() * H, 1.4, 1.4)
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }
function wordmark(ctx, x, y, size = 46, align = 'left') {
  ctx.save(); ctx.font = `400 ${size}px ${F.display}`; ctx.fillStyle = RED; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(232,16,46,.55)'; ctx.shadowBlur = size * 0.5
  ctx.setTransform(1, 0, 0, 1.08, 0, 0); ctx.fillText('FUNNIER', x, y / 1.08); ctx.restore()
}
function watermark(ctx, W, H, d, pad = 56) {
  ctx.save(); ctx.font = `400 ${Math.round(W / 40)}px ${F.mono}`; ctx.fillStyle = 'rgba(243,241,236,.6)'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
  ctx.fillText(d.url || 'funnier.si', W - pad, H - pad * 0.75); ctx.restore()
}
function wrap(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean), lines = []
  let cur = ''
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w } else cur = t }
  if (cur) lines.push(cur)
  return lines
}
// draws wrapped text, shrinking the font until it fits maxLines; returns the y after the last line
function textBlock(ctx, text, x, y, maxW, { size = 48, min = 28, weight = 800, font = F.sans, color = TEXT, lh = 1.18, maxLines = 4, align = 'left' } = {}) {
  let s = size, lines
  for (;;) { ctx.font = `${weight} ${s}px ${font}`; lines = wrap(ctx, text, maxW); if (lines.length <= maxLines || s <= min) break; s -= 2 }
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…' }
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top'
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * s * lh))
  return y + lines.length * s * lh
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
async function avatar(ctx, svg, x, y, size, ring = GOLD) {
  const im = await loadImg(svgURL(svg))
  ctx.save(); ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.fillStyle = PANEL; ctx.fill(); ctx.clip()
  if (im) ctx.drawImage(im, x, y, size, size)
  ctx.restore()
  ctx.save(); ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 3, 0, Math.PI * 2); ctx.strokeStyle = ring; ctx.lineWidth = 4; ctx.stroke(); ctx.restore()
}
// cover-fit an image into a rounded box (portrait focus ~20% from the top, like the site)
async function photoBox(ctx, src, x, y, w, h, r, name) {
  const im = await loadImg(src)
  ctx.save(); rrect(ctx, x, y, w, h, r); ctx.clip()
  if (im) {
    const s = Math.max(w / im.width, h / im.height), dw = im.width * s, dh = im.height * s
    ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) * 0.2, dw, dh)
  } else {
    const hue = [...String(name)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
    const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, `hsl(${hue} 70% 24%)`); g.addColorStop(1, '#0b0b0e'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h)
  }
  const g = ctx.createLinearGradient(0, y + h * 0.45, 0, y + h); g.addColorStop(0, 'rgba(7,7,10,0)'); g.addColorStop(1, 'rgba(7,7,10,.92)'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h)
  ctx.restore()
  ctx.save(); rrect(ctx, x, y, w, h, r); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore()
}
function credits(ctx, list, x, y, maxW, size = 15) {
  const t = list.filter(Boolean).map((p) => `${p.comic || p.name}: ${p.credit}${p.license ? ' / ' + p.license : ''}`).join(' · ')
  if (!t) return y
  return textBlock(ctx, 'Photos (Wikimedia Commons): ' + t, x, y, maxW, { size, min: 11, weight: 400, font: F.sans, color: 'rgba(243,241,236,.42)', maxLines: 3, lh: 1.3 })
}
// the radar, natively on canvas (same geometry as humour.js chartSVG)
export function drawRadar(ctx, series, cx, cy, R, { labels = true, size = 30, values = true } = {}) {
  const ks = chartAxes(series), N = ks.length, ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / N
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * (v / 100), cy + Math.sin(ang(i)) * R * (v / 100)]
  const path = (vals) => { ctx.beginPath(); vals.forEach((v, i) => { const [x, y] = pt(i, v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) }); ctx.closePath() }
  ctx.save()
  for (const r of [25, 50, 75, 100]) { path(ks.map(() => r)); ctx.strokeStyle = r === 50 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.1)'; ctx.lineWidth = r === 50 ? 2 : 1.5; ctx.setLineDash(r === 50 ? [5, 7] : []); ctx.stroke() }
  ctx.setLineDash([])
  ks.forEach((k, i) => { const [x, y] = pt(i, 100); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1.5; ctx.stroke() })
  series.forEach((s, j) => {
    if (!s?.dims) return
    const col = s.color || CHART_COLORS[j], vals = ks.map((k) => Math.max(4, Math.min(100, s.dims[k] ?? 50)))
    path(vals)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); g.addColorStop(0, hexA(col, 0.06)); g.addColorStop(1, hexA(col, j ? 0.24 : 0.42))
    ctx.fillStyle = g; ctx.fill()
    ctx.strokeStyle = col; ctx.lineWidth = j ? 4 : 5.5; ctx.lineJoin = 'round'; ctx.setLineDash(j ? [12, 9] : []); ctx.shadowColor = hexA(col, 0.6); ctx.shadowBlur = j ? 0 : 18; ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([])
    if (!j) vals.forEach((v, i) => { const [x, y] = pt(i, v); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill() })
  })
  if (labels) ks.forEach((k, i) => {
    const [x, y] = pt(i, 116), a = Math.cos(ang(i))
    ctx.textAlign = Math.abs(a) < 0.3 ? 'center' : a > 0 ? 'left' : 'right'; ctx.textBaseline = 'middle'
    ctx.font = `600 ${size}px ${F.sans}`; ctx.fillStyle = 'rgba(243,241,236,.85)'
    const label = dimShort(k), v = series[0]?.dims?.[k]
    if (values && v != null) {
      const lw = ctx.measureText(label).width; ctx.font = `800 ${size}px ${F.sans}`; const vw = ctx.measureText(' ' + v).width
      const x0 = ctx.textAlign === 'center' ? x - (lw + vw) / 2 : ctx.textAlign === 'left' ? x : x - lw - vw
      const x1 = Math.max(12, Math.min(ctx.canvas.width - 12 - lw - vw, x0))
      ctx.textAlign = 'left'; ctx.font = `600 ${size}px ${F.sans}`; ctx.fillStyle = 'rgba(243,241,236,.85)'; ctx.fillText(label, x1, y)
      ctx.font = `800 ${size}px ${F.sans}`; ctx.fillStyle = series[0].color || CHART_COLORS[0]; ctx.fillText(' ' + v, x1 + lw, y)
    } else {
      const lw = ctx.measureText(label).width, x0 = ctx.textAlign === 'center' ? x - lw / 2 : ctx.textAlign === 'left' ? x : x - lw
      ctx.textAlign = 'left'; ctx.fillText(label, Math.max(12, Math.min(ctx.canvas.width - 12 - lw, x0)), y)
    }
  })
  ctx.restore()
}
function kicker(ctx, t, x, y, size = 24, color = GOLD, align = 'left') {
  ctx.save(); ctx.font = `400 ${size}px ${F.mono}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top'
  if ('letterSpacing' in ctx) ctx.letterSpacing = Math.round(size * 0.18) + 'px'
  ctx.fillText(t.toUpperCase(), x, y); ctx.restore()
}
async function header(ctx, W, d, y, pad, k) {
  await avatar(ctx, d.avatarSVG, pad, y, 112)
  ctx.font = `800 52px ${F.sans}`; ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText('@' + (d.username || 'you'), pad + 140, y + 14)
  kicker(ctx, k, pad + 142, y + 78, 22)
  wordmark(ctx, W - pad, y + 54, 46, 'right')
}

// ---------- templates ----------
const T = {
  async chart(ctx, W, H, d) {
    const pad = 72, story = H / W > 1.6, c = d.chart || {}
    await header(ctx, W, d, story ? 120 : 64, pad, 'My sense of humour')
    const cy = story ? 760 : 610, R = story ? 330 : 300
    drawRadar(ctx, [{ dims: c.dims, color: CHART_COLORS[0] }], W / 2, cy, R, { size: 30 })
    let y = cy + R + (story ? 130 : 96)
    y = textBlock(ctx, firstPerson(c.line) || 'Still reading me.', pad, y, W - 2 * pad, { size: story ? 56 : 46, min: 30, maxLines: 3 })
    if (c.funniest?.title) y = textBlock(ctx, `Funniest to me: "${c.funniest.title}" (${c.funniest.comic})`, pad, y + 18, W - 2 * pad, { size: 28, min: 20, weight: 500, color: 'rgba(243,241,236,.7)', maxLines: 2 })
    if (c.ops?.length) textBlock(ctx, 'Favourite moves: ' + c.ops.slice(0, 3).map((o) => o.label).join(' · '), pad, y + 14, W - 2 * pad, { size: 26, min: 18, weight: 500, color: GOLD, maxLines: 2 })
    watermark(ctx, W, H, d, pad)
  },
  async mml(ctx, W, H, d) {
    const pad = 80, story = H / W > 1.6
    wordmark(ctx, W / 2, story ? 190 : 130, 54, 'center')
    const cw = W - 2 * pad, ch = story ? 980 : 760, y0 = (H - ch) / 2 + (story ? 40 : 30)
    ctx.save(); rrect(ctx, pad, y0, cw, ch, 44); ctx.fillStyle = PANEL; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 60; ctx.fill(); ctx.restore()
    ctx.save(); rrect(ctx, pad, y0, cw, ch, 44); ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke(); ctx.restore()
    await avatar(ctx, d.avatarSVG, pad + 64, y0 + 64, 96)
    ctx.font = `800 40px ${F.sans}`; ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('@' + (d.username || 'you'), pad + 186, y0 + 112)
    ctx.font = `700 40px ${F.sans}`; ctx.fillStyle = GOLD; ctx.textBaseline = 'top'; ctx.fillText('Make me laugh by…', pad + 64, y0 + 230)
    textBlock(ctx, d.mml || 'surprising me', pad + 64, y0 + 310, cw - 128, { size: story ? 84 : 74, min: 44, weight: 800, maxLines: 5, lh: 1.12 })
    if (d.chart?.adjacent) kicker(ctx, `${d.chart.adjacent.pct}% ${d.chart.adjacent.short}-adjacent`, pad + 64, y0 + ch - 92, 24, MUTED)
    watermark(ctx, W, H, d, pad)
  },
  async funny(ctx, W, H, d) {
    const pad = 64, story = H / W > 1.6, gap = 28, top = story ? 220 : 150, bottom = story ? 220 : 170
    wordmark(ctx, pad, story ? 150 : 96, 46)
    kicker(ctx, '@' + (d.username || 'you') + "'s verdict", W - pad, story ? 118 : 70, 22, GOLD, 'right')
    const ph = (H - top - bottom - gap) / 2
    const panel = async (it, y, label, col) => {
      await photoBox(ctx, it?.photo, pad, y, W - 2 * pad, ph, 32, it?.name || label)
      ctx.save(); ctx.font = `400 ${story ? 120 : 104}px ${F.display}`; ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 20
      ctx.fillText(label, pad + 40, y + 34); ctx.restore()
      const ny = y + ph - (it?.sub ? 150 : 104)
      textBlock(ctx, it?.name || '', pad + 40, ny, W - 2 * pad - 80, { size: 56, min: 32, maxLines: 1 })
      if (it?.sub) textBlock(ctx, it.sub, pad + 40, ny + 66, W - 2 * pad - 80, { size: 28, min: 20, weight: 500, color: 'rgba(243,241,236,.75)', maxLines: 1 })
    }
    await panel(d.funny, top, 'FUNNY', GOLD)
    await panel(d.notFunny, top + ph + gap, 'NOT FUNNY', MUTED)
    credits(ctx, [d.funny?.photo && d.funny, d.notFunny?.photo && d.notFunny], pad, H - bottom + 30, W - 2 * pad - 340)
    watermark(ctx, W, H, d, pad)
  },
  async four(ctx, W, H, d) {
    const pad = 64, story = H / W > 1.6, gap = 24
    wordmark(ctx, pad, story ? 170 : 100, 46)
    textBlock(ctx, 'My comedy taste in 4 comics', pad, story ? 220 : 140, W - 2 * pad, { size: story ? 76 : 64, min: 40, maxLines: 2, weight: 800 })
    const favs = (d.favs || []).slice(0, 4), cw = (W - 2 * pad - gap) / 2, top = story ? 470 : 330, chh = story ? 560 : 400
    for (let i = 0; i < 4; i++) {
      const f = favs[i], x = pad + (i % 2) * (cw + gap), y = top + Math.floor(i / 2) * (chh + gap)
      if (!f) { ctx.save(); rrect(ctx, x, y, cw, chh, 28); ctx.setLineDash([10, 10]); ctx.strokeStyle = LINE; ctx.lineWidth = 3; ctx.stroke(); ctx.restore(); continue }
      await photoBox(ctx, f.photo, x, y, cw, chh, 28, f.name)
      ctx.font = `400 64px ${F.display}`; ctx.fillStyle = 'rgba(243,241,236,.9)'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(String(i + 1), x + 26, y + 18)
      textBlock(ctx, f.name, x + 26, y + chh - 82, cw - 52, { size: 42, min: 26, maxLines: 1 })
    }
    credits(ctx, favs.filter((f) => f?.photo), pad, top + 2 * chh + gap + 28, W - 2 * pad - 340, 14)
    watermark(ctx, W, H, d, pad)
  },
  async vs(ctx, W, H, d) {
    const pad = 72, story = H / W > 1.6, fr = d.friend || {}
    wordmark(ctx, W / 2, story ? 170 : 104, 46, 'center')
    const hy = story ? 230 : 150
    await avatar(ctx, d.avatarSVG, pad, hy, 96, CHART_COLORS[0]); await avatar(ctx, fr.avatarSVG, W - pad - 96, hy, 96, CHART_COLORS[1])
    ctx.textBaseline = 'top'; ctx.font = `800 36px ${F.sans}`
    ctx.fillStyle = CHART_COLORS[0]; ctx.textAlign = 'left'; ctx.fillText('@' + (d.username || 'me'), pad, hy + 116)
    ctx.fillStyle = CHART_COLORS[1]; ctx.textAlign = 'right'; ctx.fillText('@' + (fr.username || 'friend'), W - pad, hy + 116)
    ctx.textAlign = 'center'; ctx.fillStyle = TEXT; ctx.font = `400 ${story ? 150 : 124}px ${F.display}`; ctx.fillText(fr.match != null ? fr.match + '%' : 'VS', W / 2, hy - 10)
    kicker(ctx, 'taste match', W / 2, hy + (story ? 150 : 124), 22, MUTED, 'center')
    const cy = story ? 900 : 700, R = story ? 320 : 270
    drawRadar(ctx, [{ dims: d.chart?.dims, color: CHART_COLORS[0] }, { dims: fr.chart?.dims, color: CHART_COLORS[1] }], W / 2, cy, R, { size: 28, values: false })
    let y = cy + R + (story ? 120 : 84)
    if (fr.both) y = textBlock(ctx, fr.both, pad, y, W - 2 * pad, { size: 36, min: 24, maxLines: 2, weight: 700 })
    if (fr.disagree) textBlock(ctx, fr.disagree, pad, y + 12, W - 2 * pad, { size: 30, min: 20, maxLines: 2, weight: 500, color: 'rgba(243,241,236,.72)' })
    watermark(ctx, W, H, d, pad)
  },
  async og(ctx, W, H, d) {
    const c = d.chart || {}
    await avatar(ctx, d.avatarSVG, 70, 70, 120)
    ctx.font = `800 54px ${F.sans}`; ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('@' + (d.username || 'you'), 70, 220)
    kicker(ctx, 'Sense of humour', 72, 296, 22)
    textBlock(ctx, firstPerson(c.line) || 'A Funnier profile', 70, 350, 600, { size: 40, min: 26, maxLines: 4 })
    wordmark(ctx, 70, 575, 44)
    drawRadar(ctx, [{ dims: c.dims, color: CHART_COLORS[0] }], 905, 305, 165, { size: 21 })
    watermark(ctx, W, H, d, 40)
  },
}

// draws template `kind` at `size` into canvas cv; returns cv (or null when canvas isn't available)
// (drawn offscreen first, so two quick re-renders never paint over each other; `isLatest()` can veto the copy)
export async function drawCard(cv, kind, d, size = 'feed', isLatest = () => true) {
  const [W, H] = SIZES[size] || SIZES.feed
  if (!cv?.getContext || !T[kind] || typeof document === 'undefined') return null
  const off = document.createElement('canvas'); off.width = W; off.height = H
  const ctx = off.getContext && off.getContext('2d')
  if (!ctx) return null
  await fontsReady()
  bg(ctx, W, H, kind === 'mml' ? GOLD : RED, kind !== 'og')
  await T[kind](ctx, W, H, d)
  if (!isLatest()) return cv
  cv.width = W; cv.height = H
  const c2 = cv.getContext('2d'); if (!c2) return null
  c2.drawImage(off, 0, 0)
  return cv
}
export const toBlob = (cv) => new Promise((res) => { try { cv.toBlob((b) => res(b), 'image/png') } catch { res(null) } })
