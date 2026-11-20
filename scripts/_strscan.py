import re, sys, os
pat = re.compile(rb'[\x20-\x7e]{5,}')
def scan(path, needles):
    data = open(path,'rb').read()
    hits = {}
    for m in pat.finditer(data):
        s = m.group().decode('ascii','ignore')
        low = s.lower()
        for n in needles:
            if n.lower() in low:
                hits.setdefault(n, set()).add(s[:220])
    return hits
if __name__ == '__main__':
    path = sys.argv[1]
    needles = sys.argv[2:]
    hits = scan(path, needles)
    for n in needles:
        ss = sorted(hits.get(n, []))
        print(f'### {n}  hits={len(ss)}')
        for s in ss[:12]:
            print('   ', s)
