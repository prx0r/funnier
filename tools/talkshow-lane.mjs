// Chat reclassification + non-stand-up cleanup for clips.json (one-off, 2026-10-18; clips.json is owned by the corpus agent now) (metadata only, idempotent). Usage (from funnier/):
//   node tools/talkshow-lane.mjs [--dry]
// 1. setting 'chat' = podcast / interview / couch / panel clips. They are excluded from every feed, the rotation and the
//    main charts (src/feeds.js isChat; explicit links still play them). Stand-up spots ON talk shows
//    (Conan / Letterman / Fallon / Carson stand-up sets) and Kill Tony sets stay stand-up.
//    Rule pass (title + channel) + a manual list reviewed title by title (2026-10-18).
// 2. obvious non-stand-up (TV ads, promos, sketches, vlogs, history explainers) leaves clips.json and is recorded in
//    tools/removed-nonstandup.json (so discovery never re-adds it; tools/discover-*.mjs read it as known ids).
import fs from 'node:fs'
const DRY = process.argv.includes('--dry')
const clips = JSON.parse(fs.readFileSync('clips.json', 'utf8'))
const removedPath = 'tools/removed-nonstandup.json'
const removed = fs.existsSync(removedPath) ? JSON.parse(fs.readFileSync(removedPath, 'utf8')) : { note: '', removed: [] }
// --- chat: rules (podcast/interview shows and channels; never a "Stand-Up" titled spot or a Kill Tony set) ---
export const CHAT_RULE = /\b(podcast|interview|in conversation|sits down with|the view|theellenshow|ellen show|the jason show|odd couples|bad advice with|2 truths,? 1 lie|legion of skanks|take your shoes off|problematic with|this past weekend|bertcast|smartless|off menu|joe rogan experience|jre clips|powerfuljre|flagrant|kill tony podcast clips?)\b/i
const STANDUP_CUE = /\b(stand ?-?up|standup|monologue|kill tony( ?#| ?ep| ?\d| \(kt| highlights|.*set)|first appearance|performs)\b/i
// --- chat: manual list (reviewed titles; couch chat on late-night, panel/game shows, podcast clips) ---
export const CHAT_IDS = {
  gN02rRbOlUE: 'Norm Macdonald: Nothing Special (to-camera chat)',
  n3LMSflEN54: 'Norm on Conan: the moth joke from the couch (guest chat)',
  'EF-cw9bsLKs': 'Norm on Letterman: couch compilation',
  'ywica8-Z7kc': 'Norm on Letterman couch',
  p21sXizj4u0: 'Norm tells a story (talk-show couch)',
  GKOAzX1ZXUE: "Sara Pascoe: Jon & Lucy's Odd Couples (panel)",
  OXvUaWDAIBs: 'Catherine Bohart: Bad Advice with Olga Koch (panel)',
  ZXITbaoS2EM: 'Marty Gleeson: Bad Advice with Olga Koch (panel)',
  jOp6ftdNHc8: 'Ramy Youssef on The View (interview)',
  WYze5tT3kHk: 'Jeff Garlin on Ellen (couch)',
  'cjC9RxWVE-8': 'Maddie Wiener on The Jason Show (interview)',
  t0pSGU97hJ4: 'W. Kamau Bell on The Daily Show (interview)',
  C4u_CQWuHHM: 'Ania Magliano on TODAY Australia (interview)',
  '_z8m-EYYw7k': 'Toussaint Douglass: 2 Truths 1 Lie (panel game)',
  '0CyIrrHy4eE': 'Uncle Lazer: Kim Congdon story (podcast clip)',
  SRnD90ApuvM: 'Problematic with Moshe Kasher (talk show)',
  JrLW3SabarM: "Mark Normand on Rick Glassman's Take Your Shoes Off (podcast)",
  '7phVM5xtl2A': 'Drew Michael on Kimmel (interview)',
  cXxsxmaobxs: 'Eddie Izzard on The Late Show (interview)',
  XTVi75zxPxU: 'Maria Bamford on The Late Show (interview)',
  EsYLa79MnXk: 'Legion of Skanks (podcast clip)',
  'luSYkmXW-0o': 'Andy Kaufman as Tony Clifton on Letterman (couch)',
}
// --- removed: obvious non-stand-up ---
export const REMOVE_RULE = /\b(tv ad|advert|advertisement|commercial|trailer|teaser|this day in history|hindsight humor|comedy sketch|a .* sketch|vlog|skating before)\b/i
export const REMOVE_IDS = {
  fVmIEgZMz6c: "Chic Murray's Funnyosities - TV Ad (book advert)",
  JA0BXcIeN0w: 'Lee Hurst Stand Up Special Advert (VHS advert)',
  XpTmjt3Sd9c: 'Byron Trimble: Titanic disaster / Hindsight Humor (history explainer)',
  klps41AX9a8: 'Byron Trimble: White House construction / Hindsight Humor (history explainer)',
  'EwtBIr3-L-Q': 'Rimshot - A Mark Normand Comedy Sketch (sketch)',
  'vdP-WWLdoTw': '"Brightside" - An Artsy Fartsy Comedy Sketch (sketch)',
  WepSp0jYxBQ: 'Mark Normand skating before a show (vlog)',
  '6ul1Fgg2jmw': 'Drunk History feat. Nick Offerman (scripted sketch show)',
  ABml9AvVXQ4: 'Les Dawson: Cissie & Ada (sketch)',
  hxBzR6iZ0hE: 'First Date ft. Ron White (TV show scene)',
  EuPDb9r4Gqw: 'First Date ft. Ron White (TV show scene)',
}
const today = new Date().toISOString().slice(0, 10)
let chat = 0, fixed = 0, gone = []
const keep = []
for (const c of clips) {
  const s = c.title + ' | ' + c.channel
  if (REMOVE_IDS[c.id] || (REMOVE_RULE.test(s) && !/stand ?-?up/i.test(c.title))) { gone.push({ id: c.id, comic: c.comic, title: c.title, channel: c.channel, why: REMOVE_IDS[c.id] || 'rule: ' + s.match(REMOVE_RULE)[0], at: today }); continue }
  if (CHAT_IDS[c.id] || (CHAT_RULE.test(s) && !STANDUP_CUE.test(c.title))) { if (c.setting !== 'chat') { c.setting = 'chat'; chat++ } }
  if (c.id === 'l9w2NxSPr1M' && c.setting === 'talk-show') { c.setting = 'stand-up'; fixed++ } // "Live at Jongleurs - Graham Norton": a club set, not a talk show
  keep.push(c)
}
const have = new Set(removed.removed.map((r) => r.id))
removed.note = 'Not stand-up: removed from clips.json by tools/talkshow-lane.mjs; discovery treats these ids as known.'
for (const g of gone) if (!have.has(g.id)) removed.removed.push(g)
console.log(`chat: +${chat} reclassified (${keep.filter((c) => c.setting === 'chat').length} total); removed ${gone.length} non-stand-up; fixed ${fixed}`)
for (const g of gone) console.log('  removed', g.id, '|', g.comic, '|', g.title, '|', g.why)
if (!DRY) { fs.writeFileSync('clips.json', JSON.stringify(keep, null, 1) + '\n'); fs.writeFileSync(removedPath, JSON.stringify(removed, null, 1) + '\n') }
