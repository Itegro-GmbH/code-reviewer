#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Turns the samples of the Incus/Docker bench (#1013, see lib.sh for the format) into Markdown.

Exit status 1 when a series that is not a control (`ctl.` prefix) has a FAILED sample, or fewer good samples than the series promised
(`expect_samples`): a bench whose commands failed must not produce numbers that look like a result. Controls may fail: they are
what the bench tries to find out with, and the table says so.
"""

import argparse
import statistics
import sys
from collections import OrderedDict

# The metrics every variant is compared on in the second table, in the order of one `docker run` (split into its parts).
COMPARED = [
    "run.total",
    "split.create",
    "split.start",
    "split.wait",
    "split.rm",
    "split.total",
    "opt.nonet",
    "opt.unconfined",
    "ctl.api.ps",
    "ctl.client.version",
    "ctl.spawn200",
    "ctl.fsync20",
    "ctl.runc",
    "ctl.ctr",
]


def read_samples(path):
    """variant -> metric -> {first, ok: [float], failed: [note], expect: int | None}, in order of appearance."""
    variants = OrderedDict()
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) < 4:
                raise ValueError(f"{path}:{number}: expected at least 4 tab-separated fields, got {len(fields)}")
            variant, metric, rep, value = fields[:4]
            note = fields[4] if len(fields) > 4 else ""
            series = variants.setdefault(variant, OrderedDict()).setdefault(
                metric, {"first": None, "ok": [], "failed": [], "expect": None}
            )
            if rep == "n":
                series["expect"] = int(float(value))
            elif value == "FAILED":
                series["failed"].append(f"rep {rep}: {note}")
            elif rep == "0":
                series["first"] = float(value)
            else:
                series["ok"].append(float(value))
    return variants


def is_control(metric):
    return metric.startswith("ctl.")


def problems(variants):
    found = []
    for variant, metrics in variants.items():
        for metric, series in metrics.items():
            if is_control(metric):
                continue
            if series["failed"]:
                found.append(f"{variant} {metric}: {len(series['failed'])} failed sample(s), first: {series['failed'][0]}")
            if series["expect"] is not None and len(series["ok"]) < series["expect"]:
                found.append(f"{variant} {metric}: {len(series['ok'])} good samples, {series['expect']} expected")
    return found


def seconds(value):
    return "" if value is None else f"{value:.2f}"


def per_variant(variants):
    lines = []
    for variant, metrics in variants.items():
        lines += [f"#### {variant}", "", "| metric | n | median | min | max | first (warm-up, s) |", "|---|---|---|---|---|---|"]
        for metric, series in metrics.items():
            if series["expect"] is not None and not series["ok"] and not series["failed"]:
                continue
            ok = series["ok"]
            tried = len(ok) + len(series["failed"])
            count = f"{len(ok)}/{tried} FAILED" if series["failed"] else str(len(ok))
            if ok:
                lines.append(
                    f"| {metric} | {count} | {statistics.median(ok):.2f} | {min(ok):.2f} | {max(ok):.2f} | {seconds(series['first'])} |"
                )
            else:
                lines.append(f"| {metric} | {count} | | | | {seconds(series['first'])} |")
        lines.append("")
    return lines


def comparison(variants):
    names = list(variants)
    lines = ["#### Median seconds, all variants", "", "| metric | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for metric in COMPARED:
        cells = []
        seen = False
        for variant in names:
            series = variants[variant].get(metric)
            if series and series["ok"]:
                cells.append(f"{statistics.median(series['ok']):.2f}")
                seen = True
            elif series and series["failed"]:
                cells.append("FAILED")
                seen = True
            else:
                cells.append("")
        if seen:
            lines.append(f"| {metric} | " + " | ".join(cells) + " |")
    lines.append("")
    return lines


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", help="the TSV file the bench wrote")
    args = parser.parse_args(argv)
    variants = read_samples(args.samples)
    found = problems(variants)
    lines = []
    if found:
        lines += ["### FAILED: these numbers are not a result", ""] + [f"- {item}" for item in found] + [""]
    lines += comparison(variants) + per_variant(variants)
    sys.stdout.write("\n".join(lines) + "\n")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
