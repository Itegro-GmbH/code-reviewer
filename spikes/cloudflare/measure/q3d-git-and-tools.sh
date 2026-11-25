# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: git over HTTPS and ssh, registries, own trust stores. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
echo "--- git clone over HTTPS through the door (CA in system store)"
rm -rf /tmp/hw; t git clone -q --depth 1 https://github.com/octocat/Hello-World.git /tmp/hw; ls /tmp/hw | head -3
echo "--- git over ssh (port 22)"; GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6' t git ls-remote git@github.com:octocat/Hello-World.git 2>&1 | tail -2
echo "--- tool with its own trust store: python certifi/requests-like (urllib uses system), go-like not available; curl with explicit --cacert none:"
t curl -sS -m 8 -o /dev/null -w "%{http_code}\n" --cacert /etc/ssl/certs/ca-certificates.crt https://example.com
t sh -c 'curl -sS -m 8 -o /dev/null -w "%{http_code}\n" --capath /nonexistent --cacert /dev/null https://example.com 2>&1 | tail -1'
echo "--- registry / big body (npm registry GET)"
t curl -sS -m 10 -o /dev/null -w "%{http_code} %{size_download}B\n" https://registry.npmjs.org/left-pad
echo "--- POST through the door to a listed host (registry write is the handler's call)"
t curl -sS -m 10 -o /dev/null -w "%{http_code}\n" -X PUT -d '{}' https://registry.npmjs.org/spike-fake-pkg
echo "--- throughput through the door: 20 MB from a listed host?"
t curl -sS -m 40 -o /dev/null -w "%{http_code} %{size_download}B %{speed_download} B/s\n" https://github.com/octocat/Hello-World/archive/refs/heads/master.zip
