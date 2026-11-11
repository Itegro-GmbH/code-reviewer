# Spike #1005: Incus as the one local backend

Scripts of the spike in `docs/runner.md`, "Spike: Incus (LXD) backend (#1005)". **Not product code**: nothing here is imported by the runner, and the PR that
carries the findings is docs only. The scripts live on the branch `spike-1005-incus`.

| File | What |
|---|---|
| `lib.sh` | `ix`, `ixe`, `ixs`: run `incus` in the group `incus-admin` without a new login, quiet |
| `setup.sh`, `build-image.sh`, `teardown.sh` | the objects (pool, networks, ACL, profile, golden image) and their removal; **written down from commands run by hand, not run as scripts** |
| `jobset.sh <job> <slot>` | one whole job set (A: Control and doors, B: setup and agent) from nothing to nothing, with timings; run as it is |
| `inner-wall.nft`, `acl-outer.yaml` | the inner wall (loaded inside A) and the outer wall's ACL |
| `proxy.py`, `decoy.py`, `ctl-echo.py`, `ctl-client.py` | the host proxy stand-in (not the product's), a decoy listener on every host address, the control channel's two ends |
| `probe.sh`, `srcprobe.py`, `outer-targets.txt` | the probes (REACHED / REFUSED / BLOCKED) |
| `reap.sh`, `time-start.sh`, `bench.sh`, `q1-docker-in-incus.sh` | the reaper, start timing, micro-benchmarks, the Q1 battery |
| `same-instance.sh <job> <slot>` | the second run (Incus 7.6, btrfs pool `crpool`): one job set where **setup and agent run in the same instance**, with the inner and the outer wall each probed with a control, the setup's Postgres used and stopped by the agent, and the control channel; needs `SPIKE_POOL=crpool setup.sh`, `build-image.sh`, the host proxy, `decoy.py 9999`, `ctl-echo.py`, and `HOST_V4`/`HOST_V6` in the environment (never in a file) |

`outer-targets.txt` holds `@HOST_V4@` and `@HOST_V6@` where the spike probed the machine's own public addresses (left out of the repository):
`sed "s/@HOST_V4@/$(your v4)/; s/@HOST_V6@/$(your v6)/" outer-targets.txt | tr '\n' ' ' | xargs ./probe.sh` inside the instance.
