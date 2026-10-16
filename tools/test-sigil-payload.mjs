// The model drawn + the humour payload + the characters2 handoff: node tools/test-sigil-payload.mjs
import fs from 'node:fs'
import * as E from '../src/engine.js'
import * as P from '../src/passport.js'
import * as G from '../src/sigil.js'
import * as Y from '../src/payload.js'
import { handoff } from '../src/handoff.js'
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clips = J('clips.json').filter((c) => c.status !== 'removed'), T = J('site/theory.json')
const en = E.createEngine({ clips, theory: T })
const pass = (w, n = 30) => { // a passport from given weights (as if trained)
  const theta = E.thetaFromPrior(E.basePrior()); for (const [k, v] of Object.entries(w)) theta[E.FK.indexOf(k)] = v
  const sd = E.FK.map(() => 0.3).concat([0.2, 0.2, 0.2, 0.2, 0.5, 0.5, 0.5]), sup = E.FK.map((k) => (k in w ? 8 : 2))
  return P.makePassport({ readout: E.readout(theta, sd, sup), features: E.FEATURES, model: E.ENGINE_MODEL, n, favs: ['Norm Macdonald'] })
}
const a = pass({ ax_selfdep: 1.2, hold: 0.9 }), b = pass({ ax_dark: 1.3, energy: 1.1 }), z = pass({}, 0)
ok(G.typeName(a).name === 'The Slow-Burn Confessor' && G.typeName(b).name === 'The Escalation Ghoul', `computed names: ${G.typeName(a).name}, ${G.typeName(b).name}`)
ok(G.typeName(z).name === 'The Open Book', 'no votes: The Open Book')
const ga = G.glyphSVG(a, { labels: true }), gz = G.glyphSVG(z)
ok(ga.includes('<svg') && (ga.match(/<line /g) || []).length >= 9 && !/>[^<]*\d[^<]*</.test(ga.replace(/<text[^>]*>[^<]*<\/text>/g, (t) => (/\d/.test(t.replace(/<[^>]+>/g, '')) ? 'NUM' : ''))), 'glyph: enneagram figure (9+ edges), no numbers in any label')
ok(ga !== G.glyphSVG(b) && ga === G.glyphSVG(a, { labels: true }), 'glyph is deterministic per passport and differs between people')
ok(gz.includes('<svg'), 'an empty model still draws (degrades gracefully)')
const M = Object.fromEntries(G.metaAxes(b).map((m) => [m.k, m]))
ok(M.delivery.v > 0.2 && M.risk.v > 0.2 && G.metaAxes(a).find((m) => m.k === 'pace').v < 0, `meta-axes: escalation ghoul -> manic ${M.delivery.v.toFixed(2)}, transgressive ${M.risk.v.toFixed(2)}; slow-burn -> slow pace`)
ok(G.metaSVG(a).includes('slow-burn') && G.netSVG(a).includes('you laugh / rewind'), 'meta-axes + net render from the passport')
const fromJSON = JSON.parse(JSON.stringify(a)); ok(G.glyphSVG(fromJSON, { labels: true }) === ga, 'renders identically from exported JSON')
const mid = G.lerpPassport(a, b, 0.5); ok(Math.abs(mid.features.ax_dark.w - (a.features.ax_dark.w + b.features.ax_dark.w) / 2) < 1e-9 && G.diffPassports(a, b)[0].k, 'versions: morph interpolates weights; diff ranks the biggest moves')
const t = Y.humourPayload(b)
ok(/## Lean into[\s\S]*dark turns: strong/.test(t) && /## Avoid/.test(t) && /## Do\n- go to dark places/.test(t) && /"hash":"[0-9a-f]{8}"/.test(t), 'payload: lean-ins with strengths, do list from the weights, compact JSON with the version hash')
ok(Y.chatgptURL(t)?.startsWith('https://chatgpt.com/?q=') && Y.chatgptURL('x'.repeat(9000)) === null, 'Open in ChatGPT: ?q= when it fits, copy otherwise')
ok(/You are Gus \(a ghoul\)/.test(Y.humourPayload(b, { as: { name: 'Gus', bio: 'a ghoul' } })), 'payload as a character ("Prompt them")')
const h = handoff(b, { id: 'cabc12345', name: 'Gus' }, T), sum = Object.values(h.operator_priors).reduce((s, x) => s + x, 0)
ok(h.schema === 'funnier.character-handoff/v1' && Math.abs(sum - 1) < 0.01 && h.delivery.energy > 0.8 && h.style.lean[0] === 'dark' && h.archetype === 'mock_indignant_engine' && h.character.url.endsWith('/c/cabc12345'), `characters2 handoff: operator priors sum to 1, energy ${h.delivery.energy}, archetype ${h.archetype}`)
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
