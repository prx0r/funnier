# Funnier ⇄ funnygraph

funnygraph (github.com/prx0r/funnygraph) is the source of truth for **comic identity, region, tier, persona style and
every ranking board**. Funnier owns the **clip layer**: which clips exist, their tags, photos and verified specials links.
Nothing funnygraph owns is committed to this repo's master branch.

## 1. Live boards (funnygraph → Funnier)

`tools/sync-funnygraph.mjs` runs in `.github/workflows/funnier.yml` on every deploy (push + every 15 min):

1. Resolves funnygraph `main` to one commit sha (GitHub API, falls back to `git ls-remote`).
2. Fetches, pinned to that sha from raw.githubusercontent.com: `rankings/{ratings,house,consensus,canon,peoples,by_type,
   by_continent,specials,bits,neighbors,spotlight}.json` (bits: metadata only, no prose) and every
   `comedians/<id>/comedian-graph.json` whose git blob changed since the last run (slimmed: identity, region, tier,
   persona tags, channels; no sets, transcripts, bits or essays).
   Also `rankings/{metrics,by_generation}.json` and `data/r2/site_manifest.json` (slimmed to each special's title + year:
   no transcript links, previews or word counts).
3. Checks each file's shape (`tools/fg-lib.mjs` VALIDATE). A missing or malformed file keeps the last good copy.
4. Writes into the published site (gh-pages): `data/funnygraph/meta.json` (sha, sync time, per-file status, errors),
   `data/funnygraph/boards.json` (the slim bundle the site reads), `data/funnygraph/roster.json`, `data/funnygraph/rankings/*`.
   `boards.json` also carries the comic boards in the Charts tab's funnygraph lens: **Style kings** (`by_type`, a style
   picker), **Most underrated / Most overrated** (the verdict gap in `metrics.json`: popularity pct − audience pct, with
   funnygraph's band) and **By era** (`by_generation`, a generation picker). Values and bands are copied, never recomputed;
   positions are list order, not house ranks. They are reference boards (provenance says "ref").
   `data/funnygraph/profiles.json` (lazy-loaded by a comic page, Funnier comics only): specials (title, year, IMDb rating
   from the graph's `specials_rated` filtered to titles naming the comic, `rankings/specials.json`, the R2 manifest; never
   transcripts; a special links only to an official own/licensed upload of it already in clips.json, played on-site),
   For fans of (`neighbors.json`), a Wikidata bio line, style-king (top 3) and verdict-gap badges.
5. Generates the published `comics.json`: Funnier-owned fields from `site/comics.json` + funnygraph identity and ranks.
   Name → id: `fg-map.json` (exceptions), then the `site/comics.json` slug, then a clip's `fg` field, then the slugified name.

It never exits non-zero, so a funnygraph outage cannot block a deploy. The site renders whatever the latest boards say and
shows provenance ("funnygraph house board · <sha7>"). Change a ranking in funnygraph and it is live on www.funnier.si within
one deploy cycle (≈15 min).

Tests: `node tools/test-fg-sync.mjs`.

## 2. Clips for funnygraph comics (Funnier-owned)

`node tools/discover-fg-clips.mjs --roster <pub>/data/funnygraph/roster.json` (run by hand, review, commit) finds clips for
funnygraph comics with no Funnier clips, kings first, then indies with live channels, using only funnygraph's own curated
links (`data/youtube/<id>.json` harvest rows + each comic's registered channel's public /videos page). Keyless, metadata
only, official YouTube embeds only (oEmbed 200), format via `tools/detect-format.mjs`, dedup as in
`tools/merge-c2-corpus.py`. Tags: setting + format + the comic's funnygraph persona tags (`tagsSource: "fg-persona"`).
Each clip records `fg` (comedian_id) and `via` (funnygraph sha + source).

Coverage run (2026-10-18): `--scope people --search --topup 5` covers every comic on the boards (UK/Ireland first, then other
internationals, kings, the rest). Where funnygraph links give too few candidates, the public YouTube search-results page for
"<name> stand up" is read (keyless, metadata only, throttled + retried; any embeddable upload incl. unofficial, still gated on
the title naming the comic, a stand-up cue, <= 10 min, not a panel show/news/promo). Search clips carry `views` and `region`.
`node tools/backfill-style.mjs` stamps `fg`, `region` and the persona style prior on older clips. The boards bundle now also
carries `pop` (funnygraph popularity lens) and `nb` (top vibe neighbours) per comic for the Underdog / Similar Vibes feeds.

## 3. Arena votes (Funnier → funnygraph)

The tally publishes **https://www.funnier.si/data/arena.json** on every deploy, in the shape funnygraph's
`ARENA_BALLOT.md` asks for:

```json
{ "schema": "funnygraph.arena/v1", "updated": "...", "roster": "prx0r/funnygraph@<sha7>",
  "votes": 123, "voters": 45,
  "pairs": [ { "a": "chris-rock", "b": "louis-ck", "a_wins": 17, "b_wins": 26, "n": 43 } ],
  "unmapped": [] }
```

- `a < b` alphabetically; ids are funnygraph `comedian_id`.
- Humans only (agent votes excluded), one vote per voter per clip pair (latest wins), AT Protocol records + the anonymised
  D1 export merged and de-duplicated (`tally/sources.mjs`). Never a same-comic clash. No voter identifiers.
- `unmapped` lists Funnier comics with no funnygraph id (none today).

**How funnygraph consumes it** (owner side; Funnier never pushes there): fetch the URL, e.g. in `bt_leg.py` or a small
`arena_pull.py`, write it to `rankings/arena.json`, and feed `pairs` into the P4 arena leg in `house_rank.py` /
`rank_comedians.py` (Bradley-Terry over `a_wins`/`b_wins`; apply your own `n >= 30` gate). A daily cron is plenty; the file
is regenerated every 15 minutes.

```bash
curl -sf https://www.funnier.si/data/arena.json -o rankings/arena.json
```

Tests: `node tally/test-arena.mjs`.
