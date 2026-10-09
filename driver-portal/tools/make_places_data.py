# Génère public/places-data.js (délégations de chaque gouvernorat, en arabe et en français) à partir de ../db/osm_delegations.json.
# Source : © OpenStreetMap contributors (licence ODbL), relations administratives de niveau 5, rattachées aux gouvernorats par
# géocodage inverse (Nominatim) du centre de chaque délégation, puis CORRIGÉES à la main ci-dessous (chaque correction est expliquée).
# Usage : python tools/make_places_data.py   (depuis driver-portal/)
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict

SRC = "../db/osm_delegations.json"
OUT = "public/places-data.js"

GOVERNORATES = [
    "Ariana", "Béja", "Ben Arous", "Bizerte", "Gabès", "Gafsa", "Jendouba", "Kairouan", "Kasserine", "Kébili", "Le Kef", "Mahdia",
    "La Manouba", "Médenine", "Monastir", "Nabeul", "Sfax", "Sidi Bouzid", "Siliana", "Sousse", "Tataouine", "Tozeur", "Tunis", "Zaghouan",
]
GOVERNORATES_AR = [
    "أريانة", "باجة", "بن عروس", "بنزرت", "قابس", "قفصة", "جندوبة", "القيروان", "القصرين", "قبلي", "الكاف", "المهدية",
    "منوبة", "مدنين", "المنستير", "نابل", "صفاقس", "سيدي بوزيد", "سليانة", "سوسة", "تطاوين", "توزر", "تونس", "زغوان",
]
# Nombre officiel de délégations par gouvernorat (264 au total) : sert de CONTRÔLE, le script refuse de produire un fichier qui s'en écarte.
EXPECTED = {
    "Ariana": 7, "Béja": 9, "Ben Arous": 12, "Bizerte": 14, "Gabès": 10, "Gafsa": 11, "Jendouba": 9, "Kairouan": 11, "Kasserine": 13, "Kébili": 6,
    "Le Kef": 11, "Mahdia": 11, "La Manouba": 8, "Médenine": 9, "Monastir": 13, "Nabeul": 16, "Sfax": 16, "Sidi Bouzid": 12, "Siliana": 11,
    "Sousse": 16, "Tataouine": 7, "Tozeur": 5, "Tunis": 21, "Zaghouan": 6,
}

# --- Corrections du rattachement par géocodage (le centre géométrique d'une grande délégation peut tomber hors d'elle) ---
GOV_OVERRIDES = {
    "Ben Gardane": "Médenine",   # centre en plein désert, côté Tataouine ; la ville de Ben Gardane est dans le gouvernorat de Médenine
    "Soliman": "Nabeul",         # centre en mer : aucun gouvernorat trouvé
    "Bizerte Nord": "Bizerte",   # centre en mer
    "Menzel Jemil": "Bizerte",   # centre sur le lac de Bizerte
}
# --- Entrées de la source qui ne sont pas des délégations (ou des doublons) ---
EXCLUDED_FR = {
    "Essaida": "absente de la liste officielle des 264 délégations de Sidi Bouzid",
}
# --- Coquilles de la source (noms arabes) ---
AR_FIXES = {"مدنين االجنوبية": "مدنين الجنوبية"}
FR_FIXES = {"Djerba Houmet Souk": "Djerba Houmt Souk", "Medenine Nord": "Médenine Nord", "Medenine Sud": "Médenine Sud"}

# --- Variantes d'écriture courantes (translittérations) : même ville, autre orthographe. À enrichir avec les saisies réelles non reconnues. ---
ALIASES = {
    "Oum El Araies": ["Oum Larayes", "Om Larayes", "Oum Laarayes", "Oum El Arayes", "Um Larayes", "أم لعرايس"],
    "Redeyef": ["Rdayef", "Redayef"],
    "Djerba Houmt Souk": ["Houmt Souk", "Houmt Essouk", "Houmet Essouk"],
    "Djerba Midoun": ["Midoun"],
    "Djerba Ajim": ["Ajim"],
    "Kairouan": ["Qayrawan", "Kairaouan"],
    "Sidi Bouzid": ["Sidi Bou Zid"],
    # La source OpenStreetMap écrit parfois autrement que l'usage courant : on accepte les deux.
    "Sidi El Heni": ["Sidi El Hani", "Sidi Hani"],
    "El Guetar": ["El Guettar", "Guettar", "Guetar"],
    "Mdhila": ["Mdhilla"],
    "Tibar": ["Thibar"],
    "Ghanouch": ["Ghannouch"],
    "Beni Khedech": ["Beni Khedache"],
    "Ksour Essef": ["Ksour Essaf"],
}

BIDI = re.compile(r"[‎‏‪-‮⁦-⁩﻿]")


def clean_ar(s):
    s = BIDI.sub("", s or "").replace("معتمدية", "").strip()
    s = re.sub(r"\s+", " ", s)
    return AR_FIXES.get(s, s)


def clean_fr(s):
    s = re.sub(r"^Délégation\s+(?:de\s+|d['’]\s*)?", "", BIDI.sub("", s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    return FR_FIXES.get(s, s)


def plain(name):
    """Comparaison grossière (sans accents ni article) pour reconnaître qu'une délégation porte déjà le nom du chef-lieu."""
    n = unicodedata.normalize("NFD", name).lower()
    n = "".join(c for c in n if not unicodedata.combining(c))
    return re.sub(r"^(le|la|el)\s+", "", n.strip())


def governorate_of(state):
    name = (state or "").replace("Gouvernorat", "").strip()
    return name if name in GOVERNORATES else None


rows = json.load(open(SRC, encoding="utf-8"))["delegations"]
by_gov = defaultdict(list)
coords = defaultdict(dict)  # gouvernorat -> { nom français: (lat, lon) }, pour le géorepérage (arrivée détectée automatiquement)
seen = set()
problems = []
for r in rows:
    fr, ar = clean_fr(r["fr"]), clean_ar(r["ar"])
    if fr in EXCLUDED_FR:
        continue
    gov = GOV_OVERRIDES.get(fr) or governorate_of(r["state"])
    if not gov:
        problems.append(f"aucun gouvernorat pour « {fr} »")
        continue
    if (gov, fr) in seen:  # doublon de la source (même nom dans le même gouvernorat)
        continue
    seen.add((gov, fr))
    by_gov[gov].append([fr, ar])
    coords[gov][fr] = (r["lat"], r["lon"])

# Chef-lieu : une entrée portant le nom du gouvernorat (ex. « Gafsa »), absente de la liste des délégations quand elles s'appellent « Gafsa Nord / Sud ».
# Coordonnées approchées (aucune délégation OSM distincte n'existe sous ce nom) : centre moyen des délégations du gouvernorat.
for gov, gov_ar in zip(GOVERNORATES, GOVERNORATES_AR):
    names = {plain(fr) for fr, _ in by_gov[gov]}
    count = len(by_gov[gov])
    if count != EXPECTED[gov]:
        problems.append(f"{gov} : {count} délégations, {EXPECTED[gov]} attendues")
    if plain(gov) not in names:
        by_gov[gov].insert(0, [gov, gov_ar])
        lats = [c[0] for c in coords[gov].values()]
        lons = [c[1] for c in coords[gov].values()]
        coords[gov][gov] = (round(sum(lats) / len(lats), 4), round(sum(lons) / len(lons), 4))
    by_gov[gov].sort(key=lambda p: (plain(p[0]) != plain(gov), p[0]))

if problems:
    print("REFUSÉ :", *problems, sep="\n  - ")
    sys.exit(1)

lines = [
    "// GÉNÉRÉ par tools/make_places_data.py : ne pas modifier à la main (modifier le script, puis le relancer).",
    "// Délégations de chaque gouvernorat (nom français, nom arabe) + le chef-lieu. 264 délégations.",
    "// Source : © OpenStreetMap contributors (licence ODbL), corrigée à la main (voir le script). À RELIRE par une personne qui connaît le terrain.",
    "export const PLACES = {",
]
for gov in GOVERNORATES:
    items = ", ".join(json.dumps(p, ensure_ascii=False) for p in by_gov[gov])
    lines.append(f"  {json.dumps(gov, ensure_ascii=False)}: [{items}],")
lines.append("};")
lines.append("")
lines.append("// Variantes d'écriture d'une même ville (nom français officiel → variantes). Enrichi au fil des saisies réelles non reconnues.")
lines.append("export const ALIASES = " + json.dumps(ALIASES, ensure_ascii=False, indent=2) + ";")
lines.append("")
lines.append("// Coordonnées [latitude, longitude] de chaque délégation (centre de la relation administrative OSM ; le chef-lieu, qui n'a pas")
lines.append("// sa propre délégation, est une moyenne approchée). Sert au géorepérage (détecter une arrivée sans geste du chauffeur).")
lines.append("export const COORDS = {")
for gov in GOVERNORATES:
    items = ", ".join(f"{json.dumps(fr, ensure_ascii=False)}: [{lat}, {lon}]" for fr, (lat, lon) in coords[gov].items())
    lines.append(f"  {json.dumps(gov, ensure_ascii=False)}: {{{items}}},")
lines.append("};")
open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")  # LF, pas CRLF (dépôt en LF, voir .gitattributes)
total = sum(len(v) for v in by_gov.values())
print(f"{OUT} : {total} villes ({total - sum(EXPECTED.values())} chefs-lieux ajoutés), 24 gouvernorats")
