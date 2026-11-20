# -*- coding: utf-8 -*-
"""
把两张「几何剪纸小狐狸」参考图变成可直接用的透明 PNG。

    python scripts/prepare-fox-art.py
    python scripts/prepare-fox-art.py <大图.jpg> <logo图.jpg>

源图默认放在 scripts/fixtures/（不进安装包）。处理步骤：
  1) 近白且低饱和的像素判为背景 -> 透明；边缘做半透明过渡，并反预乘去白边
  2) 右下角的「豆包 AI 生成」水印与地面浅灰弧线整片清掉（y > 0.905H）
  3) 按非透明像素裁出主体，四周留 3%  breathing room
  4) 等比缩放输出：
       assets/fox-full.png   待机页大图（最长边 512）
       assets/fox-logo.png  logo / 头像 / 图标（最长边 256）
       assets/fox-inline.png 观看页内联版（最长边 128，HTTP 页不能引相对资源）
只依赖 Pillow。
"""
import base64
import os
import re
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, 'scripts', 'fixtures')
ASSETS = os.path.join(ROOT, 'assets')

FULL_SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(FIX, 'fox-full-source.jpg')
LOGO_SRC = sys.argv[2] if len(sys.argv) > 2 else os.path.join(FIX, 'fox-logo-source.jpg')


def cut_white(src_path, dst_path, max_side, watermark_guard=True):
    im = Image.open(src_path).convert('RGB')
    w, h = im.size
    px = im.load()
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    dst = out.load()
    cut_y = int(h * 0.905) if watermark_guard else h
    ground_y = int(h * 0.83) if watermark_guard else h

    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            mn = min(r, g, b)
            sat = max(r, g, b) - mn
            if y >= cut_y:
                continue  # 水印 / 地面阴影线整片不要
            if y >= ground_y and x < w * 0.62 and mn >= 190 and sat <= 60:
                continue  # 左下角的淡紫地面弧线；狐狸深色四肢 mn<190、尾巴尖在右侧，都不受影响
            if mn >= 195 and sat <= 18:
                continue  # 白底、浅灰水印与地面弧线；狐狸的浅紫部位 sat>=25，不会被误删
            if mn >= 246 and sat <= 14:
                continue  # 纯白背景
            if mn >= 232 and sat <= 18:
                a = (246 - mn) / 14.0  # 0..1，抗锯齿边缘
            else:
                a = 1.0
            # 反预乘：把 JPEG 白底混进边缘的那点白去掉，避免透明后出现白边
            if a < 1.0:
                r = min(255, max(0, int((r - 255 * (1 - a)) / a)))
                g = min(255, max(0, int((g - 255 * (1 - a)) / a)))
                b = min(255, max(0, int((b - 255 * (1 - a)) / a)))
            dst[x, y] = (r, g, b, int(a * 255))

    box = out.getbbox()
    if not box:
        raise RuntimeError('nothing left after white-cut: ' + src_path)
    x0, y0, x1, y1 = box
    pad = int(max(x1 - x0, y1 - y0) * 0.03)
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
    cropped = out.crop((x0, y0, x1, y1))
    cw, ch = cropped.size
    scale = min(1.0, max_side / float(max(cw, ch)))
    if scale < 1.0:
        cropped = cropped.resize((max(1, int(cw * scale)), max(1, int(ch * scale))), Image.LANCZOS)
    cropped.save(dst_path, optimize=True)
    print('%-22s <- %s  bbox=%s -> %s  %dB'
          % (os.path.basename(dst_path), os.path.basename(src_path), (x0, y0, x1, y1),
             cropped.size, os.path.getsize(dst_path)))


os.makedirs(ASSETS, exist_ok=True)
cut_white(FULL_SRC, os.path.join(ASSETS, 'fox-full.png'), 512)
cut_white(LOGO_SRC, os.path.join(ASSETS, 'fox-logo.png'), 256)
cut_white(LOGO_SRC, os.path.join(ASSETS, 'fox-inline.png'), 128)

# 观看页（mirror.html）由 HTTP 中继原样返回，无法引用相对路径的 assets/，
# 因此把小尺寸 PNG 以 data URI 内联进去。幂等：重跑会覆盖上一次的 data URI。
viewer = os.path.join(ROOT, 'src', 'renderer', 'mirror.html')
uri = 'data:image/png;base64,' + base64.b64encode(
    open(os.path.join(ASSETS, 'fox-inline.png'), 'rb').read()).decode('ascii')
with open(viewer, 'r', encoding='utf-8') as f:
    html = f.read()
new_html, n = re.subn(
    r'(<img class="fox" src=")(?:__FOX_INLINE_DATA_URI__|data:image/png;base64,[^"]*)(")',
    lambda m: m.group(1) + uri + m.group(2), html)
if n != 1:
    raise RuntimeError('viewer fox <img> placeholder not found (matched %d)' % n)
with open(viewer, 'w', encoding='utf-8') as f:
    f.write(new_html)
print('mirror.html <- inline data URI (%d chars)' % len(uri))
print('done')
