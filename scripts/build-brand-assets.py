import math
import os
import struct
from io import BytesIO
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "src-tauri", "icons")
SOURCE_ART = os.path.join(ICON_DIR, "source-artwork.png")
PREVIEW_OUT = os.path.join(
    r"C:\Users\admin\.gemini\antigravity\brain\9e28e15f-9987-4dd6-a482-8dfb9574ef80\scratch",
    "minicat-icon-preview.png",
)


def make_squircle_mask(size: int, box_size: int, power: float = 4.6) -> Image.Image:
    """Create a super-sampled continuous superellipse (squircle) alpha mask."""
    ss = 2
    s = size * ss
    b = box_size * ss
    half = b / 2.0
    cx = s / 2.0
    cy = s / 2.0

    # Compute fast using PIL point-grid in pure python over bounding box only
    mask = Image.new("L", (s, s), 0)
    px = mask.load()
    x0 = max(0, int(cx - half) - 2)
    x1 = min(s, int(cx + half) + 3)
    y0 = max(0, int(cy - half) - 2)
    y1 = min(s, int(cy + half) + 3)
    inv_half = 1.0 / half

    for y in range(y0, y1):
        dy = abs((y + 0.5 - cy) * inv_half)
        if dy >= 1.005:
            continue
        dy_p = dy ** power
        for x in range(x0, x1):
            dx = abs((x + 0.5 - cx) * inv_half)
            if dx >= 1.005:
                continue
            val = dx ** power + dy_p
            if val <= 0.992:
                px[x, y] = 255
            elif val < 1.008:
                t = (1.008 - val) / 0.016
                px[x, y] = int(max(0.0, min(1.0, t)) * 255)

    return mask.resize((size, size), Image.Resampling.LANCZOS)


def crop_zoom(img: Image.Image, zoom: float = 1.12, y_shift: float = -0.01) -> Image.Image:
    w, h = img.size
    crop_w = w / zoom
    crop_h = h / zoom
    left = (w - crop_w) / 2.0
    top = (h - crop_h) / 2.0 + h * y_shift
    top = max(0.0, min(h - crop_h, top))
    return img.crop((left, top, left + crop_w, top + crop_h))


def render_squircle_icon(
    art: Image.Image,
    canvas_size: int,
    box_ratio: float,
    zoom: float = 1.12,
    y_shift: float = -0.01,
    shadow_alpha: int = 58,
    shadow_offset_ratio: float = 0.014,
    shadow_blur_ratio: float = 0.022,
    border_width: int = 4,
) -> Image.Image:
    box_size = int(round(canvas_size * box_ratio))
    margin = (canvas_size - box_size) // 2

    cropped = crop_zoom(art, zoom=zoom, y_shift=y_shift).convert("RGBA")
    scaled = cropped.resize((box_size, box_size), Image.Resampling.LANCZOS)

    tile_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    tile_layer.paste(scaled, (margin, margin))

    mask = make_squircle_mask(canvas_size, box_size, power=4.6)

    # Outer hairline border + subtle top inner highlight for legibility on white & dark desktops
    inner_mask = make_squircle_mask(canvas_size, box_size - border_width * 2, power=4.6)
    border_ring = Image.new("L", (canvas_size, canvas_size), 0)
    m_px = mask.load()
    im_px = inner_mask.load()
    br_px = border_ring.load()
    for y in range(canvas_size):
        for x in range(canvas_size):
            diff = m_px[x, y] - im_px[x, y]
            if diff > 0:
                br_px[x, y] = diff

    # Soft drop shadow behind squircle
    result = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    if shadow_alpha > 0:
        shadow = Image.new("RGBA", (canvas_size, canvas_size), (24, 18, 12, 0))
        shadow_mask = mask.point(lambda a: int(a * shadow_alpha / 255))
        shadow.putalpha(shadow_mask)
        blur_r = max(1.0, canvas_size * shadow_blur_ratio)
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=blur_r))
        dy = int(round(canvas_size * shadow_offset_ratio))
        result.alpha_composite(shadow, (0, dy))

    # Composite masked artwork
    clipped = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    clipped.paste(tile_layer, (0, 0), mask)
    result.alpha_composite(clipped)

    # Subtle warm hairline rim so icon edges never blend into pure white backgrounds
    rim_color = Image.new("RGBA", (canvas_size, canvas_size), (212, 198, 180, 165))
    rim_masked = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    rim_masked.paste(rim_color, (0, 0), border_ring)
    result.alpha_composite(rim_masked)

    return result


def encode_ico_dib_bmp(img: Image.Image) -> bytes:
    """Encode an RGBA PIL image as a 32-bit ICO DIB (BITMAPINFOHEADER + BGRA bottom-up + AND mask)."""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    pixels = rgba.load()

    # BITMAPINFOHEADER (40 bytes); biHeight = h * 2 (XOR + AND masks)
    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        w,
        h * 2,
        1,
        32,
        0,
        w * h * 4,
        0,
        0,
        0,
        0,
    )

    xor_rows = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            xor_rows.extend((b, g, r, a))

    # 1-bit AND mask, rows padded to 32-bit boundary
    and_row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray(and_row_bytes * h)
    for y in range(h - 1, -1, -1):
        row_idx = (h - 1 - y) * and_row_bytes
        for x in range(w):
            a = pixels[x, y][3]
            if a < 16:
                and_mask[row_idx + (x // 8)] |= 0x80 >> (x % 8)

    return header + bytes(xor_rows) + bytes(and_mask)


def encode_png_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_ico(master_win: Image.Image, sizes: list[int], out_path: str) -> None:
    entries = []
    for sz in sizes:
        resized = master_win.resize((sz, sz), Image.Resampling.LANCZOS)
        if sz >= 256:
            data = encode_png_bytes(resized)
        else:
            data = encode_ico_dib_bmp(resized)
        entries.append((sz, data))

    header = struct.pack("<HHH", 0, 1, len(entries))
    dir_entries = bytearray()
    offset = 6 + 16 * len(entries)
    blobs = bytearray()
    for sz, data in entries:
        b_dim = 0 if sz >= 256 else sz
        dir_entries.extend(
            struct.pack("<BBBBHHII", b_dim, b_dim, 0, 0, 1, 32, len(data), offset)
        )
        offset += len(data)
        blobs.extend(data)

    with open(out_path, "wb") as f:
        f.write(header + bytes(dir_entries) + bytes(blobs))


def build_icns(master_mac: Image.Image, out_path: str) -> None:
    specs = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    ]
    chunks = bytearray()
    for ostype, sz in specs:
        resized = master_mac if sz == master_mac.width else master_mac.resize((sz, sz), Image.Resampling.LANCZOS)
        png = encode_png_bytes(resized)
        chunks.extend(ostype)
        chunks.extend(struct.pack(">I", 8 + len(png)))
        chunks.extend(png)

    total_len = 8 + len(chunks)
    with open(out_path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", total_len) + bytes(chunks))


def load_font(size: int, bold: bool = False):
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def build_nsis_sidebar(win_icon: Image.Image, out_path: str) -> None:
    """164x314 24-bit uncompressed BMP for NSIS Welcome/Finish pages."""
    w, h = 164, 314
    img = Image.new("RGBA", (w, h), (255, 252, 245, 255))
    draw = ImageDraw.Draw(img)

    # Smooth warm cream vertical gradient
    for y in range(h):
        t = y / (h - 1)
        r = int(round(255 - 12 * t))
        g = int(round(252 - 17 * t))
        b = int(round(245 - 23 * t))
        draw.line([(0, y), (w, y)], fill=(r, g, b, 255))

    # Subtle vertical right edge divider
    draw.line([(w - 1, 0), (w - 1, h)], fill=(230, 220, 206, 255))

    # Brand icon centered in upper portion
    icon_sz = 110
    icon_small = win_icon.resize((icon_sz, icon_sz), Image.Resampling.LANCZOS)
    img.alpha_composite(icon_small, ((w - icon_sz) // 2, 54))

    # Clean brand wordmark
    font_title = load_font(22, bold=True)
    font_sub = load_font(11, bold=False)

    title = "MiniCat"
    tb = draw.textbbox((0, 0), title, font=font_title)
    tw = tb[2] - tb[0]
    draw.text(((w - tw) // 2, 180), title, fill=(24, 25, 32, 255), font=font_title)

    sub = "Desktop Companion"
    sb = draw.textbbox((0, 0), sub, font=font_sub)
    sw = sb[2] - sb[0]
    draw.text(((w - sw) // 2, 210), sub, fill=(116, 108, 98, 255), font=font_sub)

    # Signature coral-orange & chartreuse minimalist pill bars near bottom
    draw.rounded_rectangle([54, 244, 94, 250], radius=3, fill=(255, 107, 53, 255))
    draw.rounded_rectangle([99, 244, 110, 250], radius=3, fill=(184, 228, 36, 255))

    # Save strictly as 24-bit RGB BMP (NSIS requirement)
    img.convert("RGB").save(out_path, format="BMP")


def build_nsis_header(win_icon: Image.Image, out_path: str) -> None:
    """150x57 24-bit uncompressed BMP for NSIS installer header."""
    w, h = 150, 57
    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Place crisp icon on the right side of header
    icon_sz = 44
    icon_small = win_icon.resize((icon_sz, icon_sz), Image.Resampling.LANCZOS)
    img.alpha_composite(icon_small, (w - icon_sz - 10, (h - icon_sz) // 2))

    # Subtle brand accent beside icon
    font_brand = load_font(16, bold=True)
    text = "MiniCat"
    tb = draw.textbbox((0, 0), text, font=font_brand)
    tw = tb[2] - tb[0]
    th = tb[3] - tb[1]
    draw.text((w - icon_sz - 18 - tw, (h - th) // 2 - 3), text, fill=(26, 27, 34, 255), font=font_brand)

    img.convert("RGB").save(out_path, format="BMP")


def build_preview_sheet(win_icon: Image.Image, mac_icon: Image.Image, tray_icon: Image.Image, out_path: str) -> None:
    """Render side-by-side preview on Dark and Light desktop backgrounds at multiple sizes."""
    w, h = 960, 520
    sheet = Image.new("RGBA", (w, h), (24, 26, 34, 255))
    draw = ImageDraw.Draw(sheet)

    # Left half: Dark Win11 / macOS dark wallpaper
    for y in range(h):
        t = y / h
        draw.line([(0, y), (w // 2, y)], fill=(int(22 + 10 * t), int(25 + 12 * t), int(36 + 18 * t), 255))
    # Right half: Light desktop wallpaper
    for y in range(h):
        t = y / h
        draw.line([(w // 2, y), (w, y)], fill=(int(244 - 8 * t), int(246 - 7 * t), int(250 - 6 * t), 255))

    f_hdr = load_font(18, bold=True)
    f_lbl = load_font(13, bold=False)

    draw.text((28, 22), "Dark Desktop / Taskbar Preview", fill=(235, 240, 248, 255), font=f_hdr)
    draw.text((w // 2 + 28, 22), "Light Desktop / Explorer Preview", fill=(32, 36, 44, 255), font=f_hdr)

    for panel_idx, ox in enumerate([0, w // 2]):
        txt_col = (210, 218, 232, 255) if panel_idx == 0 else (58, 64, 76, 255)
        # Large 200px hero icon
        hero = win_icon.resize((200, 200), Image.Resampling.LANCZOS)
        sheet.alpha_composite(hero, (ox + 48, 76))
        draw.text((ox + 114, 286), "MiniCat", fill=txt_col, font=f_hdr)

        # Medium / small desktop & taskbar sizes
        sizes_row = [(64, 280), (48, 364), (32, 428)]
        for sz, rx in sizes_row:
            ic = win_icon.resize((sz, sz), Image.Resampling.LANCZOS)
            sheet.alpha_composite(ic, (ox + rx, 140 - sz // 2))
            draw.text((ox + rx + sz // 2 - 14, 182), f"{sz}px", fill=txt_col, font=f_lbl)

        # Tray icon 32px & 16px preview
        draw.text((ox + 280, 226), "Tray / Menu Bar:", fill=txt_col, font=f_lbl)
        t32 = tray_icon.resize((32, 32), Image.Resampling.LANCZOS)
        t16 = tray_icon.resize((16, 16), Image.Resampling.LANCZOS)
        sheet.alpha_composite(t32, (ox + 286, 254))
        sheet.alpha_composite(t16, (ox + 338, 262))

        # macOS HIG grid icon preview
        m128 = mac_icon.resize((128, 128), Image.Resampling.LANCZOS)
        sheet.alpha_composite(m128, (ox + 56, 344))
        draw.text((ox + 56, 480), "macOS HIG .icns", fill=txt_col, font=f_lbl)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sheet.convert("RGB").save(out_path, format="PNG")


def main() -> None:
    if not os.path.exists(SOURCE_ART):
        raise FileNotFoundError(f"Missing master artwork at {SOURCE_ART}")

    os.makedirs(ICON_DIR, exist_ok=True)
    art = Image.open(SOURCE_ART).convert("RGBA")

    # 1. Windows / Cross-platform high-fill squircle icon (91% fill)
    win_master = render_squircle_icon(
        art,
        canvas_size=1024,
        box_ratio=0.91,
        zoom=1.14,
        y_shift=-0.015,
        shadow_alpha=54,
        shadow_offset_ratio=0.014,
        shadow_blur_ratio=0.020,
        border_width=5,
    )

    # 2. macOS Apple HIG grid squircle icon (82.4% fill + Apple elevation shadow)
    mac_master = render_squircle_icon(
        art,
        canvas_size=1024,
        box_ratio=0.824,
        zoom=1.14,
        y_shift=-0.015,
        shadow_alpha=76,
        shadow_offset_ratio=0.018,
        shadow_blur_ratio=0.028,
        border_width=5,
    )

    # 3. Bold tight-zoom tray / menu bar icon (96% fill, cat face larger for 16px-32px legibility)
    tray_master = render_squircle_icon(
        art,
        canvas_size=512,
        box_ratio=0.96,
        zoom=1.24,
        y_shift=-0.035,
        shadow_alpha=0,
        shadow_offset_ratio=0.0,
        shadow_blur_ratio=0.0,
        border_width=6,
    )

    # Write Tauri PNGs
    win_master.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "32x32.png"))
    win_master.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "128x128.png"))
    win_master.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "128x128@2x.png"))
    win_master.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "256x256.png"))
    win_master.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "icon.png"))
    tray_master.resize((64, 64), Image.Resampling.LANCZOS).save(os.path.join(ICON_DIR, "tray-icon.png"))

    # Write 7-resolution Windows .ico (16, 24, 32, 48, 64, 128, 256)
    build_ico(win_master, [16, 24, 32, 48, 64, 128, 256], os.path.join(ICON_DIR, "icon.ico"))

    # Write 7-resolution macOS .icns (16..1024)
    build_icns(mac_master, os.path.join(ICON_DIR, "icon.icns"))

    # Write custom 24-bit BMP NSIS installer artwork
    build_nsis_sidebar(win_master, os.path.join(ICON_DIR, "nsis-sidebar.bmp"))
    build_nsis_header(win_master, os.path.join(ICON_DIR, "nsis-header.bmp"))

    # Write visual inspection sheet
    build_preview_sheet(win_master, mac_master, tray_master, PREVIEW_OUT)

    print("Brand assets built successfully:")
    for fname in [
        "32x32.png",
        "128x128.png",
        "128x128@2x.png",
        "256x256.png",
        "icon.png",
        "tray-icon.png",
        "icon.ico",
        "icon.icns",
        "nsis-sidebar.bmp",
        "nsis-header.bmp",
    ]:
        p = os.path.join(ICON_DIR, fname)
        print(f"  {fname}: {os.path.getsize(p):,} bytes")


if __name__ == "__main__":
    main()
