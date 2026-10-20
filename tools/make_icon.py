#!/usr/bin/env python3
"""ホーム画面用のアイコン public/icon-180.png を、public/shop.jsonc の色で作る（Lift-Off 予約カレンダー）2026/10/20
使い方: python3 tools/make_icon.py   （要 Pillow）
"""
import os, re, json
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
t = open(os.path.join(ROOT, 'public', 'shop.jsonc'), encoding='utf-8').read()
t = re.sub(r'^\s*//.*$', '', t, flags=re.M); t = re.sub(r'[ \t]+//[^"\n]*$', '', t, flags=re.M)
shop = json.loads(t)
main = shop['color']['main']

S = 180
im = Image.new('RGB', (S, S), main)
d = ImageDraw.Draw(im)
font = None
for f in ['/System/Library/Fonts/ヒラギノ角ゴシック W7.ttc', '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc']:
    if os.path.exists(f):
        try: font = ImageFont.truetype(f, 104); break
        except Exception: pass
if font is None: font = ImageFont.load_default()
txt = '予'
box = d.textbbox((0, 0), txt, font=font)
w, h = box[2] - box[0], box[3] - box[1]
d.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] - 6), txt, fill='#ffffff', font=font)
out = os.path.join(ROOT, 'public', 'icon-180.png')
im.save(out)
print('作った:', os.path.relpath(out, ROOT), main)
