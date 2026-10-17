# funnier-web Worker (www.funnier.si)

Versioned copy of the Worker that fronts www.funnier.si. Deploy from a copy of this folder:

    cp -r funnier/web-worker /tmp/fw && cd /tmp/fw && CLOUDFLARE_ACCOUNT_ID=954612afb5a97bb15dddcdc70176813d npx wrangler deploy

Routes it serves:
- apex funnier.si → 301 www
- /u/<name>/og.png, /u/<name>/humour.json, /c/<id>, /u/<name> (profile shell, real 404 for unknown names)
- /party (→ /play), /party/*, /play, /join/* → https://party.funnier.si (Freak Town box), full method/body/headers, streamed, no-store
  - GET text/html responses get the Funnier skin (`funnier-skin.js`, a verbatim copy of prx0r/freaktown
    `edge/perform-worker/funnier-skin.js`, the JS port of the box's `funnier_skin.py`; edit it there and copy). `?skin=0` = unskinned.
    Pages the box already skinned (`<style id='funnier-skin'>`) pass through. JSON/SSE/images/POSTs stream untouched.
  - stage hotfix: re-escapes the box's broken deck-button JS string (SyntaxError that kills the stage script) until the box is fixed
  - box fetched with `cache: 'no-store'`; everything but images is sent `cache-control: no-store` (live room polling)
- /icon-512.png, /icon-192.png → the box's icons (cached a day)
- everything else → GitHub Pages (prx0r.github.io/characters, built from funnier/site), incl. /theme.css

Not this Worker: www.funnier.si/perform* is the separate `freaktown-perform` Worker (source in prx0r/freaktown, edge/perform-worker/).
