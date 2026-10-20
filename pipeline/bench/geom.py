import math, datetime
COLS, CW, CH, TW, TH, K = 77, 480, 270, 960, 540, 7
CAP_ROWS = 256
W0 = COLS*CW
d0 = datetime.date(2009,1,1)
date = lambda n: d0 + datetime.timedelta(days=n-1)
print("capacity", COLS*CAP_ROWS, "last date", date(COLS*CAP_ROWS), "canvas", W0, "x", CAP_ROWS*CH)
for n in (5852, 6502, 7000, 8000, 10000, 12000, 15000, 19712):
    rows = math.ceil(n/COLS); print(f"N={n} date={date(n)} rows={rows} H={rows*CH} aspect={W0/(rows*CH):.2f}")
def span(k): return 2**(k+1)  # cells per tile side at level k
def tiles_existing(N, k):
    rows = math.ceil(N/COLS); s = span(k); cnt=0
    for ty in range(math.ceil(rows/s)):
        for tx in range(math.ceil(COLS/s)):
            first = ty*s*COLS + tx*s + 1  # first cell (row-major) in tile = top-left
            if first <= N: cnt+=1
    return cnt
tot=0
print("k | level W x capH | cell px | tile grid (cap) | tiles exist N=6502 | N=19712")
for k in range(K+1):
    lw = W0/2**k; lh = CAP_ROWS*CH/2**k; s=span(k)
    g=(math.ceil(lw/TW), math.ceil(lh/TH)); e=tiles_existing(6502,k); tot+=e
    print(k, f"{lw:g} x {lh:g}", f"{CW/2**k:g}x{CH/2**k:g}", f"{s}x{s} cells", g, e, tiles_existing(19712,k))
print("total tiles N=6502:", tot, " N=19712:", sum(tiles_existing(19712,k) for k in range(K+1)))
# version function: newest song inside tile given songCount
def tile_of(n,k):
    c=(n-1)%COLS; r=(n-1)//COLS; s=span(k); return (c//s, r//s)
def version(k,tx,ty,N):
    s=span(k); c0,c1=tx*s,min(COLS-1,tx*s+s-1); r0,r1=ty*s,ty*s+s-1
    rl=(N-1)//COLS; cl=(N-1)%COLS
    if rl>r1: return r1*COLS+c1+1
    if rl<r0: return 0
    if cl>=c0: return rl*COLS+min(cl,c1)+1
    if rl>r0: return (rl-1)*COLS+c1+1
    return 0
# brute-force check version() and "exactly one tile per level changes per day"
import itertools
bad=0
for N in range(6400, 7300):
    for k in range(K+1):
        s=span(k)
        for ty in range(math.ceil(CAP_ROWS/s)):
            for tx in range(math.ceil(COLS/s)):
                # brute: max n<=N in tile
                v=0
                for r in range(ty*s, ty*s+s):
                    for c in range(tx*s, min(COLS, tx*s+s)):
                        n=r*COLS+c+1
                        if n<=N: v=max(v,n)
                if v!=version(k,tx,ty,N): bad+=1
        changed=[(tx,ty) for ty in range(math.ceil(CAP_ROWS/s)) for tx in range(math.ceil(COLS/s)) if version(k,tx,ty,N)!=version(k,tx,ty,N-1)]
        if changed!=[tile_of(N,k)]: bad+=1
print("version()/one-tile-per-level check mismatches over N=6400..7299:", bad)
# lifetime versions per level (how many distinct keys ever written) up to capacity
for k in range(K+1):
    s=span(k); ntiles=tiles_existing(19712,k); writes=19712  # one write per level per day
    print(f"k={k}: tiles at capacity={ntiles}, total writes over lifetime={writes}, avg versions/tile={writes/ntiles:.1f}")
# home view: which level is sharpest needed, tiles visible
def home(N, vw, vh, dpr):
    rows=math.ceil(N/COLS); W=W0; H=rows*CH
    scale=min(vw*dpr/W, vh*dpr/H)  # device px per image px
    out=[]
    for k in range(K+1):
        lvscale=1/2**k
        ratio=lvscale/scale  # level px per device px
        s=span(k)
        tx=math.ceil(COLS/s); ty=math.ceil(rows/s)
        out.append((k, round(ratio,2), tx*ty))
    return scale, out
for (vw,vh,dpr) in ((1440,840,2),(1920,1020,1),(390,700,3)):
    sc,o=home(6502,vw,vh,dpr); print(f"home {vw}x{vh}@{dpr}: scale={sc:.4f}", o)
