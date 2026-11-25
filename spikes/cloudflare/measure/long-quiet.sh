# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a silent process, kept alive only by the DO alarm (long run, box b). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
nohup sh -c 'echo $$ > /tmp/quiet.pid; while true; do date +%s > /tmp/quiet.last; sleep 5; done' >/dev/null 2>&1 &
sleep 1; cat /tmp/quiet.pid; cut -d. -f1 /proc/uptime
