// Humour payload: the precise weights of a Humour Passport turned into an LLM context block, so ChatGPT / Claude can
// joke in your style and write funny cards, captions and messages for you (or speak AS a trained character).
// A plain-language rule set derived from the weights (lean-ins and avoids with strengths, delivery and pace,
// comic moves, anchors, do / don't), then the compact JSON. Pure; versioned by the passport's hash.
import { typeName, metaAxes } from './sigil.js'

const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const arr = (x) => (Array.isArray(x) ? x : [])
const strength = (w) => { const a = Math.abs(w); return a >= 1 ? 'strong' : a >= 0.5 ? 'moderate' : 'mild' }
// per-feature rules: [lean-in do, avoid don't] (the sign of the weight picks which list it lands in)
const RULE = {
  ax_absurd: ['commit to absurd premises and anti-jokes; let the logic go somewhere strange and stay there', 'go fully surreal; keep jokes anchored in real logic'],
  ax_deadpan: ['deliver the funniest lines with a completely straight face; never wink at the joke', 'play everything bone-dry; show some delight'],
  ax_observational: ['find the joke in everyday details everyone has noticed and nobody said', 'lean on "have you ever noticed" material'],
  ax_dark: ['go to dark places (death, failure, taboo) when the joke earns it', 'go dark or morbid; keep it light'],
  ax_story: ['build longer stories with a payoff that lands late; set up callbacks', 'make long winding stories; get to the laugh'],
  ax_wordplay: ['write tight one-liners and wordplay; every word earns its place', 'rely on puns and wordplay'],
  ax_rant: ['build righteous rants that escalate about small injustices', 'rant or lecture; stay playful'],
  ax_selfdep: ['make yourself the target; confess embarrassing things', 'lean on self-deprecation'],
  ax_crowd: ['riff on the person in front of you, like crowd work: specific, quick, affectionate', 'single the reader out; keep the focus on the material'],
  energy: ['bring high energy: escalate, get loud on the page', 'shout or go manic; keep the energy low-key'],
  hold: ['leave long pauses before the punchline (a line break, a beat, an ellipsis)', 'linger; keep it quick-fire'],
  pace: ['use short, punchy sentences', 'chop everything into fragments; let sentences breathe'],
  clean: ['keep it clean and clever', 'sanitise everything; a bit of edge is welcome'],
  long: ['allow longer bits', 'run long; keep it short'],
  vertical: ['write for short-form (a few lines, one hit)', 'cram everything into one line'],
  talkshow: ['use a polished late-night monologue feel', 'sound like a talk-show monologue'],
  op_split_knowledge: ['use dramatic irony: let the audience know something the character does not', null],
  op_repeat_variation: ['use callbacks and repetition with a twist', null],
  op_double_interpret: ['use double meanings and reinterpretation of a phrase', null],
  op_status_invert: ['flip status: the powerful humiliated, the lowly triumphant', null],
  op_rigidify: ['show people behaving like machines, rigidly applying a rule', null],
  op_juxtapose: ['pair things that do not belong together', null],
  op_literalize: ['take figures of speech literally', null],
  op_false_analogy: ['use confident bogus logic', null],
  op_expose_self_blindness: ['expose people who are blind to themselves', null],
  op_unmask: ['unmask pretence and hypocrisy', null],
}
// p: passport; opts.as: { name, bio } to frame it as a character to speak as; opts.task: what to do with it
export function humourPayload(p, opts = {}) {
  const F = Object.entries(p?.features || {}).map(([k, f]) => ({ k, ...f })).filter((f) => Number.isFinite(f.w) && (f.n || 0) > 0)
  const conf = (f) => (f.sd != null && f.sd > 0.55 ? ', tentative' : '')
  const lean = F.filter((f) => f.w >= 0.15).sort((a, b) => b.w - a.w), avoid = F.filter((f) => f.w <= -0.15).sort((a, b) => a.w - b.w)
  const tn = typeName(p), M = metaAxes(p).filter((m) => m.has && Math.abs(m.v) >= 0.15)
  const dos = lean.map((f) => RULE[f.k]?.[0]).filter(Boolean).slice(0, 6), donts = avoid.map((f) => RULE[f.k]?.[1]).filter(Boolean).slice(0, 5)
  const who = opts.as ? `${opts.as.name}${opts.as.bio ? ` (${opts.as.bio})` : ''}` : 'me'
  const L = []
  L.push(`# Humour payload (Funnier Humour Passport ${p?.schema || 'funnier.humour/v1'}, version ${p?.hash || '?'}, ${p?.n?.votes ?? 0} votes, ${String(p?.created || '').slice(0, 10)})`)
  L.push(opts.as ? `You are ${who}. This is your sense of humour, learned from head-to-head votes between real stand-up clips. Joke, react and write AS ${opts.as.name}, in this taste.`
    : 'This is my sense of humour, learned from my head-to-head votes between real stand-up clips. Use it whenever you joke with me or write funny things for me (cards, captions, toasts, messages).')
  L.push(`Humour type: ${tn.name}${p?.type?.full ? ` (${p.type.full})` : ''}.`)
  L.push('', '## Lean into (strongest first)')
  L.push(...(lean.length ? lean.slice(0, 8).map((f) => `- ${f.label}: ${strength(f.w)}${conf(f)}`) : ['- nothing strongly yet: keep it broad']))
  L.push('', '## Avoid / bounces off')
  L.push(...(avoid.length ? avoid.slice(0, 6).map((f) => `- ${f.label}: ${strength(f.w)}${conf(f)}`) : ['- nothing clearly disliked yet']))
  if (M.length) { L.push('', '## Delivery, structure and pace'); L.push(...M.map((m) => `- ${m.label}: toward ${m.v > 0 ? m.hi : m.lo} (${Math.abs(m.v) >= 0.5 ? 'clearly' : 'slightly'})`)) }
  const anchors = [...arr(p?.favs), ...arr(p?.topComics).map((c) => c.comic)].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 4)
  if (anchors.length || arr(p?.topClips).length) {
    L.push('', '## Anchors')
    if (anchors.length) L.push(`- Comedians ${opts.as ? 'you' : 'I'} rate: ${anchors.join(', ')}`)
    if (arr(p?.topClips).length) L.push(`- Bits that landed: ${p.topClips.slice(0, 3).map((c) => `"${c.title}" (${c.comic})`).join('; ')}`)
  }
  L.push('', '## Do', ...(dos.length ? dos.map((x) => '- ' + x) : ['- keep it surprising and specific']))
  L.push('', "## Don't", ...(donts.length ? donts.map((x) => '- ' + x) : ['- explain the joke']), '- explain the joke or add "haha"')
  L.push('', '## How to use this', `- ${opts.task || 'When asked for jokes, cards or funny copy: write 3 options in this style, then say in a few words which traits each one uses.'}`, '- Strengths marked tentative rest on few votes: treat them as hints.')
  const compact = { schema: p?.schema, hash: p?.hash, model: p?.model, votes: p?.n?.votes ?? 0, type: tn.name, w: Object.fromEntries(F.map((f) => [f.k, Math.round(f.w * 100) / 100])), meta: Object.fromEntries(metaAxes(p).filter((m) => m.has).map((m) => [m.k, Math.round(m.v * 100) / 100])) }
  L.push('', '## Compact model (JSON)', JSON.stringify(compact))
  return L.join('\n')
}
// "Open in ChatGPT": the ?q= prefill when it fits a safe URL length, else null (copy instead)
export const CHATGPT_MAX_URL = 7000
export function chatgptURL(text) { const u = 'https://chatgpt.com/?q=' + encodeURIComponent(text); return u.length <= CHATGPT_MAX_URL ? u : null }
// a shorter payload for the URL prefill: drop the anchors and compact JSON first
export function shortPayload(p, opts = {}) {
  const full = humourPayload(p, opts)
  return full.replace(/\n## Anchors[\s\S]*?(?=\n## Do\n)/, '').replace(/\n## Compact model \(JSON\)\n.*$/s, '')
}
