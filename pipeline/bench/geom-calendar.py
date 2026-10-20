import datetime as dt, math
CW,CH,COLS,ROWS,T=512,288,31,12,512
W,H=COLS*CW,ROWS*CH
MAXL=math.ceil(math.log2(max(W,H))); MINL=8
E=dt.date(2009,1,1)
def song(d): return (d-E).days+1
def tiles_for_cell(r,c):
    out=[]
    for L in range(MINL,MAXL+1):
        s=2**(MAXL-L)
        x0=c*CW/s; x1=(c+1)*CW/s; y0=r*CH/s; y1=(r+1)*CH/s
        tx=range(int(x0//T), int(math.ceil(x1/T)))
        ty=range(int(y0//T), int(math.ceil(y1/T)))
        out+= [(L,x,y) for x in tx for y in ty]
    return out
print("year px",W,H,"maxLevel",MAXL)
for L in range(MINL,MAXL+1):
    s=2**(MAXL-L); w=W/s; h=H/s
    print(" L",L,f"{w:.0f}x{h:.0f}","tiles",math.ceil(w/T)*math.ceil(h/T))
cnt={}
for d in range(366):
    day=dt.date(2026,1,1)+dt.timedelta(d)
    if day.year!=2026: break
    n=len(tiles_for_cell(day.month-1,day.day-1)); cnt[n]=cnt.get(n,0)+1
print("tiles touched per daily add (levels 8-14) -> days:",dict(sorted(cnt.items())), "avg", sum(k*v for k,v in cnt.items())/sum(cnt.values()))
# world layout
GX,GY,M=512,576,512
for years in (18,19,24):
  for per in (1,2,3,4):
    rows=math.ceil(years/per)
    ww=per*W+(per-1)*GX+2*M; wh=rows*H+(rows-1)*GY+2*M
    print(f"years={years} perRow={per} world={ww}x{wh} aspect={ww/wh:.2f}")
# fill
print("first song of each year:",{y:song(dt.date(y,1,1)) for y in (2009,2025,2026,2027)}, "today", song(dt.date(2026,10,20)))
