# funnier-web Worker (www.funnier.si)

Versioned copy of the Worker that fronts www.funnier.si. Deploy from a copy of this folder:

    cp -r funnier/web-worker /tmp/fw && cd /tmp/fw && CLOUDFLARE_ACCOUNT_ID=954612afb5a97bb15dddcdc70176813d npx wrangler deploy

Routes it serves:
- apex funnier.si → 301 www
- /u/<name>/og.png, /u/<name>/humour.json, /c/<id>, /u/<name> (profile shell, real 404 for unknown names)
- /party (→ /play), /party/*, /play, /join/* → https://party.funnier.si (Freak Town box), full method/body/headers, streamed, no-store
- everything else → GitHub Pages (prx0r.github.io/characters, built from funnier/site), incl. /theme.css

Not this Worker: www.funnier.si/perform* is the separate `freaktown-perform` Worker (source in prx0r/freaktown, edge/perform-worker/).
