#!/usr/bin/env bash
# Recette de sécurité après déploiement. Usage :
#   ./deploy/smoke-test.sh https://inscription.exemple.tn            (en ligne : vérifie aussi HTTPS, HSTS, TLS)
#   SKIP_TLS=1 ./deploy/smoke-test.sh http://localhost:4100          (en local : ignore les contrôles TLS)
#   ADMIN_TOKEN=... ./deploy/smoke-test.sh https://...               (vérifie aussi que le bon jeton passe)
# Code de sortie : 0 si tout est conforme, 1 sinon.
set -uo pipefail

BASE="${1:?Usage : smoke-test.sh <URL de base, ex. https://inscription.exemple.tn>}"
BASE="${BASE%/}"
SKIP_TLS="${SKIP_TLS:-0}"
fail=0
pass() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$1"; fail=1; }
check() { # check "description" "attendu" "obtenu"
  if [ "$2" = "$3" ]; then pass "$1"; else bad "$1 (attendu $2, obtenu $3)"; fi
}
code()    { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@"; }
headers() { curl -sI -m 15 "$@"; }
has()     { grep -qi "^$1:" <<<"$2"; }

echo "Recette : $BASE"

if [ "$SKIP_TLS" != "1" ]; then
  echo "— HTTPS"
  host="${BASE#https://}"
  r="$(code -o /dev/null "http://$host/")"
  case "$r" in 301|302|307|308) pass "http:// redirige vers https:// ($r)";; *) bad "http:// doit rediriger (obtenu $r)";; esac
  h="$(headers "$BASE/api/config")"
  has "strict-transport-security" "$h" && pass "HSTS présent" || bad "HSTS absent"
  check "TLS 1.0/1.1 refusés" "refusé" "$(curl -s -o /dev/null -m 15 --tls-max 1.1 "$BASE/" >/dev/null 2>&1 && echo accepté || echo refusé)"
  check "TLS 1.2 accepté" "200" "$(code --tlsv1.2 --tls-max 1.2 "$BASE/healthz")"
fi

echo "— En-têtes"
h="$(headers "$BASE/api/config")"
has "content-security-policy" "$h" && pass "CSP présente" || bad "CSP absente"
grep -qi "script-src 'self'" <<<"$h" && ! grep -qi "unsafe-inline" <<<"$h" && pass "CSP stricte (pas de unsafe-inline)" || bad "CSP trop permissive"
has "x-content-type-options" "$h" && pass "nosniff" || bad "nosniff absent"
has "x-powered-by" "$h" && bad "X-Powered-By expose la technologie" || pass "X-Powered-By absent"
grep -qi "^cache-control:.*no-store" <<<"$h" && pass "API : Cache-Control no-store" || bad "API : no-store absent"
grep -qi "^x-robots-tag:.*noindex" <<<"$h" && pass "API : noindex" || bad "API : noindex absent"
grep -qi "^referrer-policy: no-referrer" <<<"$h" && pass "Referrer-Policy no-referrer" || bad "Referrer-Policy"

echo "— Application"
check "/healthz répond" "200" "$(code "$BASE/healthz")"
check "page d'accueil" "200" "$(code "$BASE/")"
check "robots.txt" "200" "$(code "$BASE/robots.txt")"
check "sitemap.xml" "200" "$(code "$BASE/sitemap.xml")"
for p in privacy terms legal; do check "page légale /$p" "200" "$(code "$BASE/$p")"; done
legal="$(curl -s -m 15 "$BASE/api/legal")"
grep -Eq '"(entity|address|email|host|retention_rejected|retention_approved|backup_days)":null' <<<"$legal" && bad "pages légales incomplètes (variables LEGAL_* manquantes)" || pass "pages légales complètes (éditeur, hébergeur, durées)"
check "page inconnue : vraie 404" "404" "$(code -H 'Accept: text/html' "$BASE/page-qui-nexiste-pas")"
og="$(curl -s -m 15 "$BASE/" | grep -o 'property="og:image" content="[^"]*"' | head -1 | sed 's/.*content="//; s/"$//')"
[ -n "$og" ] && case "$og" in http*) pass "og:image absolue ($og)";; *) bad "og:image non absolue : $og";; esac || bad "og:image absente"
case "$og" in http*) check "image de partage accessible" "200" "$(code "$og")";; esac
check "API admin sans jeton refusée" "401" "$(code "$BASE/api/admin/applications")"
check "API admin avec faux jeton refusée" "401" "$(code -H 'Authorization: Bearer faux-jeton-de-recette' "$BASE/api/admin/applications")"
check "écriture venue d'un autre site refusée" "403" "$(code -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$BASE/api/otp/send")"
check "JSON invalide : 400 propre" "400" "$(code -X POST -H 'Content-Type: application/json' -d '{oops' "$BASE/api/otp/send")"
body="$(curl -s -m 15 -X POST -H 'Content-Type: application/json' -d '{oops' "$BASE/api/otp/send")"
grep -q ' at ' <<<"$body" && bad "l'erreur contient une trace d'appel" || pass "aucune trace d'appel dans les erreurs"
check "suivi par URL (téléphone dans l'URL) n'existe plus" "404" "$(code "$BASE/api/status?ref=LX-AAAAAAAA&phone=98123456")"
check "autre profil que chauffeur refusé" "400" "$(code -X POST -F role=owner "$BASE/api/applications")"

echo "— Fichiers sensibles inaccessibles"
for p in /.env /data/portal.db /uploads/ /server.js /package.json /deploy/portal.env.example /.git/config; do
  r="$(code "$BASE$p")"
  case "$r" in 404|403) pass "$p → $r";; *) bad "$p accessible (code $r)";; esac
done

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "— Jeton admin"
  r="$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/applications")"
  mode="$(curl -s -m 15 "$BASE/api/admin/mode")"
  case "$r" in
    200) if grep -q '"accounts":true' <<<"$mode"; then bad "des comptes existent mais le jeton partagé donne encore accès"; else pass "le bon jeton est accepté (installation initiale : aucun compte créé, à faire avant d'ouvrir)"; fi;;
    401) if grep -q '"accounts":true' <<<"$mode"; then pass "comptes nominatifs actifs : le jeton partagé ne donne plus accès"; else bad "le jeton est refusé alors qu'aucun compte n'existe"; fi;;
    403) pass "le bon jeton est refusé depuis cette IP (liste blanche ADMIN_ALLOWED_IPS active : attendu hors de l'IP autorisée)";;
    *)   bad "le bon jeton donne $r";;
  esac
fi

echo
if [ "$fail" -eq 0 ]; then echo "Tout est conforme."; else echo "Des contrôles ont échoué."; fi
exit "$fail"
