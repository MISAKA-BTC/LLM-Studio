#!/usr/bin/env python3
"""Generate the LLM Studio icon for the desktop bundle and web UI."""

from pathlib import Path
import struct
import zlib

ICONS = Path(__file__).resolve().parent
WEB_ICON = ICONS.parents[2] / "ui/src/assets/llm-studio.png"
TOP = (0x13, 0x20, 0x4A)
BOTTOM = (0x08, 0x5E, 0x6E)

# The letters are drawn on a 19-by-9 grid for a readable mark at favicon size.
GLYPHS = [
    ("1100000", "1100000", "1100000", "1100000", "1100000", "1100000", "1100000", "1111100", "1111100"),
    ("1100000", "1100000", "1100000", "1100000", "1100000", "1100000", "1100000", "1111100", "1111100"),
    ("1100011", "1110111", "1111111", "1101011", "1100011", "1100011", "1100011", "1100011", "1100011"),
]


def paint(x: float, y: float, base: tuple[int, int, int]) -> tuple[int, int, int, int]:
    # Leave a transparent margin so the Dock tile aligns with other application icons.
    inset, radius = 0.085, 0.19
    cx = min(max(x, inset + radius), 1 - inset - radius)
    cy = min(max(y, inset + radius), 1 - inset - radius)
    if (x - cx) ** 2 + (y - cy) ** 2 > radius * radius:
        return (0, 0, 0, 0)

    cell = 0.033
    col = int((x - (0.5 - 9.5 * cell)) // cell)
    row = int((y - (0.5 - 4.5 * cell)) // cell)
    if 0 <= row < 9:
        for start, width, glyph in ((0, 5, GLYPHS[0]), (6, 5, GLYPHS[1]), (12, 7, GLYPHS[2])):
            if start <= col < start + width and glyph[row][col - start] == "1":
                return (0xF1, 0xFA, 0xFF, 255)
    return (*base, 255)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_icon(path: Path, size: int) -> None:
    rows = bytearray()
    offsets = (0.25, 0.75)
    for py in range(size):
        shade = (py + 0.5) / size
        base = tuple(round(a + (b - a) * shade) for a, b in zip(TOP, BOTTOM))
        rows.append(0)
        for px in range(size):
            samples = [paint((px + x) / size, (py + y) / size, base) for y in offsets for x in offsets]
            visible = [sample for sample in samples if sample[3]]
            if not visible:
                rows.extend((0, 0, 0, 0))
                continue
            channels = [sum(sample[channel] for sample in visible) // len(visible) for channel in range(3)]
            rows.extend((*channels, round(255 * len(visible) / len(samples))))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(rows, 9))
        + png_chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    for name, size in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 1024)):
        write_icon(ICONS / name, size)
    write_icon(WEB_ICON, 128)
    # Regenerate icon.ico from icon.png with cargo tauri icon into a temporary directory.
