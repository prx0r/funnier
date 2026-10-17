# Funnier clip tags (v1): spec for topic heats and compilations

Backend/data spec only. The feed agent implements selection and UI from this; nothing here changes `src/`.

| file | what |
|---|---|
| `schema/topics.json` | controlled, hierarchical topic vocabulary (slash paths) + the keyword cues the tagger matches |
| `schema/clip-tags.schema.json` | JSON Schema (2020-12) for `clip.tags` |
| `tools/tag-clips.py` | rule + title + description tagger; writes `clip.tags`, prints a coverage report |
| `tools/yt-meta.py` | keyless metadata cache (oEmbed, embed-page playability, search-row snippet, Shorts description/keywords) |
| `tools/standup-audit.json` + `tools/apply-audit.py` | stand-up purity / embeddability audit, applied idempotently to `clips.json` |

Always: metadata only (title, channel, duration, description snippet, Shorts keywords). Never transcripts, never bit
text, never downloads. `premise` is a short label in our own words cleaned from the public upload title.

## 1. Clip fields

Top-level fields stay as they are and are not duplicated inside `tags`: `format` (vertical|horizontal), `region`,
`carrier` (own > licensed > unofficial), `sec`, `setting` (feed level: stand-up | talk-show | awards-show | chat; `chat`
is excluded from every feed), `style` (comic-level persona prior from funnygraph).

`clip.tags` (every inferred value is `[value, confidence, source]`, source ∈ `rule | title | desc | manual`):

```json
"tags": {
  "v": 1,
  "topics":   [["family/parents/dads", 0.8, "title"], ["drugs/alcohol", 0.4, "desc"]],
  "premise":  ["Slime Tutorial (no borax)", 0.6, "title"],
  "style":    [["storytelling", 0.7, "title"]],
  "setting":  ["kill-tony", 0.95, "title"],
  "crowdwork": false,
  "lang":     ["en", 0.85, "rule"],
  "year":     [2019, 0.8, "rule"],
  "era":      "2010s",
  "band":     "mid",
  "rating":   ["explicit", 0.75, "title"]
}
```

| field | values | how it is set |
|---|---|---|
| `topics` | most specific nodes of `schema/topics.json`; ancestors implied | keyword cues on the cleaned title (leaf 0.8, inner node 0.7), then description/keywords (0.4) |
| `premise` | ≤ 90 chars or `null` | title segment with the comic's name, channel, show brand and special name removed; null for "Stand Up - 2009", Kill Tony episode numbers etc. |
| `style` | one-liners, storytelling, observational, absurd, dark, deadpan, crowd-work, self-deprecating, rant, physical, act-out, impressions, musical | clip-level cues only (title 0.7, desc 0.4) |
| `setting` | stand-up, club, special, tv-showcase, festival, talk-show-spot, kill-tony, roast, competition, awards-show, chat | channel/title rules (Kill Tony, Netflix/HBO/Comedy Dynamics specials, Apollo/Comedy Central showcases, JFL/Melbourne/NZ festivals, late-night spots) |
| `crowdwork` | bool | crowd-work style cue present |
| `lang` | ISO 639-1 | script/wording of the title, else the comic's region |
| `year` / `era` | performance year / decade | existing `year`, a year in the title, else upload year (src desc, conf ≤ 0.5, an upper bound) |
| `band` | short ≤ 75 s, mid ≤ 180 s, long ≤ 420 s, xl > 420 s | from `sec` |
| `rating` | clean, explicit, unknown | profanity/sex/drug cues → explicit; Dry Bar / "clean" → clean; US network late-night spot → clean 0.55 |

`manual` triples are never overwritten by the tagger: correct a clip by editing its triple and setting the source to
`manual`. Vocabulary changes go in `schema/topics.json` (add a node + cues), then re-run
`python3 tools/tag-clips.py clips.json --meta <cache>/meta.json --report /tmp/tag-report.json`.

## 2. Topic vocabulary

Roots and leaves (heats use leaves; inner nodes work for broader heats):
relationships (dating › apps / first-dates / age-gaps, breakups, cheating, men-vs-women, friendship) · marriage
(weddings, divorce, in-laws) · sex (porn, kinks, stds-contraception) · family (parents › mums / dads, siblings,
grandparents, holidays) · kids (pregnancy-birth, parenting, teenagers) · childhood (bullies, kids-tv-toys) · school
(teachers, college, exams) · work (bosses-office, service-jobs, unemployment) · money (poverty, wealth, shopping) ·
religion (christianity, islam, judaism, atheism) · identity (race › black / white / asian / latino / middle-eastern /
mixed-race, immigration, lgbtq › gay / trans, nationality › americans / british-irish / other-nationalities /
accents-language, gender) · drugs (weed, alcohol, hard-drugs, smoking) · food (restaurants, diets, cooking) · travel
(flying, hotels, driving-transport) · places (us, uk-ireland, world) · animals (dogs, cats, wildlife) · health
(body-weight, mental-health, doctors-hospitals, illness-disability) · death (funerals-grief, suicide, murder-killing) ·
politics (trump, us-politics, uk-politics, guns, war-military, free-speech) · technology (phones, social-media,
ai-gadgets) · aging (generations) · crime (police, prison, theft-violence, true-crime) · sports (football-soccer,
american-sports, fitness) · pop-culture (celebrities, movies-tv, music) · everyday (home-neighbours, weather-seasons,
sleep, manners-etiquette) · comedy-life (hecklers, bombing-gigs, roasts).

## 3. Selecting a topic heat (3- or 4-way)

Input: topic node `T` (leaf preferred), `k ∈ {3, 4}`, the device format preference, optional region scope.

1. **Pool**: active clips (not removed, `setting != "chat"`, not a dupe) with a topic triple whose id is `T` or a
   descendant of `T` and confidence ≥ `minConf` (default **0.6** = title evidence; 0.4 only to fill a pool, and say so in
   the provenance).
2. **Format**: one format per heat. Prefer the device format (mobile → vertical, desktop → horizontal); fall back to the
   other only if the preferred one has < k distinct comics.
3. **One clip per comic**: never two clips from the same comic. Per comic take the clip with the highest topic
   confidence, then carrier own > licensed > unofficial, then not-yet-seen (seen.js), then views.
4. **Similar length**: minimise the duration spread: all in the same `band`, or within ±40 % of the heat's median `sec`.
   `xl`/`needsCut` clips only if every candidate is xl (then play the cut window).
5. **Same setting family where possible**: all `kill-tony`, all `special`/`tv-showcase`/`festival`, or all
   `talk-show-spot`; mixing is allowed when the pool forces it.
6. **Language**: same `lang` as the viewer's locale unless they opted into international clips.
7. **Readiness**: `T` is heat-ready when the pool after steps 1-2 has ≥ 4 distinct comics (a 3-way needs 3; 4 lets a
   heat rotate). `tools/tag-clips.py --report` lists heat-ready leaves and nodes.
8. **Votes**: record a k-way heat as k−1 pairwise results winner-vs-each-loser (or k·(k−1)/2 pairs if the UI ranks all
   k), so the existing Bradley-Terry tally needs no change. Same-comic pairs cannot occur (step 3).

## 4. Compilations ("10 bits about dads")

1. Pool as §3 step 1 (minConf 0.6), one format.
2. Order by topic confidence, then not-yet-seen, then carrier, with a diversity rule: at most one clip per comic per 5
   slots and at most 2 per comic overall.
3. Fill to a length target (e.g. ≤ 10 min) greedily; skip xl clips unless a cut window exists.
4. Title it with the node label; caption each clip with its `premise` (else the comic's name).

## 5. Coverage and next passes

First pass numbers are in the commit message and `tools/tag-clips.py --report`. Next passes: manual triples for the top
comics' clips; descriptions for the horizontal uploads whose search row had no snippet; more cue words for es/de/fr/zh
titles (mostly untagged today).
