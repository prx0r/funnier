# Keyless YouTube metadata cache for the Funnier corpus audit + tagger (tools/tag-clips.py --meta). Metadata only:
# oEmbed, the /embed page player config (playability, duration; fetched with a third-party Referer like a real embed),
# the search-results row for the id (title, channel, length, views, description snippet) and the public /shorts page
# (description, keywords, category). No API key, no media downloads, no transcripts.
# usage: python3 tools/yt-meta.py embed|desc|shorts ids.txt [budget_seconds] [workers]   (cache: $YT_META_DIR/cache/<mode>/<id>.json)
import sys, os, re, json, time, random, urllib.request, urllib.parse, concurrent.futures as F
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
D = os.environ.get('YT_META_DIR', '.yt-meta')
mode, idf = sys.argv[1], sys.argv[2]
budget = float(sys.argv[3]) if len(sys.argv) > 3 else 100
W = int(sys.argv[4]) if len(sys.argv) > 4 else 6
cdir = os.path.join(D, 'cache', mode); os.makedirs(cdir, exist_ok=True)
ids = [l.strip() for l in open(idf) if l.strip()]
t0 = time.time()

def get(url, ref=None):
    h = {'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9', 'Cookie': 'CONSENT=YES+1; SOCS=CAI'}
    if ref: h['Referer'] = ref
    r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=25)
    return r.status, r.geturl(), r.read().decode('utf-8', 'replace')

def jstr(s, key):
    m = re.search(r'"%s":"((?:[^"\\]|\\.)*)"' % key, s)
    return json.loads('"' + m.group(1) + '"') if m else None

def embed(vid):
    out = {'id': vid}
    try:
        st, _, o = get('https://www.youtube.com/oembed?url=' + urllib.parse.quote('https://www.youtube.com/watch?v=' + vid) + '&format=json')
        oj = json.loads(o); out['oembed'] = 200; out['o_title'] = oj.get('title'); out['o_author'] = oj.get('author_name'); out['o_w'] = oj.get('width'); out['o_h'] = oj.get('height')
    except urllib.error.HTTPError as e:
        out['oembed'] = e.code
    except Exception as e:
        out['oembed'] = 'ERR ' + str(e)[:80]
    try:
        st, _, h = get('https://www.youtube.com/embed/' + vid, ref='https://www.funnier.si/')
        s = jstr(h, 'embedded_player_response')
        if not s:
            out['embed'] = 'noresp'; out['embed_unavail'] = 'Video unavailable' in h
        else:
            p = json.loads(s); ps = p.get('previewPlayabilityStatus', {})
            out['embed'] = ps.get('status'); out['playableInEmbed'] = ps.get('playableInEmbed'); out['reason'] = ps.get('reason')
            m = re.search(r'"videoDurationSeconds":"(\d+)"', s); out['dur'] = int(m.group(1)) if m else None
            ep = json.dumps(p.get('embedPreview', {}))
            m = re.search(r'"title": \{"runs": \[\{"text": "((?:[^"\\]|\\.)*)"', ep); out['e_title'] = json.loads('"' + m.group(1) + '"') if m else None
            out['flags'] = p.get('videoFlags')
    except Exception as e:
        out['embed'] = 'ERR ' + str(e)[:80]
    return out

def desc(vid):
    out = {'id': vid}
    try:
        st, url, h = get('https://www.youtube.com/results?search_query=' + urllib.parse.quote('"%s"' % vid) + '&hl=en')
        if 'google.com/sorry' in url or 'ytInitialData' not in h:
            return {'id': vid, 'err': 'blocked'}
        m = re.search(r'var ytInitialData = (\{.+?\});</script>', h)
        d = json.loads(m.group(1))
        def walk(x):
            if isinstance(x, dict):
                if 'videoRenderer' in x and x['videoRenderer'].get('videoId') == vid:
                    return x['videoRenderer']
                for v in x.values():
                    r = walk(v)
                    if r: return r
            elif isinstance(x, list):
                for v in x:
                    r = walk(v)
                    if r: return r
        vr = walk(d)
        if not vr:
            out['found'] = False; return out
        tx = lambda o: ''.join(r.get('text', '') for r in (o or {}).get('runs', [])) or (o or {}).get('simpleText', '')
        out['found'] = True
        out['title'] = tx(vr.get('title'))
        out['channel'] = tx(vr.get('ownerText'))
        out['length'] = tx(vr.get('lengthText'))
        out['views'] = tx(vr.get('viewCountText'))
        out['published'] = tx(vr.get('publishedTimeText'))
        sn = vr.get('detailedMetadataSnippets') or []
        out['snippet'] = ' '.join(tx(s.get('snippetText')) for s in sn)
        out['badges'] = [b.get('metadataBadgeRenderer', {}).get('label') for b in vr.get('badges', []) or []]
    except Exception as e:
        out['err'] = str(e)[:100]
    return out

def shorts(vid):
    out = {'id': vid}
    try:
        st, url, h = get('https://www.youtube.com/shorts/' + vid)
        m = re.search(r'ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|</script>)', h)
        if not m: return {'id': vid, 'err': 'noresp'}
        p = json.loads(m.group(1)); vd = p.get('videoDetails', {}); mf = p.get('microformat', {}).get('playerMicroformatRenderer', {})
        out.update(title=vd.get('title'), channel=vd.get('author'), length=vd.get('lengthSeconds'), keywords=vd.get('keywords'), description=vd.get('shortDescription'),
                   category=mf.get('category'), familySafe=mf.get('isFamilySafe'), publishDate=mf.get('publishDate'), playability=p.get('playabilityStatus', {}).get('status'))
    except urllib.error.HTTPError as e:
        out['err'] = 'HTTP %s' % e.code
    except Exception as e:
        out['err'] = str(e)[:100]
    return out

fn = {'embed': embed, 'desc': desc, 'shorts': shorts}[mode]
todo = [i for i in ids if not os.path.exists(os.path.join(cdir, i + '.json'))]
done = blocked = 0
with F.ThreadPoolExecutor(W) as ex:
    futs = {}
    it = iter(todo)
    def submit():
        try:
            v = next(it)
        except StopIteration:
            return False
        futs[ex.submit(fn, v)] = v; return True
    for _ in range(W): submit()
    while futs:
        dn, _ = F.wait(list(futs), return_when=F.FIRST_COMPLETED)
        for f in dn:
            v = futs.pop(f); r = f.result()
            if r.get('err') == 'blocked' or str(r.get('embed', '')).startswith('ERR'):
                blocked += 1
            else:
                json.dump(r, open(os.path.join(cdir, v + '.json'), 'w')); done += 1
            if time.time() - t0 < budget and blocked < 25:
                submit()
print('mode', mode, 'done', done, 'blocked/err', blocked, 'remaining', len(todo) - done, 'secs', round(time.time() - t0))
