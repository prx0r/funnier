// Clip discovery for funnygraph comics that have no Funnier clips yet (kings first, then indies with active channels).
// Node 22+, no deps, keyless, metadata only: nothing is downloaded, no transcripts or bit text are read.
// Sources, funnygraph's own curated links first:
//   - data/youtube/<comedian_id>.json  rows funnygraph harvested (videoId, title, channel, duration)
//   - each comic's registered channel (comedian-graph youtube_channel, status active/stale) -> its public /videos page
//   - --search: only when those give fewer candidates than needed, the public YouTube search-results page for
//     "<name> stand up" (keyless, metadata only; any embeddable upload, unofficial included, still name + stand-up cue gated)
// --topup K: also tops up comics that already have clips, to K clips each. --scope people: every comic on the funnygraph
// boards (boards.json people), ordered UK/Ireland first, then other internationals, then kings, then the rest.
// Every pick must be an official YouTube embed: oEmbed 200 (401/403 = embedding disabled, 404 = gone). Format comes
// from tools/detect-format.mjs (desktop never gets a vertical clip). Dedup follows tools/merge-c2-corpus.py: exact id,
// tools/dupes.json, and same comic + normalised title + duration within 5 s (carrier rank own > licensed > unofficial).
// Tags: setting (stand-up / talk-show / special) + format, plus the comic's funnygraph persona style tags
// (tools/fg-lib.mjs personaTags), marked tagsSource "fg-persona" so they read as a comic-level prior, not a clip label.
// Usage (from funnier/): node tools/discover-fg-clips.mjs --roster /tmp/pub/data/funnygraph/roster.json [--max 300] [--dry]
import fs from 'node:fs'
import { FG_REPO, rawUrl } from './fg-lib.mjs'
import { isVertical } from './detect-format.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DRY = process.argv.includes('--dry'), SEARCH = process.argv.includes('--search'), TOPUP = +arg('--topup', 0), MAX = +arg('--max', 300), KING_K = +arg('--king', 5), INDIE_K = +arg('--indie', 5)
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' }
const today = new Date().toISOString().slice(0, 10)
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
async function getJSON(u) { try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) }); return r.ok ? await r.json() : null } catch { return null } }
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } })); return out }

const roster = readJSON(arg('--roster', '/tmp/pub/data/funnygraph/roster.json'), null)
if (!roster?.comedians || !roster.sha) { console.error('need a synced roster: node tools/sync-funnygraph.mjs . /tmp/pub'); process.exit(1) }
const REF = roster.sha, C = roster.comedians
const ratings = (await getJSON(rawUrl(REF, 'rankings/ratings.json')))?.rows || []
const clips = readJSON('clips.json', []), dupes = readJSON('tools/dupes.json', { dupes: [] }).dupes
const fgmap = readJSON('fg-map.json', { map: {} }).map || {}
const owned = readJSON('site/comics.json', { comics: {} }).comics
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const fgOfName = (n) => fgmap[n] || owned[n]?.slug || slug(n)
const have = {}; for (const c of clips) if (c.status !== 'removed') { const k = c.fg || fgOfName(c.comic); have[k] = (have[k] || 0) + 1 }
const covered = new Set(Object.keys(have).filter((k) => !TOPUP || have[k] >= TOPUP))
const people = arg('--scope', '') === 'people' ? (readJSON(arg('--boards', '/tmp/pub/data/funnygraph/boards.json'), {})?.people || null) : null
const known = new Set([...clips.map((c) => c.id), ...dupes.map((d) => d.id)])

// ---- text rules ----
const fold = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const words = (s) => fold(s).replace(/[^a-z0-9\u0080-\uffff]+/g, ' ').trim()
const NOT_A_SET = /\b(podcast|episode|ep\.? ?\d|interview|reacts?|reaction|review|trailer|teaser|promo|tour dates?|tour starts|starts tomorrow|tickets|on sale|livestream|live stream|q ?& ?a|behind the scenes|bts|vlog|unboxing|announcement|full (special|show|set|episode|concert|appearance)|full stand ?up special|audiobook|album|documentary|in conversation|talks about|explains|breaks down|ranking|ranks|top \d+|compilation|try not to laugh|sketch\w*|music video|official video|lyric|song|cover|remix|tribute|memorial|funeral|dies|death of|passed away|news|press|red carpet|speech|moment|moments|regret|reply|shocks|meme|wins|emmy|oscars?|golden globes?|panel|tough crowd|encounter|roller coaster|lyft|drawings|speechless|returns to|celebrity jeopardy|chappelle's show|marvelous mrs|dustin hoffman|lenny 1974|call me bae|modding|mod|3d ?print\w*|wakeboard|game jam|gameplay|preview|taping|now on|out now on|roast battle|honeymoon|travel|poscast|la ?mesa re\w*|tirando ?bola|cartoon|animation|songs?|challenge)\b/i
const DENY_CHANNELS = /^(ymh studios|jre clips|powerfuljre|abc news|cbs news|nbc news|fox news|cnn|the college fix|julian dorey|julian dorey podcast|get down with sean and.*|amazon prime video.*|prime video.*|flagrant|this past weekend|the michael parkinson.*|reelblack one|wealthy pot)$/i
const SET_CUES = /\b(stand ?-?up|standup|comedy|comedian|crowd ?work|special|live at|live in|stand ?up set|comedy set|first set|joke|jokes|netflix is a joke|dry bar|jfl|just for laughs|weekend update|first appearance|monologue|comedy central|#comedy|#standup\w*|comedia|comédia|comedie|comédie|humor|humour|kabarett|cabaret|spectacle)\b|喜剧|脱口秀|相声|单口/i
// panel/quiz shows, news and promos are not stand-up (checked on title + channel)
export const NOT_STANDUP = /\b(QI|taskmaster|would i lie to you|8 out of 10 cats|mock the week|have i got news|big fat quiz|celebrity juice|never mind the buzzcocks|tmz|news|talks (upcoming|about)|interview|podcast|\d{1,2}(st|nd|rd|th) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|tickets?)\b/i
const SNL_OK = /weekend update/i, TALK_OK = /\b(stand ?-?up|standup|first appearance|monologue|delivers|has everyone|has johnny|comedy)\b/i
const TALK = /\b(tonight show|late night|late show|kimmel|conan|letterman|seth meyers|colbert|fallon|carson|graham norton|team coco)\b/i
const LIC = /^(netflix|netflix is a joke|comedy central|comedy central stand-up|comedy central uk|just for laughs|jfl|just for laughs gags|hbo|max|team coco|the tonight show.*|late show.*|the late show.*|late night.*|jimmy kimmel live|the late late show.*|letterman|saturday night live|snl|kill tony|dry bar comedy|don't tell comedy|dont tell comedy|800 pound gorilla records|comedy dynamics|bbc|bbc comedy|channel 4|channel 4 entertainment|the graham norton show|johnny carson|the tonight show starring johnny carson|live at the apollo|live at the apollo|bbc studios|bbc iplayer|universal comedy|still watching netflix|sky tv|sky comedy|channel 4 comedy|avalon|avalon uk|off the kerb|comedy central stand-up|jfl ?(?:montreal|uk)?|just for laughs uk|nbc|amazon prime video uk|rte|rté|rte comedy|rté player)$/i
const STOPW = new Set(['full', 'hd', 'standup', 'stand', 'up', 'comedy', 'special', 'the', 'clip', 'netflix', 'official', 'shorts', 'and'])
const ntitle = (comic, t) => { let s = fold(t); for (const w of [fold(comic)]) s = s.split(w).join(' '); s = s.replace(/#\w+/g, ' ').replace(/\b(19|20)\d\d\b/g, ' '); return s.replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOPW.has(w)).join('') }
const RANK = { own: 0, licensed: 1, unofficial: 2 }
const others = Object.values(C).filter((g) => !g.synthetic).map((g) => ({ id: g.id, n: words(g.name) })).filter((x) => x.n.split(' ').length >= 2)

const LAUGH_EMOJI = /[\u{1F602}\u{1F923}]/u
const leadsWithName = (g, title) => words(title).startsWith(words(g.name) + ' ') && /^[^-\u2013:|]{0,40}[-\u2013:|]/.test(title)
function namesComic(g, title) { const t = ' ' + words(title) + ' ', n = words(g.name); return n.length >= 4 && t.includes(' ' + n + ' ') }
function namesOther(g, title) { const t = ' ' + words(title) + ' '; return others.some((o) => o.id !== g.id && t.includes(' ' + o.n + ' ') && !words(g.name).includes(o.n)) }
function carrierOf(g, channel, ownTitles) {
  const ch = fold(channel).trim()
  if (ownTitles.has(ch) || ch === fold(g.name) || ch.replace(/\s+/g, '') === fold(g.name).replace(/\s+/g, '')) return 'own'
  return LIC.test(String(channel || '').trim()) ? 'licensed' : 'unofficial'
}
const secOf = (s) => { if (typeof s === 'number') return s; const p = String(s || '').split(':').map(Number); return p.some(isNaN) || !p.length ? null : p.reduce((a, x) => a * 60 + x, 0) }

// public /videos page of a registered channel: id, title, duration badge (metadata only)
async function channelVideos(id) {
  try {
    const h = await (await fetch(`https://www.youtube.com/channel/${id}/videos`, { headers: UA, signal: AbortSignal.timeout(20000) })).text()
    const m = h.match(/var ytInitialData = (\{.*?\});<\/script>/s); if (!m) return []
    const out = [], walk = (o) => { if (!o || typeof o !== 'object') return
      if (o.lockupViewModel?.contentId && o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        const v = o.lockupViewModel, s = JSON.stringify(v), badge = s.match(/"thumbnailBadgeViewModel":\{"text":"([\d:]+)"/)
        out.push({ videoId: v.contentId, title: v.metadata?.lockupMetadataViewModel?.title?.content || '', duration_s: badge ? secOf(badge[1]) : null })
        return }
      for (const k in o) walk(o[k]) }
    walk(JSON.parse(m[1])); return out
  } catch { return [] }
}
// public search-results page (keyless): id, title, channel, duration, views; Shorts are marked vertical up front
// YouTube throttles bursts (a page with no results data): back off and retry, and space searches out
let lastSearch = 0
async function searchVideos(q, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const wait = lastSearch + 1200 - Date.now(); lastSearch = Math.max(Date.now(), lastSearch + 1200); if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const out = await searchOnce(q)
    if (out) return out
    report.searchRetries = (report.searchRetries || 0) + 1
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)))
  }
  report.searchFailed = [...(report.searchFailed || []), q]
  return []
}
async function searchOnce(q) {
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=GB`, { headers: UA, signal: AbortSignal.timeout(20000) })
    if (!r.ok) return null
    const h = await r.text()
    const m = h.match(/var ytInitialData = (\{.*?\});<\/script>/s); if (!m) return null
    const out = [], walk = (o) => { if (!o || typeof o !== 'object') return
      if (o.videoRenderer?.videoId) { const v = o.videoRenderer, s = JSON.stringify(v.navigationEndpoint || {})
        out.push({ videoId: v.videoId, title: v.title?.runs?.map((r) => r.text).join('') || '', channel: v.ownerText?.runs?.[0]?.text || '', duration_s: secOf(v.lengthText?.simpleText),
          views: +(String(v.viewCountText?.simpleText || '').replace(/[^0-9]/g, '')) || 0, short: s.includes('/shorts/'), src: 'yt-search' }); return }
      for (const k in o) walk(o[k]) }
    walk(JSON.parse(m[1])); return out
  } catch { return null }
}
async function oembed(id) {
  try { const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { headers: UA, signal: AbortSignal.timeout(15000) }); if (r.status !== 200) return { ok: false, status: r.status }; const j = await r.json(); return { ok: true, title: j.title, author: j.author_name } } catch { return { ok: false, status: 0 } }
}

// ---- who to look at ----
const rk = Object.fromEntries(ratings.map((r) => [r.comedian_id, r]))
const order = (g) => { const r = rk[g.id] || {}; return [g.tier === 'king' ? 0 : 1, -(r.headline ?? -1), r.boards?.consensus?.rank ?? 999] }
const cmp = (a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }
// funnygraph channel registry points these at someone else's channel or a non-stand-up channel (checked 2026-10-18)
const SKIP = new Set(['pat-regan', 'jeff-allen', 'ryan-davis', 'jay-larson', 'scott-losse', 'tom-briscoe', 'i-go-dye', 'jesse-joyce'])
const PRI = (g) => { const p = people?.[g.id], r = g.region || p?.r || null
  return [r === 'uk' || r === 'ireland' ? 0 : r && r !== 'us' ? 1 : g.tier === 'king' ? 2 : 3] }
const ONLY = arg('--only', '') ? new Set(arg('--only', '').split(',')) : null
const targets = Object.values(C).filter((g) => !g.synthetic && (!ONLY || ONLY.has(g.id)) && !SKIP.has(g.id) && !covered.has(g.id) && (people ? !!people[g.id] : (g.tier === 'king' || g.channels.some((c) => c.status === 'active' || c.status === 'stale' || c.status === 'variety'))))
  .sort((a, b) => (people ? PRI(a)[0] - PRI(b)[0] : 0) || cmp(a, b))
console.log(`targets: ${targets.filter((g) => g.tier === 'king').length} kings without clips, ${targets.filter((g) => g.tier === 'indie').length} indies with active channels; funnygraph@${REF.slice(0, 7)}`)

const report = { ref: REF, kings: { looked: 0, added: 0, noSource: [] }, indies: { looked: 0, added: 0 }, rejected: {}, added: [] }
const reject = (why) => (report.rejected[why] = (report.rejected[why] || 0) + 1)
const picked = []
const titleKeys = new Map(clips.filter((c) => c.status !== 'removed').map((c) => [fgOfName(c.comic) + '|' + ntitle(c.comic, c.title), c]))

let doneN = 0
async function one(g) {
  if (picked.length >= MAX) return
  const K = Math.max(0, (TOPUP || (g.tier === 'king' ? KING_K : INDIE_K)) - (TOPUP ? have[g.id] || 0 : 0)); if (!K) return
  const yt = await getJSON(rawUrl(REF, `data/youtube/${g.id}.json`))
  const ownTitles = new Set([...Object.values(yt?.channels || {}).map((c) => fold(c?.channel).trim()), ...g.channels.map((c) => fold(c.title).trim())].filter(Boolean))
  let rows = (yt?.rows || []).map((r) => ({ ...r, src: 'fg-harvest' }))
  const active = g.channels.filter((c) => c.status === 'active' || (g.tier === 'king' && c.status !== 'dormant'))
  for (const ch of active) rows.push(...(await channelVideos(ch.id)).map((r) => ({ ...r, channel: ch.title || g.name, src: 'channel-page', own: true })))
  report[g.tier === 'king' ? 'kings' : 'indies'].looked++
  const region = g.region || people?.[g.id]?.r || null
  if (SEARCH && rows.filter((r) => { const d = secOf(r.duration_s); return !known.has(r.videoId) && d >= 15 && d <= 600 && !NOT_A_SET.test(r.title || '') }).length < 3 * K) {
    const loc = ['spain', 'mexico', 'argentina', 'colombia'].includes(region) ? ' stand up comedia' : region === 'brazil' ? ' stand up comédia' : region === 'france' ? ' stand-up' : region === 'germany' ? ' stand up comedy' : ' stand up'
    rows.push(...(await searchVideos(g.name + (arg('--suffix', '') ? ' ' + arg('--suffix', '') : loc))))
  }
  if (!rows.length) { if (g.tier === 'king') report.kings.noSource.push(g.id); return }
  const seen = new Set(), cand = []
  for (const r of rows) {
    const id = r.videoId; if (!id || seen.has(id)) continue; seen.add(id)
    if (known.has(id)) { reject('already in Funnier'); continue }
    if (r.src === 'yt-search' && !namesComic(g, r.title)) { reject('search hit does not name the comic'); continue }
    const d = secOf(r.duration_s)
    if (!d || d < 15) { reject('no/too-short duration'); continue }
    if (d > 600) { reject('over 10 min (full sets/specials)'); continue }
    const title = r.title || ''
    if (NOT_A_SET.test(title)) { reject('not a set (podcast/interview/trailer/full special...)'); continue }
    const carrier = r.own ? 'own' : carrierOf(g, r.channel, ownTitles)
    if (carrier !== 'own' && !namesComic(g, title)) { reject('title does not name the comic'); continue }
    if (namesOther(g, title)) { reject('title names another comic'); continue }
    if (DENY_CHANNELS.test(String(r.channel || '').trim())) { reject('podcast/news/film channel'); continue }
    if (NOT_STANDUP.test(title + ' | ' + (r.channel || ''))) { reject('panel show / news / promo'); continue }
    if (carrier === 'own' && !SET_CUES.test(title)) { reject('own upload with no stand-up cue'); continue }
    if (carrier === 'unofficial' && !SET_CUES.test(title) && !leadsWithName(g, title) && !LAUGH_EMOJI.test(title)) { reject('unofficial upload with no stand-up cue'); continue }
    if (/saturday night live|^snl$/i.test(String(r.channel || '')) && !SNL_OK.test(title)) { reject('SNL sketch, not stand-up'); continue }
    if (TALK.test(String(r.channel || '')) && !TALK_OK.test(title)) { reject('talk-show chat, not stand-up'); continue }
    cand.push({ r, d, title, carrier, score: RANK[carrier] * 2 + (d > 300 ? 1.5 : d > 180 ? 0.7 : 0) - Math.log10(1 + (r.views || 0)) / 4 })
  }
  cand.sort((a, b) => a.score - b.score)
  const mine = []
  for (const c of cand) {
    if (mine.length >= K || picked.length + mine.length >= MAX) break
    const key = g.id + '|' + ntitle(g.name, c.title)
    const twin = titleKeys.get(key)
    if (twin && Math.abs((twin.sec || 0) - c.d) <= 5) { reject('dup: normalised title + duration within 5s'); continue }
    const o = await oembed(c.r.videoId)
    if (!o.ok) { reject(o.status === 401 || o.status === 403 ? 'embedding disabled' : 'oEmbed failed / gone'); continue }
    const v = c.r.short ? true : await isVertical(c.r.videoId)
    if (v == null) { reject('format unknown'); continue }
    const t = o.title || c.title, carrier = c.r.own ? 'own' : carrierOf(g, o.author, ownTitles)
    const cues = fold(t)
    const style = [...g.tags]; if (/crowd ?work/.test(cues) && !style.includes('crowd-work')) style.unshift('crowd-work')
    const setting = TALK.test(t) || TALK.test(o.author || '') ? 'talk-show' : 'stand-up'
    const clip = { id: c.r.videoId, comic: g.name, title: t, channel: (o.author || c.r.channel || '').trim(), kind: 'human', media: 'youtube', sec: c.d, dur: c.d, checked: today,
      style: style.slice(0, 3), topics: [], tagsSource: 'fg-persona', special_id: null, special_ref: null, setting, format: v ? 'vertical' : 'horizontal', carrier, fg: g.id, ...(c.r.views ? { views: c.r.views } : {}), ...(region ? { region } : {}), via: `funnygraph@${REF.slice(0, 7)}:${c.r.src}` }
    const y = String(c.r.publishedAt || '').slice(0, 4); if (/^(19|20)\d\d$/.test(y)) clip.year = +y
    if (c.d > 180) clip.needsCut = true
    mine.push(clip); titleKeys.set(key, clip); known.add(clip.id)
  }
  picked.push(...mine)
  report[g.tier === 'king' ? 'kings' : 'indies'].added += mine.length
  if (mine.length) console.log(`${g.tier} ${region || '?'} ${g.id}: +${mine.length} (${mine.map((m) => m.carrier[0] + m.format[0]).join(' ')})`)
  if (++doneN % 25 === 0 && !DRY) { fs.writeFileSync('clips.json', JSON.stringify([...clips, ...picked], null, 1) + '\n'); console.log(`checkpoint ${doneN}/${targets.length}: ${picked.length} picked`) }
}
await pool(targets, +arg('--conc', 4), one)
report.added = picked.map((c) => ({ id: c.id, comic: c.comic, title: c.title, channel: c.channel, fg: c.fg, carrier: c.carrier, format: c.format, setting: c.setting, sec: c.sec }))
report.comics = [...new Set(picked.map((c) => c.fg))].length
fs.writeFileSync(arg('--report', '/tmp/fg-discover-report.json'), JSON.stringify(report, null, 1))
console.log(`picked ${picked.length} clips for ${report.comics} comics (kings +${report.kings.added}/${report.kings.looked} looked, indies +${report.indies.added}/${report.indies.looked}); kings with no funnygraph source: ${report.kings.noSource.length}`)
console.log('rejected', report.rejected)
if (!DRY && picked.length) { fs.writeFileSync('clips.json', JSON.stringify([...clips, ...picked], null, 1) + '\n'); console.log('clips.json now', clips.length + picked.length) }
