#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: what the next dispatcher does at start: delete every instance that carries a job mark of ours (config key user.cr.job).
# A mark is the only identity; instances without it (other users', the owner's) are never touched.
sg incus-admin -c "incus list --format json" | python3 -I -c '
import json, sys
for i in json.load(sys.stdin):
    if "user.cr.job" in i["config"]:
        print(i["name"])' | while read -r n; do sg incus-admin -c "incus delete -f $n" && echo "reaped $n"; done
