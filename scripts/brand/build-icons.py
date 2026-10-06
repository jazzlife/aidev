#!/usr/bin/env python3
"""App icons from the emblem (2026-10-05): the illustration inside the emblem's rings, without the rings and without
the transparent outside — launchers fill transparency (Android white, iOS black) and the rings read as a border.

  python3 scripts/brand/build-icons.py        (needs Pillow; writes public/icons/*, public/logo-*.png, public/favicon.png)

  any        a round icon: white disc, transparent outside, 88%   (macOS / Windows installs, shortcuts) — 2026-10-06:
             a square tile showed its background in the corners around the round mark on macOS
  maskable   full white square, illustration 80% (the safe zone) (Android adaptive icons and the launch splash)
  apple      full white square, illustration 94% (iOS needs opaque; it rounds it)
  logo/fav   the illustration alone as a soft-edged disc          (in-app marks, browser tab)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(__file__).with_name('emblem-512.png')
WHITE = (255, 255, 255, 255)
# the emblem's illustration: radius 178 around the centre of the 512 source (its rings start at 182)
CENTER, RADIUS = 256, 178
SS = 4  # supersampling for smooth edges


def disc(size: int) -> Image.Image:
    """The illustration as a `size` disc with an antialiased edge, transparent outside."""
    src = Image.open(SRC).convert('RGBA')
    crop = src.crop((CENTER - RADIUS, CENTER - RADIUS, CENTER + RADIUS, CENTER + RADIUS))
    big = crop.resize((size * SS, size * SS), Image.LANCZOS)
    flat = Image.new('RGBA', big.size, WHITE)
    flat.alpha_composite(big)
    mask = Image.new('L', big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(SS * 0.6))
    flat.putalpha(mask)
    return flat.resize((size, size), Image.LANCZOS)


def round_icon(size: int, scale: float) -> Image.Image:
    """`size` transparent canvas with the white disc at `scale` in the middle."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = round(size * scale)
    canvas.alpha_composite(disc(d), ((size - d) // 2, (size - d) // 2))
    return canvas


def tile(size: int, scale: float, rounded: float) -> Image.Image:
    """`size` canvas: white background (a rounded tile when `rounded` > 0) with the illustration at `scale`."""
    big = size * SS
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    shape = Image.new('L', (big, big), 0)
    ImageDraw.Draw(shape).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * rounded), fill=255)
    canvas.paste(Image.new('RGBA', (big, big), WHITE), (0, 0), shape)
    d = int(big * scale)
    canvas.alpha_composite(disc(d // SS).resize((d, d), Image.LANCZOS), ((big - d) // 2, (big - d) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    icons = ROOT / 'public' / 'icons'
    for size in (72, 96, 128, 144, 152, 192, 384, 512):
        round_icon(size, 0.88).save(icons / f'icon-{size}x{size}.png', optimize=True)
    for size in (192, 512):
        tile(size, 0.80, 0).save(icons / f'icon-maskable-{size}x{size}.png', optimize=True)
    tile(180, 0.94, 0).save(icons / 'apple-touch-icon.png', optimize=True)
    for size in (32, 64, 128, 256, 512):
        disc(size).save(ROOT / 'public' / f'logo-{size}.png', optimize=True)
    disc(32).save(ROOT / 'public' / 'favicon.png', optimize=True)
    print('icons written')


if __name__ == '__main__':
    main()
