#!/usr/bin/env python3
"""Spike #970: turn results/*.json into Markdown (the job summary) and judge T02 (control against wall).
Usage: report.py <results dir>   prints Markdown; exit 1 when the T02 judgement fails."""
import json
import pathlib
import sys

res = pathlib.Path(sys.argv[1])
out: list[str] = []
status = 0


def load(name: str):
    p = res / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None


for name in ("smoke", "t01", "t03", "disk", "q4", "t02-pull", "timing"):
    d = load(name)
    if d is None:
        out.append(f"### {name}\nnot run\n")
        continue
    out.append(f"### {name}")
    for c in d.get("checks", []):
        out.append(f"- {'PASS' if c['ok'] else 'FAIL'} {c['name']}" + (f" ({c['detail']})" if c["detail"] else ""))
    out.append("")

c, w = load("t02-control"), load("t02-wall")
out.append("### T02 network wall")
if not (c and w):
    out.append("not run (control and wall both needed)\n")
    status = 1
else:
    cr = {x["name"]: x for x in c["results"]}
    wr = {x["name"]: x for x in w["results"]}
    reach = ("connected", "refused", "answered")
    informational = ("internet", "metadata 169.254.169.254")
    out.append("| target | control (no wall) | wall | verdict |")
    out.append("|---|---|---|---|")
    for name, x in wr.items():
        ctl = cr.get(name, {}).get("result", "missing")
        is_proxy = name.startswith("proxy")
        info = name.startswith(informational)
        if is_proxy:
            ok = x["result"] == "connected" and ctl == "connected"
            verdict = "reachable as intended" if ok else "PROXY NOT REACHABLE"
        elif ctl not in reach:
            ok = info  # a fixture the control could not reach proves nothing; the real internet/IMDS may simply be absent
            verdict = ("control could not reach it, so it proves nothing" + ("" if ok else " (FIXTURE BROKEN)")) if True else ""
            if x["result"] in reach:
                ok, verdict = False, "REACHABLE THROUGH THE WALL"
        else:
            ok = x["result"] not in reach
            verdict = "blocked (control reached it)" if ok else "REACHABLE THROUGH THE WALL"
        if not ok:
            status = 1
        out.append(f"| {name} | {ctl} | {x['result']} | {verdict} |")
    out.append("")
print("\n".join(out))
sys.exit(status)
