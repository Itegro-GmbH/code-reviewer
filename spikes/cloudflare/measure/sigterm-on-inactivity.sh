# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: SIGTERM handler that calls the door when the instance is stopped for inactivity. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
cat > /tmp/sig.sh <<'SH'
on_term() { curl -s -m 3 "http://example.com/hb?SIGTERM_at=$(date +%s)" -o /dev/null; echo term > /tmp/got_term; exit 0; }
trap on_term TERM
while true; do sleep 1; done
SH
nohup bash /tmp/sig.sh >/dev/null 2>&1 &
date +%s > /tmp/t_start; echo "armed at $(date +%T)"
