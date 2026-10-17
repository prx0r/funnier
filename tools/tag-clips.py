#!/usr/bin/env python3
"""Granular clip tagging for Funnier (TAGS.md, schema/clip-tags.schema.json, schema/topics.json).

Metadata only: title, channel, duration, YouTube description snippet and Shorts description/keywords (cache built by
tools/yt-meta.py). Never transcripts, never bit text.

usage (from funnier/): python3 tools/tag-clips.py clips.json [--meta meta.json] [--report report.json]
Writes clip.tags (v1) in place. Re-runnable: triples with source "manual" are never overwritten; desc-sourced topics
are kept when the meta cache has no entry for a clip.
"""
import json, re, sys, os, unicodedata, collections as C

def dump_clips(clips, path):
    """clips.json layout: indent=1 like the rest of the repo, but each clip's tags object on a single line."""
    out = []
    for c in clips:
        cc = dict(c)
        t = cc.get('tags')
        if t is not None: cc['tags'] = '\u0000TAGS\u0000'
        s = json.dumps(cc, indent=1, ensure_ascii=False)
        if t is not None: s = s.replace(json.dumps('\u0000TAGS\u0000'), json.dumps(t, ensure_ascii=False, separators=(',', ':')))
        out.append('\n'.join(' ' + l for l in s.split('\n')))
    open(path, 'w').write('[\n' + ',\n'.join(out) + '\n]\n')


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
args = sys.argv[1:]
path = args[0]
meta_path = args[args.index('--meta') + 1] if '--meta' in args else None
report_path = args[args.index('--report') + 1] if '--report' in args else None
clips = json.load(open(path))
META = json.load(open(meta_path)) if meta_path and os.path.exists(meta_path) else {}
VOC = json.load(open(os.path.join(ROOT, 'schema', 'topics.json')))

# ---- vocabulary -> compiled patterns
NODES = {}  # id -> (regex|None, is_leaf)
def walk(n, pre=''):
    for k, v in n.items():
        if k == 'kw': continue
        nid = pre + k
        kids = [x for x in v if x != 'kw']
        kw = v.get('kw') or []
        rx = re.compile(r'(?<![\w#])(' + '|'.join(kw) + r')(?![\w])', re.I) if kw else None
        NODES[nid] = (rx, not kids)
        walk(v, nid + '/')
walk(VOC['tree'])

BRANDS = re.compile(r"netflix|live at the apollo|universal comedy|comedy central|\bbbc\b|avalon|baby cow|sky tv|just for laughs|dry bar|comedy time|don't tell|stand-?up on the spot|next ?up|comedy dynamics|\bhbo\b|conan|tonight show|late show|late late show|team coco|laugh factory|this is not happening|comedy greats|jokes on us|comedy store|comedy cellar|kill tony|melbourne|comedy festival|comedy gala|comedy allstars|best foods|stand up comedy|standup comedy|stand-up comedy|comedy special|full set|stand-up featuring|up next|\bclip\b|official|uncensored|extended|\bpart \d|\(\d+ of \d+\)|comedy club|showcase|^\s*\d{4}\s*$|chickcomedy|stand-up,? asia|xiaoguo|comedy bloomers|angel comedy|hot water comedy|chris ramsey|new faces of comedy|comedy in color|laugh out loud|lol standup|def comedy jam|chappelle's home team|throwback|best of stand-up|el club de la comedia|la pelota de letras|comédie\+|jamel comedy club|montreux|nightwash|1live|myspass|casa comedy|now comedy", re.I)
GENERIC_HASH = re.compile(r'#(comedy|comedian|comedians|standup|standupcomedy|standupcomedian|standups|standupclips|stand_up|funny|funnyvideos|shorts|short|viral|fyp|fypシ|foryou|foryoupage|explore|jokes?|humor|humour|lol|laughs?|live|tour|reels|haha|hilarious|comic|netflix|comedyshorts|crowdwork|crowd_work|killtony|\w*normand\w*|\w*rocket\w*|tbt|throwback|new|podcast)\b', re.I)
URL = re.compile(r'https?://\S+|www\.\S+|\S+\.(com|co\.uk|net)\S*', re.I)
PROMO_LINE = re.compile(r"subscribe|follow|tickets?|tour|instagram|tiktok|twitter|facebook|patreon|merch|website|watch (the )?(full|more|now)|streaming|available|link in bio|stream it|out now|get the book|socials|podcast|provided to youtube|about netflix|netflix is|comedy central|youtube channel|official channel|check (it )?out|apple tv|amazon|prime video|itunes|spotify|directv|spectrum|download|listen|new episodes|is the home of|world's leading|presents|℗|auto-generated|copyright|all rights", re.I)

def deaccent(s):
    return ''.join(ch for ch in unicodedata.normalize('NFD', s) if unicodedata.category(ch) != 'Mn')

def names(c):
    n = c['comic']
    out = {n, n.replace('.', ''), n.replace(' ', ''), deaccent(n), n.replace(' O ', " O'"), n.replace(' D ', " D'"), n.replace('. ', '.'),
           deaccent(n).replace(' O ', " O'"), deaccent(n).replace(' O ', " O\u2019")}
    parts = n.split()
    if len(parts) > 1 and len(parts[-1]) > 2: out.add(parts[-1])
    if len(parts) > 1: out.add(parts[0] + ' ' + parts[-1])
    return sorted([x for x in out if len(x) > 2], key=len, reverse=True)

def strip_names(s, c):
    for n in names(c):
        s = re.sub(re.escape(n) + r"('s|’s)?", ' ', s, flags=re.I)
    return s

SPLIT = re.compile(r'\s+[|–—]\s+|\s+-\s+|\s*\|\s*|\s+l\s+(?=[A-Z])')

def title_segments(c):
    t = GENERIC_HASH.sub(' ', c['title'])
    out = []
    for s in SPLIT.split(t):
        s0 = s.strip()
        if not s0: continue
        if c.get('channel') and s0.lower() == c['channel'].lower(): continue
        s1 = strip_names(s0, c).strip()
        if re.match(r'^[:\-–]', s1): continue  # "<Comic>: <Special name>"
        if BRANDS.search(s1) and len(s1.split()) <= 6: continue
        if not re.search(r'\w', s1): continue
        out.append(s1)
    return out

def desc_text(c):
    m = META.get(c['id']) or {}
    parts = []
    sh = m.get('shorts') or {}
    if sh.get('description'): parts.append(sh['description'])
    if (m.get('desc') or {}).get('snippet'): parts.append(m['desc']['snippet'])
    kws = [k for k in (sh.get('keywords') or []) if not re.search(r'comed|stand ?up|funny|laugh|' + re.escape(c['comic'].split()[-1]), k, re.I)]
    txt = []
    for p in parts:
        for line in re.split(r'[\n.!?]+', p):
            line = URL.sub(' ', line)
            if PROMO_LINE.search(line): continue
            txt.append(line)
    s = strip_names(' '.join(txt), c)
    s = GENERIC_HASH.sub(' ', s)
    return s[:600], kws

def match_topics(text):
    return [nid for nid, (rx, leaf) in NODES.items() if rx and rx.search(text)]

STYLE_CUES = [
 ('crowd-work', r'crowd ?work|crowdwork|heckl|audience|crowd (asks|yells|suggestions)|in the crowd|from the crowd|riff(ing|s)? (with|on|about|it up)|\briff(s|ing)?\b|zing(s|ing|ers)?|on stage!|surrounded|roasts? (the )?audience|front row|1\. reihe|stand-?up on the spot|suots|crowd'),
 ('one-liners', r'one-?liners?|zingers|limericks|short jokes|\bpuns?\b|joke of the ?week|five minutes of jokes|in (four|six) jokes'),
 ('storytelling', r'\bstory\b|stories|that (one )?time|the time i|the night i|the day (i|the)|how i (got|was|became|met)|when i|i (was|got|went|almost)|my (first|worst)|almost|this is not happening|true love story|what happened'),
 ('observational', r'\bwhy (do|are|is|does|did)\b|\bwhat(\'s| is) the deal\b|ever notice|is (so )?(weird|ridiculous|insane)|\bthe (problem|truth) with\b|is the worst|are the worst|is like|things about|vs\.?|people who|\bthe difference between\b|nobody|everybody|everyone'),
 ('rant', r'\brant\b|hates?\b|sick of|can\'?t stand|is (not happy|terrified|confused|baffled)|rage|outraged|destroys?\b|goes scorched|tired of|refuses|complain|whing|moan|enojate|angry|mad at|i hate|fuck'),
 ('dark', r'dead|death|dying|suicid|murder|kill(ed|er|ing)|cancer|holocaust|hitler|nazi|abortion|shoot(ing|er)|rape|pedophil|molest|9/11|funeral|tragedy|gas chamber|dahmer|serial killer|miscarriage|disab|necroph|n\*crophilia|epstein|dark'),
 ('self-deprecating', r"\bi('m| am) (so |too |not )?(fat|ugly|bad|old|easy|single|lonely|a loser|gay|black|broke|stupid|awkward)|my (weight|body|looks|face|failure|bald)|i suck|my life is|embarrass(es|ed|ing) (himself|herself|myself)|i('m| am) not good|bad at life|loser|failing|failed|pathetic|insecure"),
 ('impressions', r'impression|impersonat|does (every|an?) .*accent|accents?\b|voices'),
 ('act-out', r'act(s|ing)? out|re-?enact|mimes?|dances?|dancing|as a clown|robocop'),
 ('physical', r'physical|slapstick|falls? (down|over)|pratfall|fat man falling|clown|stool'),
 ('musical', r'\bsongs?\b|\bsings?\b|singing|musical|\brap\b|anthem|guitar|piano|drummer|music(al)? comedy|limericks|karaoke'),
 ('absurd', r'absurd|surreal|weird|bizarre|unhinged|riff|nonsense|alien|ufo|robot|mermaid|crab|goose|grimace|wizard|slime'),
 ('deadpan', r'deadpan|monotone'),
]
STYLE_RX = [(s, re.compile(p, re.I)) for s, p in STYLE_CUES]

EXPLICIT_RX = re.compile(r"\bf+u+c+k|f\*+c?k|\bshit|\bcunt|\bdick|d\*cks?|\bcock\b|\bpussy|p\*ssy|\bporn|\bsex\b|horny|orgasm|anal|pegging|fist|fingered|\bcum|tits|boobs|\bbang(ed)?\b|n-word|nigg|n\*+as|faggot|\bslut|uncensored|explicit|nsfw|\b18\+|strippers?|penis|p\*nis|vagina|erection|gloryhole|r\*mming|whore|bitch|\bass\b|asshole|blow ?job|\bstds?\b|weed|cocaine|\bcoke\b|crack|b-hole|butt model|fart|poop|pooped|soiled|knitted poo", re.I)
CLEAN_CHANNELS = re.compile(r'dry bar|clean comedy|jeff foxworthy|brian regan|nate bargatze', re.I)

LANG_RX = [
 ('zh', re.compile(r'[\u4e00-\u9fff]')), ('ja', re.compile(r'[\u3040-\u30ff]')), ('ko', re.compile(r'[\uac00-\ud7af]')),
 ('el', re.compile(r'[\u0370-\u03ff]')), ('he', re.compile(r'[\u0590-\u05ff]')),
 ('es', re.compile(r'\b(el|la|los|las|de|del|que|con|para|una?|mi|por|es|y|monólogo|comedia|humor)\b.*\b(el|la|los|las|de|que|con|para|mi|por|es|y)\b|[ñ¡¿]', re.I)),
 ('pt', re.compile(r'\b(do|da|no|na|não|com|comédia|especial de|um|uma|os|seu)\b.*\b(do|da|de|no|na|com|os)\b|[ãõ]', re.I)),
 ('de', re.compile(r'\b(der|die|das|und|ist|nicht|ein|eine|mit|für|ich|haben|sind|man|darf)\b.*\b(der|die|das|und|ist|nicht|ein|mit|für|man|sind)\b|[äöüß]', re.I)),
 ('fr', re.compile(r"\b(le|les|des|est|une?|et|du|à|pour|petits|mensonges|quotidien|gens|sont|cons)\b.*\b(le|la|les|des|est|du|à|sont)\b|[àâçèéêëîïôûù]", re.I)),
]
REGION_LANG = {'spain': 'es', 'mexico': 'es', 'argentina': 'es', 'colombia': 'es', 'chile': 'es', 'germany': 'de', 'austria': 'de',
               'france': 'fr', 'china': 'zh', 'taiwan': 'zh', 'brazil': 'pt', 'portugal': 'pt', 'japan': 'ja', 'korea': 'ko'}
REGION_EN = {'us', 'uk', 'ireland', 'canada', 'australia', 'new-zealand', 'nigeria', 'south-africa', 'malaysia', 'india', 'singapore', 'jamaica', 'scotland', 'wales'}

def lang_of(c):
    t = c['title']
    for code, rx in LANG_RX[:5]:
        if rx.search(t): return code, 0.95, 'title'
    reg = c.get('region')
    for code, rx in LANG_RX[5:]:
        if rx.search(t):
            if REGION_LANG.get(reg) == code: return code, 0.9, 'title'
            if reg not in REGION_EN: return code, 0.7, 'title'
    if reg in REGION_LANG: return REGION_LANG[reg], 0.6, 'rule'
    if reg == 'india':
        if re.search(r'\b(hai|kya|mein|ki|ka|yaar|kitne|bolo|chahiye)\b', t, re.I): return 'hi', 0.7, 'title'
        return 'en', 0.5, 'rule'
    return 'en', (0.85 if reg in REGION_EN else 0.6), 'rule'

SPECIAL_CH = re.compile(r'netflix|hbo|comedy dynamics|universal comedy|800 pound|comedy central stand-up|sky tv|amazon|prime video|showtime|starz|stand-up special', re.I)
TVSHOW = re.compile(r'live at the apollo|comedy central (presents|live|uk|at)|this is not happening|def comedy jam|dry bar|don.t tell comedy|nextup|next up comedy|comedy time|stand-?up on the spot|laugh factory|this week at the comedy cellar|stand-up featuring|up next|half hour|comedy roadshow|the stand up show|comedy up late|stand-up, asia|midnight special|smothers brothers|evening at the improv|saturday live|friday night live|jonathan ross. comedy club|stand up central|el club de la comedia|jamel comedy club|nightwash|1live|comedy-nacht|la pelota de letras|comedy in color|kings of comedy|chocolate sundaes|comedy unleashed|angel comedy|hot water comedy|cracked comedy club|live from the belly room|chickcomedy|xiaoguo|comedy works|helium|comic strip live|ice house|comedy store|comedy cellar|gotham comedy club|comix|the improv|the stand comedy club|comedy club', re.I)
FEST = re.compile(r'just for laughs|\bjfl\b|melbourne|micf|comedy festival|edinburgh|fringe|nz intl|best foods comedy gala|comedy gala|allstars supershow|montreux|netflix is a joke: the festival|ha comedy festival|bend comedy festival|moontower|sydney comedy|chortle student', re.I)
ROAST = re.compile(r'\broast of\b|roast comebacks|torching 20\d\d|the roast', re.I)
COMP = re.compile(r'\bagt\b|got talent|competition|crowd.s choice|award final|king of stand-?up', re.I)
TALK = re.compile(r'tonight show|late show|late night|late late show|conan|letterman|carson|jimmy kimmel|jack paar|steve allen|arsenio|dick clark|wogan|bruce forsyth|good evening|the nightly show|altas horas|esquenta|la revuelta', re.I)

def setting_of(c):
    t = c['title'] + ' || ' + c['channel']
    if c.get('setting') == 'chat': return 'chat', 0.9, 'manual'
    if re.search(r'kill ?tony|\bKT ?#?\d|killtony', t, re.I): return 'kill-tony', 0.95, 'title'
    if ROAST.search(t): return 'roast', 0.85, 'title'
    if COMP.search(t): return 'competition', 0.8, 'title'
    if c.get('setting') == 'talk-show' or TALK.search(t): return 'talk-show-spot', 0.9, 'rule'
    if c.get('setting') == 'awards-show': return 'awards-show', 0.9, 'rule'
    if FEST.search(t): return 'festival', 0.85, 'title'
    if c.get('special_id') or c.get('special_ref') or c.get('venue') == 'special' or SPECIAL_CH.search(c['channel']) or re.search(r'\bspecial\b|netflix', t, re.I):
        return 'special', 0.75, 'rule'
    if TVSHOW.search(t):
        return ('club' if re.search(r'club|helium|comix|improv|ice house|store|cellar|works', t, re.I) else 'tv-showcase'), 0.75, 'title'
    return 'stand-up', 0.5, 'rule'

def year_of(c):
    if c.get('year'): return c['year'], 0.8, 'rule'
    m = re.search(r'(?<!\d)(19[5-9]\d|20[0-2]\d)(?!\d)', c['title'])
    if m: return int(m.group(1)), 0.75, 'title'
    m = re.search(r"'(\d\d)\b", c['title'])
    if m and int(m.group(1)) > 50: return 1900 + int(m.group(1)), 0.6, 'title'
    md = META.get(c['id']) or {}
    pd = (md.get('shorts') or {}).get('publishDate')
    if pd:
        m = re.search(r'(20\d\d)', pd)
        if m: return int(m.group(1)), 0.5, 'desc'  # upload year (upper bound for performance year)
    pub = (md.get('desc') or {}).get('published') or ''
    m = re.match(r'(\d+) (yr|year|years|mo|month|months|week|weeks|day|days)', pub)
    if m:
        n = int(m.group(1)); unit = m.group(2)
        return 2026 - (n if unit.startswith(('yr', 'year')) else 0), 0.35, 'desc'
    return None, 0, None

def dur_band(s):
    if not s: return None
    return 'short' if s <= 75 else 'mid' if s <= 180 else 'long' if s <= 420 else 'xl'

GENERIC_P = re.compile(r"\b(stand[- ]?up|standup|comedy|comedian|comic|comedians|live|show|set|full|clip|special|part|at|the|a|an|on|in|of|and|with|from|best|funny|hilarious|very|performs?|performing|appearance|first|rare|footage|vintage|classic|hd|vhs|official|new|old|tv|\d+)\b", re.I)
LEAD_VERB = re.compile(r"^(on|talks?( about)?|talking( about)?|tells?|performs|does|reveals|wonders if|has|is|explains|thinks|admits|understands|describes|discusses|shares|jokes about|riffs on)\b\s*", re.I)
EMOJI = re.compile('[\U0001F000-\U0001FFFF\u2600-\u27BF\uFE0F]+')
NOT_PREMISE = re.compile(r'\bkill tony\b|\bep\.? ?\d+|\bKT ?#|60 seconds|full segment|opening night|comedy gala|comedy festival|allstars|supershow|comedy up late|upfront 20', re.I)
STRIP_CH = ' -:|,!.?"\u201c\u201d\''

def premise_of(c):
    """Short bit label from the public upload title, the comic's name and channel/brand boilerplate removed."""
    squash = lambda x: re.sub(r'[^a-z]', '', deaccent(x).lower())
    for s in SPLIT.split(GENERIC_HASH.sub(' ', c['title'])):
        p = re.sub(r'#\w+', '', s)
        p = EMOJI.sub('', p)
        p = re.sub(r'\s+', ' ', p).strip(STRIP_CH)
        if c.get('channel') and p.lower() == c['channel'].lower(): continue
        for n in names(c):  # drop the comic's own name only at the start/end ("Bill Burr Is Glad..." -> "Glad...")
            if deaccent(p).lower().startswith(deaccent(n).lower()) and len(deaccent(p)) == len(p):
                p = re.sub(r"^('s|\u2019s)?[:\s]*", '', p[len(n):])
            p = re.sub(r'^' + re.escape(n) + r"('s|\u2019s)?[:\s]*", '', p, flags=re.I)
            p = re.sub(r'\s*[-:]?\s*' + re.escape(n) + r'\s*$', '', p, flags=re.I)
        if p.startswith(':'): continue
        if squash(p) and squash(p) in squash(c['comic']): continue
        p = LEAD_VERB.sub('', p).strip(STRIP_CH)
        if len(p) < 4 or len(p.split()) > 14: continue
        content = [w for w in GENERIC_P.sub(' ', p).split() if re.search(r'[A-Za-z\u00C0-\u024F\u4e00-\u9fff]{2,}', w)]
        if not content: continue
        if NOT_PREMISE.search(p): continue
        if BRANDS.search(p) and len(p.split()) <= 4: continue
        if re.search(r'\b(stand ?-?up|comedian|comedy)\b', p, re.I) and len(content) <= 1: continue
        return p[:90]
    return None

def T3(v, c, s):
    return [v, round(c, 2), s]

def old_list(old, key):
    return [x for x in (old.get(key) or []) if isinstance(x, list) and len(x) == 3]

def tag(c):
    old = c.get('tags') or {}
    ttext = ' . '.join(title_segments(c))
    dtext, kws = desc_text(c)
    have_meta = c['id'] in META
    topics = {}
    for nid in match_topics(ttext):
        topics[nid] = (0.8 if NODES[nid][1] else 0.7, 'title')
    for nid in match_topics(dtext + ' . ' + ' . '.join(kws)):
        if nid not in topics: topics[nid] = (0.4, 'desc')
    for t, cf, sr in old_list(old, 'topics'):
        if sr == 'manual' or (sr == 'desc' and not have_meta and t not in topics): topics[t] = (cf, sr)
    # keep only the most specific nodes: an ancestor is implied by its descendants
    for nid in list(topics):
        for other in list(topics):
            if other != nid and other.startswith(nid + '/') and topics[other][0] >= topics[nid][0] - 0.1:
                topics.pop(nid, None); break
    tl = sorted((T3(k, v[0], v[1]) for k, v in topics.items()), key=lambda x: (-x[1], x[0]))

    styles = {}
    for st, rx in STYLE_RX:
        if rx.search(c['title']): styles[st] = (0.7, 'title')
        elif rx.search(dtext): styles.setdefault(st, (0.4, 'desc'))
    for t, cf, sr in old_list(old, 'style'):
        if sr == 'manual': styles[t] = (cf, sr)
    sl = sorted((T3(k, v[0], v[1]) for k, v in styles.items()), key=lambda x: (-x[1], x[0]))

    if EXPLICIT_RX.search(c['title']): rating = ('explicit', 0.75, 'title')
    elif EXPLICIT_RX.search(dtext): rating = ('explicit', 0.5, 'desc')
    elif CLEAN_CHANNELS.search(c['channel']) or re.search(r'\bclean\b', c['title'], re.I): rating = ('clean', 0.75, 'rule')
    elif c.get('setting') == 'talk-show' or TALK.search(c['title'] + ' ' + c['channel']): rating = ('clean', 0.55, 'rule')  # US network late-night standards
    elif 'clean' in (c.get('style') or []): rating = ('clean', 0.4, 'rule')
    else: rating = ('unknown', 0, 'rule')
    orr = old.get('rating')
    if isinstance(orr, list) and len(orr) == 3 and orr[2] == 'manual': rating = tuple(orr)

    op = old.get('premise')
    if isinstance(op, list) and len(op) == 3 and op[2] == 'manual': prem = op
    else:
        p = premise_of(c)
        prem = T3(p, 0.6, 'title') if p else None
    yr = year_of(c)
    sec = c.get('sec') or c.get('dur') or ((META.get(c['id']) or {}).get('embed') or {}).get('dur')
    return {
        'v': 1,
        'topics': tl,
        'premise': prem,
        'style': sl,
        'setting': T3(*setting_of(c)),
        'crowdwork': 'crowd-work' in styles,
        'lang': T3(*lang_of(c)),
        'year': T3(*yr) if yr[0] else None,
        'era': (str(yr[0] // 10 * 10) + 's') if yr[0] else None,
        'band': dur_band(sec),
        'rating': T3(*rating),
    }

def leaves_of(tags, min_c=0.0):
    return [t for t, cf, sr in tags['topics'] if NODES.get(t, (None, False))[1] and cf >= min_c]

for c in clips:
    c['tags'] = tag(c)
dump_clips(clips, path)

# ---- coverage report (active feed clips: not removed, not chat)
act = [c for c in clips if c.get('status') != 'removed' and c.get('setting') != 'chat']
n = len(act)
pct = lambda k: round(100 * k / n, 1) if n else 0
rep = {
 'clips': n,
 'with_topic': pct(sum(1 for c in act if c['tags']['topics'])),
 'with_topic_title_conf': pct(sum(1 for c in act if any(cf >= 0.6 for _, cf, _ in c['tags']['topics']))),
 'with_leaf': pct(sum(1 for c in act if leaves_of(c['tags']))),
 'with_leaf_title_conf': pct(sum(1 for c in act if leaves_of(c['tags'], 0.6))),
 'with_premise': pct(sum(1 for c in act if c['tags']['premise'])),
 'with_clip_style': pct(sum(1 for c in act if c['tags']['style'])),
 'crowdwork': pct(sum(1 for c in act if c['tags']['crowdwork'])),
 'rating_known': pct(sum(1 for c in act if c['tags']['rating'][0] != 'unknown')),
 'rating': C.Counter(c['tags']['rating'][0] for c in act).most_common(),
 'year_known': pct(sum(1 for c in act if c['tags']['year'])),
 'year_from_title_or_field': pct(sum(1 for c in act if c['tags']['year'] and c['tags']['year'][2] in ('title', 'rule'))),
 'lang': C.Counter(c['tags']['lang'][0] for c in act).most_common(),
 'setting': C.Counter(c['tags']['setting'][0] for c in act).most_common(),
 'band': C.Counter(c['tags']['band'] for c in act).most_common(),
 'format': C.Counter(c.get('format') for c in act).most_common(),
}
def heat(min_c, by_format=False):
    g = C.defaultdict(set); k = C.Counter()
    for c in act:
        for l in leaves_of(c['tags'], min_c):
            key = (l, c.get('format')) if by_format else l
            g[key].add(c['comic']); k[key] += 1
    return sorted(([key if not by_format else '%s [%s]' % key, len(s), k[key]] for key, s in g.items() if len(s) >= 4), key=lambda x: (-x[1], x[0])), len(g)
rep['heat_ready'], rep['leaf_topics_used'] = heat(0.0)
rep['heat_ready_title_conf'], _ = heat(0.6)
rep['heat_ready_same_format_title_conf'], _ = heat(0.6, True)
g = C.defaultdict(set)
for c in act:
    for t, cf, sr in c['tags']['topics']:
        if cf < 0.6: continue
        parts = t.split('/')
        for i in range(1, len(parts) + 1): g['/'.join(parts[:i])].add(c['comic'])
rep['heat_ready_any_node_title_conf'] = sorted(([k, len(v)] for k, v in g.items() if len(v) >= 4), key=lambda x: (-x[1], x[0]))
if report_path: json.dump(rep, open(report_path, 'w'), indent=1, ensure_ascii=False)
print(json.dumps({k: v for k, v in rep.items() if not k.startswith('heat_ready')}, ensure_ascii=False))
print('heat-ready (>=4 comics): leaves any-conf %d | leaves title-conf %d | leaves title-conf same-format %d | any node title-conf %d' % (
    len(rep['heat_ready']), len(rep['heat_ready_title_conf']), len(rep['heat_ready_same_format_title_conf']), len(rep['heat_ready_any_node_title_conf'])))
