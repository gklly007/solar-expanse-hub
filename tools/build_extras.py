#!/usr/bin/env python3
"""
build_extras.py  —  Additively enrich gamedata.json from the stockmaj wiki.

The original full dataset (research, spacecraft, celestial bodies, the build
calculator data) is produced by build_data.py from the game's asset-bundle dump.
This script ADDS reference data that build wasn't carrying yet (pulled from the
stockmaj/solar-expanse-wiki markdown) and enriches modules in place:

  * resources       10 -> 21  (+ type, Earth license, market price, producers/consumers, description)
  * space_modules + crew_transports : enriched with role / mines / cargo / build cost / time /
                    description from tools/module_enrichment.json (verified wiki<->calc id map)
  * launch_vehicles (new, 12)
  * launch_methods  (new, 6 - Space Elevator, Mass Driver, ...)
  * contracts       (new)
  * achievements    (new)
  * corporations    (new, scenario -> playable corps)
  * asteroid_taxonomy (new, per-class resource yields)

The other verified categories (research, spacecraft, facilities, celestial bodies,
reductions, spacecraft_cargo, terraforming) are asserted byte-unchanged.

Run:  python tools/build_extras.py --write      (omit --write for a dry run)
Source: https://github.com/stockmaj/solar-expanse-wiki (docs/). Re-run after a
game/wiki update. Verified categories are asserted byte-unchanged.
"""
import sys, os, re, json, tempfile, urllib.request

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # diagnostics only; data is written UTF-8 regardless
except Exception: pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMEDATA = os.path.join(REPO, "data", "gamedata.json")
BASE = "https://raw.githubusercontent.com/stockmaj/solar-expanse-wiki/main/docs/"
CACHE = os.path.join(tempfile.gettempdir(), "se_wiki_cache")

PROTECTED = ["meta", "research", "spacecraft", "planets", "moons", "asteroids",
             "comets", "exoplanets", "facilities", "reductions",
             "spacecraft_cargo", "terraforming"]

def get(relpath):
    os.makedirs(CACHE, exist_ok=True)
    fn = os.path.join(CACHE, relpath.replace("/", "__"))
    if os.path.exists(fn):
        return open(fn, encoding="utf-8").read()
    txt = urllib.request.urlopen(BASE + relpath, timeout=30).read().decode("utf-8")
    open(fn, "w", encoding="utf-8").write(txt)
    return txt

# ---- markdown helpers -------------------------------------------------------
def md_tables(text):
    out, cur = [], []
    for ln in text.splitlines():
        if ln.strip().startswith("|"):
            cur.append(ln.strip())
        else:
            if len(cur) >= 2: out.append(cur)
            cur = []
    if len(cur) >= 2: out.append(cur)
    return out

def cells(row): return [c.strip() for c in row.strip("|").split("|")]
def header(tbl): return [detag(c) for c in cells(tbl[0])]
def rows(tbl): return [cells(r) for r in tbl[2:]]

def anchor(s):
    m = re.search(r'<a id="([^"]+)"', s)
    return m.group(1) if m else None

def detag(s):
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&le;", "<=").replace("&ge;", ">=").replace("&times;", "x")
    return re.sub(r"\s+", " ", s).strip()

def demd(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    return s.replace("**", "").replace("`", "")

def clean(s): return demd(detag(s)).strip()

def numk(s):
    s = re.sub(r"<[^>]+>", "", str(s)).replace(",", "").replace("&nbsp;", " ").strip()
    m = re.search(r"(-?\d*\.?\d+)\s*([kmbtKMBT]?)", s)
    if not m: return None
    return round(float(m.group(1)) * {"": 1, "k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}[m.group(2).lower()], 4)

def md_links(cell):
    if detag(cell) in ("", "-", "—"): return []
    names = re.findall(r"\[([^\]]+)\]\([^)]*\)", cell)
    return [demd(detag(n)) for n in names] if names else ([clean(cell)] if clean(cell) else [])

def cost_cell(cell):
    out = []
    for m in re.finditer(r'resources/([a-z0-9]+)\.png"[^>]*>\s*(?:&nbsp;)?\s*([\d.,]+\s*[kmbtKMBT]?)?', cell):
        rid, amt = m.group(1), m.group(2)
        out.append({"resource": rid, "amount": numk(amt)} if amt and re.search(r"\d", amt) else {"resource": rid})
    return out

def col(hdr, *names):
    low = [h.lower() for h in hdr]
    for n in names:                       # exact header match wins ("Launch" vs "Launch Vehicle")
        if n.lower() in low: return low.index(n.lower())
    for n in names:                       # then substring
        for i, h in enumerate(low):
            if n.lower() in h: return i
    return None

def name_cell(c): return clean(re.sub(r'<a id[^>]*></a>', "", c))

# ---- parsers ----------------------------------------------------------------
def parse_resources():
    t = md_tables(get("resources/README.md"))[0]
    h = header(t); out = []
    for r in rows(t):
        out.append({
            "id": (anchor(r[0]) or "").replace("resource-", ""),
            "name": name_cell(r[0]),
            "type": detag(r[col(h, "Type")]),
            "license": numk(r[col(h, "License")]),
            "market_base": numk(r[col(h, "Market")]),
            "producers": md_links(r[col(h, "Producers")]),
            "consumers": md_links(r[col(h, "Consumers")]),
            "description": clean(r[col(h, "Description")]),
        })
    return out

def parse_launch_vehicles():
    out = []
    for t in md_tables(get("launch-vehicles/README.md")):
        h = header(t)
        if not h[0].lower().startswith("launch vehicle"): continue
        for r in rows(t):
            out.append({
                "id": (anchor(r[0]) or "").replace("lv-", ""),
                "name": name_cell(r[0]),
                "payload_t": numk(r[col(h, "Payload")]),
                "reusable": detag(r[col(h, "Reusable")]),
                "crew": detag(r[col(h, "Crew")]),
                "max_g": detag(r[col(h, "Max G")]),
                "build_cost": cost_cell(r[col(h, "Build cost")]),
                "build_time_days": numk(r[col(h, "Time")]),
                "launch_cost": numk(r[col(h, "Launch")]),
                "maint_per_mo": numk(r[col(h, "Maint")]),
                "description": clean(r[col(h, "Description")]),
            })
    return out

def parse_launch_methods():
    out = []
    for t in md_tables(get("launch-vehicles/README.md")):
        h = header(t)
        if not h[0].lower().startswith("method"): continue
        for r in rows(t):
            out.append({
                "name": name_cell(r[0]),
                "build_cost": cost_cell(r[col(h, "Build cost")]),
                "build_time_days": numk(r[col(h, "Time")]),
                "workers": numk(r[col(h, "Workers")]),
                "energy": numk(r[col(h, "Energy")]),
                "maint_per_mo": numk(r[col(h, "Maint")]),
                "launch_bonus": detag(r[col(h, "Launch bonus")]) if col(h, "Launch bonus") is not None else None,
                "prereq": clean(r[col(h, "Prereq")]) if col(h, "Prereq") is not None else None,
                "description": clean(r[col(h, "Description")]),
            })
    return out

def parse_contracts():
    t = md_tables(get("contracts/README.md"))[0]
    h = header(t); out = []
    splitbr = lambda c: [clean(x) for x in re.split(r"<br\s*/?>", c) if clean(x)]
    for r in rows(t):
        out.append({
            "order": int(re.sub(r"\D", "", r[0]) or 0),
            "id": (anchor(r[col(h, "Contract")]) or "").replace("contract-", ""),
            "name": name_cell(r[col(h, "Contract")]),
            "prereq": clean(r[col(h, "Prereq")]),
            "requirements": splitbr(r[col(h, "Requirements")]),
            "rewards": splitbr(r[col(h, "Rewards")]),
            "premise": clean(r[col(h, "Premise")]),
        })
    return out

def parse_achievements():
    out = []
    for t in md_tables(get("achievements/README.md")):
        h = header(t)
        if "achievement" not in h[0].lower(): continue
        ei, ci, ti = col(h, "How to earn"), col(h, "Condition"), col(h, "Trigger")
        for r in rows(t):
            out.append({
                "name": clean(r[0]),
                "earn_via": clean(r[ei]) if ei is not None else None,
                "condition": clean(r[ci]) if ci is not None and clean(r[ci]) != "—" else None,
                "trigger": clean(r[ti]) if ti is not None else None,
            })
    return out

def parse_corporations():
    t = md_tables(get("corporations/README.md"))[0]
    return [{"scenario": clean(r[0]),
             "corporations": [c.strip() for c in clean(r[1]).split(",") if c.strip()]} for r in rows(t)]

def parse_asteroid_taxonomy():
    text = get("asteroid-taxonomy/README.md")
    out, cur, prose = [], None, []
    for ln in text.splitlines():
        m = re.match(r"^##\s+(.*?)\s*$", ln)
        if m:
            if cur: cur["description"] = " ".join(prose).strip(); out.append(cur)
            name = m.group(1)
            cur = {"name": name, "yields": [], "description": ""} if "see also" not in name.lower() else None
            prose = []
        elif cur is not None:
            if ln.strip().startswith("|"):
                c = cells(ln)
                if len(c) >= 3 and "---" not in ln and c[0].lower() != "tier" and detag(c[0]):
                    cur["yields"].append({"tier": detag(c[0]), "resource": detag(c[1]), "probability": detag(c[2])})
            elif ln.strip():
                prose.append(clean(ln))
    if cur: cur["description"] = " ".join(prose).strip(); out.append(cur)
    return [c for c in out if c]

# ---- merge ------------------------------------------------------------------
def main(write):
    G = json.load(open(GAMEDATA, encoding="utf-8"))
    # Correct a digit-transposition typo inherited from the wiki (planets.md lists
    # Saturn 368.3); the real/in-game mass is 568.34e24 kg (matches the game asset CSV).
    for _p in G["planets"]:
        if _p.get("name") == "Saturn" and _p.get("mass_e24kg") == 368.3:
            _p["mass_e24kg"] = 568.34
    before = {k: json.dumps(G.get(k), sort_keys=True) for k in PROTECTED if k != "meta"}

    resources = parse_resources()
    old_ids, new_ids = {x["id"] for x in G["resources"]}, {x["id"] for x in resources}
    assert old_ids <= new_ids, f"resource ids lost: {old_ids - new_ids}"

    # enrich space modules + crew transports in place from the verified wiki mapping (ids preserved)
    ME = json.load(open(os.path.join(REPO, "tools", "module_enrichment.json"), encoding="utf-8"))
    mods_applied = 0
    for arr in ("space_modules", "crew_transports"):
        for m in G[arr]:
            if m["id"] in ME:
                m.update(ME[m["id"]]); mods_applied += 1
    assert mods_applied == len(ME), "module enrichment: applied %d of %d" % (mods_applied, len(ME))

    G["resources"] = resources
    G["launch_vehicles"] = parse_launch_vehicles()
    G["launch_methods"] = parse_launch_methods()
    G["contracts"] = parse_contracts()
    G["achievements"] = parse_achievements()
    G["corporations"] = parse_corporations()
    G["asteroid_taxonomy"] = parse_asteroid_taxonomy()
    G["meta"]["extras_generated_by"] = "tools/build_extras.py (from stockmaj/solar-expanse-wiki)"

    for k, v in before.items():
        assert v == json.dumps(G.get(k), sort_keys=True), f"PROTECTED category changed: {k}"

    print("=== build_extras", "WROTE" if write else "dry-run", "===")
    print(f"resources        : {len(resources)}  (was {len(old_ids)})")
    print(f"launch_vehicles  : {len(G['launch_vehicles'])}")
    print(f"launch_methods   : {len(G['launch_methods'])}")
    print(f"contracts        : {len(G['contracts'])}")
    print(f"achievements     : {len(G['achievements'])}")
    print(f"corporations     : {len(G['corporations'])} scenarios")
    print(f"asteroid_taxonomy: {len(G['asteroid_taxonomy'])} -> {[c['name'] for c in G['asteroid_taxonomy']]}")
    print(f"modules enriched : {mods_applied} (space_modules {len(G['space_modules'])} + crew_transports {len(G['crew_transports'])})")
    print("\nSAMPLES")
    print(" resource:", json.dumps(resources[7], ensure_ascii=False))
    print(" LV      :", json.dumps(G["launch_vehicles"][0], ensure_ascii=False))
    print(" method  :", json.dumps(G["launch_methods"][0], ensure_ascii=False))
    print(" contract:", json.dumps(G["contracts"][2], ensure_ascii=False)[:320])
    print(" achiev. :", json.dumps(G["achievements"][0], ensure_ascii=False))

    if write:
        json.dump(G, open(GAMEDATA, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print(f"\nWrote {GAMEDATA}")

if __name__ == "__main__":
    main("--write" in sys.argv)
