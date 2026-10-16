// Humour Passport (src/passport.js) tests: node tools/test-passport.mjs
import fs from 'node:fs'
import * as E from '../src/engine.js'
import * as P from '../src/passport.js'
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clips = J('clips.json').filter((c) => c.status !== 'removed'), T = J('site/theory.json')
const en = E.createEngine({ clips, theory: T })
const norm = clips.filter((c) => c.comic === 'Norm Macdonald'), rock = clips.filter((c) => c.comic === 'Chris Rock')
const votes = norm.slice(0, 8).map((c, i) => ({ a: c.id, b: rock[i].id, winner: c.id, w: 1.25 }))
const f = en.fit(en.samples({ votes }), E.basePrior(), null, { iters: 8 }), ro = E.readout(f.theta, f.sd, f.support)
const p = P.makePassport({ readout: ro, features: E.FEATURES, model: E.ENGINE_MODEL, n: votes.length, favs: ['Norm Macdonald'], topClips: [norm[0]], votes })
ok(p.schema === 'funnier.humour/v1' && Object.keys(p.features).length === E.FK.length && Object.keys(p.axes).length === 9 && /^[0-9a-f]{8}$/.test(p.hash), `passport: ${Object.keys(p.features).length} features, 9 axes, hash ${p.hash}`)
ok(p.type.k === 'deadpan' || p.axes[p.type.k].v >= p.axes.deadpan.v, `type from the strongest axis: ${p.type.full} (${p.type.code})`)
const c = P.cleanPassport(JSON.parse(JSON.stringify(p)))
ok(c && c.hash === p.hash && c.votes.length === 8 && JSON.stringify(c.features) === JSON.stringify(p.features), 'clean(passport) round-trips (same hash, features, opted-in votes)')
ok(P.cleanPassport({ ...p, schema: 'x' }) === null && P.cleanPassport({ ...p, features: {} }) === null, 'non-passports are refused')
const noV = P.cleanPassport(p, { allowVotes: false }); ok(!noV.votes, 'votes can be refused')
const rec = P.passportRecord(p)
const ints = (o) => Object.values(o).every((v) => typeof v !== 'number' || Number.isInteger(v)) && Object.values(o).every((v) => !v || typeof v !== 'object' || (Array.isArray(v) ? v.every((x) => typeof x !== 'object' || ints(x)) : ints(v)))
ok(rec.$type === 'io.github.prx0r.funnier.humour' && ints(rec) && rec.features.length === E.FK.length && rec.history.length === 8, 'AT Protocol record: integers only (lexicons have no floats)')
const pri = P.passportPrior(c), merged = E.mergePrior(E.basePrior(), pri.weights, pri.sd)
ok(merged.mu[E.FK.indexOf('ax_deadpan')] > 0, 'passport -> prior on another device')
const pr = P.passportPrompt(p)
ok(/My humour type: /.test(pr) && /Favourite comedians: Norm Macdonald/.test(pr) && /Tell me jokes/.test(pr) && pr.length < 2500, 'assistant prompt: type, loves, favourites, instruction')
console.log('\n' + pr + '\n')
const lex = J('lexicons/io.github.prx0r.funnier.humour.json'), sch = J('lexicons/funnier.humour.v1.schema.json')
ok(lex.id === 'io.github.prx0r.funnier.humour' && lex.defs.main.key === 'literal:self' && sch.properties.schema.const === P.SCHEMA, 'lexicon + JSON schema present and consistent')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0)
