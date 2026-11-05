#!/usr/bin/env python3
"""Pool raw k6 samples from one or more runs and print percentiles.

  python3 tests/load/summarize.py raw-run1.json raw-run2.json ...

Percentiles are computed over all samples together (averaging per-run
percentiles would be wrong). Nearest-rank method.
"""
import json
import math
import sys
from collections import defaultdict

TRENDS = [
    ("lab_start_warm", "Start lab: warm (POST /api/labs -> 201)"),
    ("lab_start_cold", "Start lab: cold (POST /api/labs -> 201, pod Ready)"),
    ("lab_time_to_usable_warm", "Click -> terminal answers 200: warm"),
    ("lab_time_to_usable_cold", "Click -> terminal answers 200: cold"),
    ("lab_request_authed", "Authenticated request to own lab (Traefik + ForwardAuth + ttyd)"),
]
COUNTERS = ["lab_created", "lab_rejected_capacity", "lab_start_other_status"]


def pct(values, p):
    s = sorted(values)
    return s[max(0, math.ceil(p / 100 * len(s)) - 1)]


def fmt(ms):
    return f"{ms / 1000:.2f} s" if ms >= 1000 else f"{ms:.1f} ms"


samples = defaultdict(list)
counts = defaultdict(int)
for path in sys.argv[1:]:
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("type") != "Point":
                continue
            m, v = d["metric"], d["data"]["value"]
            if m in dict(TRENDS):
                samples[m].append(v)
            elif m in COUNTERS:
                counts[m] += int(v)

print(f"runs: {len(sys.argv) - 1}")
print("| Measurement | n | p50 | p95 | max |")
print("|---|---|---|---|---|")
for key, label in TRENDS:
    v = samples[key]
    if v:
        print(f"| {label} | {len(v)} | {fmt(pct(v, 50))} | {fmt(pct(v, 95))} | {fmt(max(v))} |")
print()
for c in COUNTERS:
    print(f"{c}: {counts[c]}")
