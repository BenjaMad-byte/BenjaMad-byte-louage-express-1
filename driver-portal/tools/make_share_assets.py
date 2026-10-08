# Régénère l'image de partage (public/img/og-share.jpg) et les icônes PNG à partir de la photo d'accueil.
# Prérequis : Python avec Pillow, arabic-reshaper, python-bidi ; Node avec `sharp` (installé dans ../backend) ; polices Noto (Latin et Arabe).
# Les chemins PUB et FONTS sont ceux de la machine de développement Windows : à adapter ailleurs.
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont
import arabic_reshaper
from bidi.algorithm import get_display

PUB = r"C:\Users\MAD\louage-express\driver-portal\public"
SCRATCH = os.environ.get("TEMP", ".")
FONTS = r"C:\Windows\Fonts"

# ------------------------------------------------------------------ icônes PNG (plein cadre, zone de sécurité pour les icônes « maskable »)
icon_svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <rect width="64" height="64" fill="#003934"/>
  <g transform="translate(32 32) scale(0.8) translate(-32 -33)">
    <path d="M8 41V28a3 3 0 0 1 3-3h24l10 9h8a3 3 0 0 1 3 3v4z" fill="#fff"/>
    <rect x="8" y="35" width="48" height="2.6" fill="#1a9e8f"/>
    <path d="M14 28h8v5h-8zM25 28h8v5h-8zM36 28h4l5 5h-9z" fill="#bfe6e0"/>
    <circle cx="21" cy="43" r="5.4" fill="#001f1c" stroke="#fff" stroke-width="1.6"/>
    <circle cx="46" cy="43" r="5.4" fill="#001f1c" stroke="#fff" stroke-width="1.6"/>
  </g>
</svg>"""
svg_path = os.path.join(SCRATCH, "icon-source.svg")
open(svg_path, "w", encoding="utf-8").write(icon_svg)
node = f"""
const {{ createRequire }} = require('node:module');
const sharp = createRequire('C:/Users/MAD/louage-express/backend/package.json')('sharp');
const fs = require('node:fs');
(async () => {{
  const svg = fs.readFileSync({svg_path!r});
  for (const [name, size] of [['apple-touch-icon.png',180],['icon-192.png',192],['icon-512.png',512]]) {{
    await sharp(svg, {{ density: 300 }}).resize(size, size).png({{ compressionLevel: 9 }}).toFile({PUB!r} + '/' + name);
  }}
}})();
"""
js_path = os.path.join(SCRATCH, "make_icons.cjs")
open(js_path, "w", encoding="utf-8").write(node)
subprocess.run(["node", js_path], check=True)

# ------------------------------------------------------------------ image de partage 1200x630 (JPEG < 300 Ko)
W, H = 1200, 630
hero = Image.open(os.path.join(PUB, "img", "hero-1376.webp")).convert("RGB")
scale = W / hero.width
hero = hero.resize((W, round(hero.height * scale)), Image.LANCZOS)  # 1200 x 670
top = 40
img = hero.crop((0, top, W, top + H)).convert("RGBA")

# voile sombre à gauche et en bas pour la lisibilité du texte
shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
px = shade.load()
for y in range(H):
    for x in range(W):
        a = max(0.0, 0.88 - x / (W * 0.78)) * 255            # dégradé horizontal (fort à gauche)
        a = max(a, max(0.0, (y - H * 0.55) / (H * 0.45)) * 200)  # dégradé vertical (fort en bas)
        px[x, y] = (0, 31, 28, int(min(a, 235)))
img = Image.alpha_composite(img, shade)

d = ImageDraw.Draw(img)
bold = ImageFont.truetype(os.path.join(FONTS, "NotoSans-Bold.ttf"), 78)
reg = ImageFont.truetype(os.path.join(FONTS, "NotoSans-Regular.ttf"), 34)
ar_bold = ImageFont.truetype(os.path.join(FONTS, "NotoSansArabic-Bold.ttf"), 64)
small = ImageFont.truetype(os.path.join(FONTS, "NotoSans-Regular.ttf"), 20)

def ar(text):
    return get_display(arabic_reshaper.reshape(text))

x0 = 64
d.text((x0, 120), "Louage Express", font=bold, fill="white")
d.text((x0, 238), ar("تسجيل سائقي اللواج"), font=ar_bold, fill="white")
d.text((x0, 372), "Inscription à distance des chauffeurs de louage", font=reg, fill=(224, 242, 239))
# bande de livrée : vert profond 72 % / turquoise 28 %
d.rectangle((0, H - 16, int(W * 0.72), H), fill=(26, 158, 143))
d.rectangle((int(W * 0.72), H - 16, W, H), fill=(127, 224, 211))
d.text((W - 24, H - 34), "Image illustrative", font=small, fill=(214, 222, 230), anchor="rs")

out = os.path.join(PUB, "img", "og-share.jpg")
for q in (84, 78, 72, 66):
    img.convert("RGB").save(out, "JPEG", quality=q, optimize=True, progressive=True)
    if os.path.getsize(out) < 280 * 1024:
        break
print("og-share.jpg", os.path.getsize(out) // 1024, "Ko, qualité", q)
for f in ("apple-touch-icon.png", "icon-192.png", "icon-512.png"):
    print(f, os.path.getsize(os.path.join(PUB, f)), "octets")
