#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The stand-in program of the installer lane (#982): what `bin/factory-runner` of a release is in the lane. It registers,
# says its version and, as `run`, probes what the unit's sandbox lets a service do and then waits for a staged release like
# the real dispatcher does (`lane_service.py`).
here="$(dirname "$(readlink -f "$0")")"
case "${1:-}" in
  --version) echo "factory-runner lane (release @RELEASE@)" ;;
  credential) if [ -f "${FACTORY_RUNNER_HOME:?}/registered" ]; then echo "credential: set"; else echo "credential: not set"; fi ;;
  register) cat >/dev/null; echo registered >"${FACTORY_RUNNER_HOME:?}/registered" ;;
  config) cat >/dev/null ;;
  run) exec python3 "$here/../share/lane_service.py" ;;
esac
