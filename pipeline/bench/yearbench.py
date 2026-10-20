#!/usr/bin/env python3
"""Benchmark: build one calendar-year pyramid (12 month rows x 31 day cols) with vips.

usage: yearbench.py YEAR LAST_SONG OUTNAME [--cw 512 --ch 288 --q 78 --tile 512]
Reads only real (non-placeholder) stills; never hydrates Dropbox placeholders.
Writes its cells and output under $BENCH_DIR (default $SONGADAY_DISPLAY_CACHE_DIR/bench, which is
~/Library/Caches/songaday-display/bench), never into the repo. Needs SONGADAY_ARCHIVE_DIR and vips.
"""
import datetime as dt, hashlib, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

CACHE = os.path.expanduser(os.environ.get("SONGADAY_DISPLAY_CACHE_DIR") or "~/Library/Caches/songaday-display")
BENCH = os.path.expanduser(os.environ.get("BENCH_DIR") or os.path.join(CACHE, "bench"))
ARCH = os.path.expanduser(os.environ.get("SONGADAY_ARCHIVE_DIR") or sys.exit("set SONGADAY_ARCHIVE_DIR (see .env.example)"))
STILLS = os.path.join(ARCH, "EverySongADayPNG")
# Optional second source. Its 5984-6000 are one repeated stand-in image, not real frames.
STD4K = os.path.expanduser(os.environ.get("STANDARDIZED_THUMBS_DIR", ""))
EPOCH = dt.date(2009, 1, 1)

args = sys.argv[1:]
YEAR, LAST, NAME = int(args[0]), int(args[1]), args[2]
opt = {"--cw": 512, "--ch": 288, "--q": 78, "--tile": 512}
for i in range(3, len(args), 2):
    opt[args[i]] = int(args[i + 1])
CW, CH, Q, TILE = opt["--cw"], opt["--ch"], opt["--q"], opt["--tile"]
CELLS = os.path.join(BENCH, f"cells_{CW}x{CH}")
os.makedirs(CELLS, exist_ok=True)


def song_for(d):
    return (d - EPOCH).days + 1


def real(p):
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return False
    r = subprocess.run(["xattr", p], capture_output=True, text=True)
    return "com.dropbox.placeholder" not in r.stdout


def source(n):
    extra = (os.path.join(STD4K, f"{n}_standardized.jpg"),) if STD4K else ()
    for p in (os.path.join(STILLS, f"{n}.jpg"), os.path.join(STILLS, f"{n}.png"), *extra):
        if real(p):
            return p
    return None


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def blank(name, grey):
    p = os.path.join(CELLS, f"_{name}.v")
    if not os.path.exists(p):
        t = p + ".tmp.v"
        run(["vips", "black", t, str(CW), str(CH), "--bands", "3"])
        run(["vips", "linear", t, p, "1", str(grey), "--uchar"])
        os.remove(t)
    return p


def missing_card(n):
    p = os.path.join(CELLS, f"m{n}.v")
    if not os.path.exists(p):
        t1, t2, t3 = p + ".a.v", p + ".b.v", p + ".c.v"
        run(["vips", "text", t1, f"#{n}", "--font", "sans bold 28", "--dpi", "144"])
        w = int(subprocess.run(["vipsheader", "-f", "width", t1], capture_output=True, text=True).stdout)
        h = int(subprocess.run(["vipsheader", "-f", "height", t1], capture_output=True, text=True).stdout)
        run(["vips", "embed", t1, t2, str((CW - w) // 2), str((CH - h) // 2), str(CW), str(CH)])
        run(["vips", "linear", t2, t3, "0.55", "40", "--uchar"])
        run(["vips", "bandjoin", f"{t3} {t3} {t3}", p])
        for t in (t1, t2, t3):
            os.remove(t)
    return p


def cell(n):
    p = os.path.join(CELLS, f"{n}.v")
    if os.path.exists(p):
        return p, "cached"
    s = source(n)
    if not s:
        return missing_card(n), "missing"
    run(["vips", "thumbnail", s, p, str(CW), "--height", str(CH), "--crop", "centre", "--size", "both"])
    return p, os.path.basename(os.path.dirname(s))


t0 = time.time()
slots = []
for m in range(1, 13):
    for d in range(1, 32):
        try:
            day = dt.date(YEAR, m, d)
        except ValueError:
            slots.append(("none", None))
            continue
        n = song_for(day)
        slots.append(("song", n) if n <= LAST else ("future", n))

songs = [n for k, n in slots if k == "song"]
with ThreadPoolExecutor(8) as ex:
    results = dict(zip(songs, ex.map(cell, songs)))
t_cells = time.time() - t0
src_counts = {}
for _, (p, s) in results.items():
    src_counts[s] = src_counts.get(s, 0) + 1

none_p, fut_p = blank("none", 14), blank("future", 26)
paths = [results[n][0] if k == "song" else (fut_p if k == "future" else none_p) for k, n in slots]

out = os.path.join(BENCH, "out", NAME)
os.makedirs(out, exist_ok=True)
yv = os.path.join(out, "year.v")
t1 = time.time()
run(["vips", "arrayjoin", " ".join(paths), yv, "--across", "31"])
t_join = time.time() - t1

t2 = time.time()
run(["vips", "dzsave", yv, os.path.join(out, "y"), "--tile-size", str(TILE), "--overlap", "0",
     "--suffix", f".webp[Q={Q},effort=4,strip]", "--depth", "onepixel", "--keep", "none"])
t_dz = time.time() - t2
os.remove(yv)

tiles, per_level = {}, {}
root = os.path.join(out, "y_files")
for lvl in sorted([x for x in os.listdir(root) if x.isdigit()], key=int):
    for f in os.listdir(os.path.join(root, lvl)):
        b = open(os.path.join(root, lvl, f), "rb").read()
        tiles[f"{lvl}/{f}"] = hashlib.sha256(b).hexdigest()[:16]
        c, s = per_level.get(int(lvl), (0, 0))
        per_level[int(lvl)] = (c + 1, s + len(b))
json.dump(tiles, open(os.path.join(out, "tiles.json"), "w"), indent=0, sort_keys=True)
summary = {
    "year": YEAR, "last": LAST, "cell": [CW, CH], "tile": TILE, "q": Q,
    "songs_in_block": len(songs), "sources": src_counts,
    "sec_cells": round(t_cells, 2), "sec_arrayjoin": round(t_join, 2), "sec_dzsave": round(t_dz, 2),
    "tiles": len(tiles), "bytes": sum(s for _, s in per_level.values()),
    "per_level": {k: {"tiles": c, "bytes": s} for k, (c, s) in sorted(per_level.items())},
}
json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)
print(json.dumps(summary))
