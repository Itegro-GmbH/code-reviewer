#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Bootstrap of the second App ("factory", #732): lists every Infisical entry and Vercel setting the factory lane needs
# and, only when the owner asks with --out, generates the random secrets of the clone into a new file that only the
# owner can read (mode 0600).
#
#   factory-bootstrap.sh                  prints the entries and the Vercel checklist; generates nothing, writes nothing
#   factory-bootstrap.sh --out <file>     also generates the five secrets into <file> (NAME=value lines)
#
# A secret is never printed, never put on a command line and never traced: it lives in shell variables, goes to the
# file through the built-in printf, and the script switches `set -x` off first thing. The script reads no file (no
# .env*, nothing) and takes no value from the environment. It refuses an existing file, a file called .env*, and a
# path in a git checkout. Delete the file once the values are in Infisical.
{ set +x; } 2> /dev/null
set -euo pipefail
umask 077

usage() {
  echo "usage: factory-bootstrap.sh [--out <new file, mode 0600>]" >&2
  exit 2
}

out=""
case "$#" in
  0) ;;
  2)
    [ "$1" = "--out" ] || usage
    out="$2"
    if [ -z "${out}" ]; then
      echo "--out needs a file name, not an empty one." >&2
      usage
    fi
    ;;
  *) usage ;;
esac

# The entries. `generated` ones get a random value with --out; `reference` ones are Infisical secret references
# (docs/deployment-vercel.md, section 5.8); `fixed` ones have the one value shown in the table; `yours` ones need a value
# only the owner has. The table is the single list: docs/factory-bring-up.md, step 3, points here.
entries=(
  "/app-factory|PRODUCT_ID|fixed: factory|Mandatory: which product this deployment is. Without it the clone starts as code-review-com"
  "/app-factory|PRODUCT_CAPABILITIES|fixed: review,dynamic-review|Billing off. This is the start value; the Implementer rollout changes it together with the repository variable FACTORY_EXPECTED_CAPABILITIES, which health-factory compares exactly with the set the staged App reports (docs/factory-bring-up.md)"
  "/app-factory|APP_SECRET|generated (base64)|The master key. Keep a copy of this one in a password manager: it cannot be rotated"
  "/app-factory|RUNNER_TOKEN|generated (hex)|The factory App's dispatcher credential"
  "/app-factory|CRON_SECRET|generated (hex)|Opens the factory App's cron routes. Its own value"
  "/app-factory|RUNNER_WEBHOOK_SECRET|generated (hex)|The key the factory App signs wake-ups with"
  "/app-factory|RUNNER_DISPATCH|fixed: webhook|Without it the App stays in poll mode and nothing wakes the Dispatcher"
  "/app-factory|RUNNER_WEBHOOK_URL|yours|https://<dispatcher production domain>/dispatch (the same Dispatcher as code-review.com)"
  "/app-factory|RUNNER_WEBHOOK_KEY_ID|fixed: factory-k1|Must equal keyId of the factory entry in DISPATCHER_APPS"
  "/app-factory|RUNNER_DISPATCH_MAX_RUNNING|fixed: 2|Must equal maxRunning of the factory entry in DISPATCHER_APPS"
  "/app-factory|RUNNER_WEBHOOK_BYPASS_TOKEN|reference|Only if the Dispatcher is protected: \${prod.ci.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET}"
  "/app-factory|DATABASE_URL|yours|The factory database's app role URL (a direct connection)"
  "/app-factory|BETTER_AUTH_URL|yours|https://<factory project>.vercel.app"
  "/ci|DISPATCHER_OPERATOR_TOKEN|generated (hex)|Opens /probe and /apps/check of the Dispatcher; the pipeline reads it"
  "/ci|DATABASE_URL_MIGRATE_FACTORY|yours|The factory database's migrate role URL (a direct connection)"
  "/ci|VERCEL_FACTORY_PROJECT_ID|yours|The id of the factory's Vercel project"
  "/ci|VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET|yours|The factory project's Protection Bypass for Automation secret"
  "/dispatcher|DISPATCHER_APP_FACTORY_TOKEN|reference|\${prod.app-factory.RUNNER_TOKEN}"
  "/dispatcher|DISPATCHER_APP_FACTORY_SIGNING_SECRET|reference|\${prod.app-factory.RUNNER_WEBHOOK_SECRET}"
  "/dispatcher|DISPATCHER_OPERATOR_TOKEN|reference|\${prod.ci.DISPATCHER_OPERATOR_TOKEN}"
  "/dispatcher|DISPATCHER_APPS|yours|One line, the factory entry: {\"id\":\"factory\",\"url\":\"<BETTER_AUTH_URL>\",\"kinds\":[\"diff\",\"dynamic\"],\"keyId\":\"factory-k1\",\"maxRunning\":2} in a JSON array (the Implementer rollout adds \"implementer\" to kinds, docs/factory-bring-up.md)"
)

echo "Infisical entries of the factory lane (environment prod):"
printf '  %-14s %-42s %-36s %s\n' "Folder" "Key" "Value" "Note"
for entry in "${entries[@]}"; do
  IFS='|' read -r folder key kind note <<< "${entry}"
  printf '  %-14s %-42s %-36s %s\n' "${folder}" "${key}" "${kind}" "${note}"
done
echo
echo 'Vercel project of the factory (dashboard, once):'
echo '  - Root directory: app. "Include source files outside of the Root Directory" on. Node.js 24.x. Framework Next.js.'
echo '  - Git auto-deploy off (the pipeline deploys with the CLI). Protection Bypass for Automation on.'
echo '  - The production alias https://<project>.vercel.app stays unprotected: it is BETTER_AUTH_URL.'
echo '  - Infisical Secret Sync: source prod /app-factory to this project, environment Production, auto-sync on.'
echo
echo 'Then set the repository variable FACTORY_ENABLED to true. Everything else is optional or deferred'
echo '(docs/factory-bring-up.md).'

if [ -z "${out}" ]; then
  echo
  echo "Nothing was generated. Run again with --out <new file> to generate the five secrets."
  exit 0
fi

case "$(basename -- "${out}")" in
  .env*)
    echo "Refusing a file called .env*: pick another name." >&2
    exit 1
    ;;
esac
if [ -e "${out}" ] || [ -L "${out}" ]; then
  echo "Refusing to overwrite ${out}." >&2
  exit 1
fi
directory="$(dirname -- "${out}")"
if [ ! -d "${directory}" ]; then
  echo "The directory of ${out} does not exist." >&2
  exit 1
fi
if git -C "${directory}" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Refusing a path inside a git checkout: pick one outside, so that a secret can never be committed." >&2
  exit 1
fi

hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}
base64_32() {
  head -c 32 /dev/urandom | base64 | tr -d '\n'
}

# Created empty and 0600 before any value is written (the umask already makes it so; this makes it explicit).
# noclobber: the redirection fails if the file appeared since the check above, instead of following or truncating it.
set -C
if ! : > "${out}"; then
  echo "Refusing to overwrite ${out}." >&2
  exit 1
fi
set +C
chmod 600 "${out}"

# Five different values. A collision of 256-bit random values is not a case; the check is cheap and keeps the rule of
# the guide ("different from every other secret") visible.
seen=""
for name in APP_SECRET RUNNER_TOKEN CRON_SECRET RUNNER_WEBHOOK_SECRET DISPATCHER_OPERATOR_TOKEN; do
  if [ "${name}" = "APP_SECRET" ]; then
    value="$(base64_32)"
  else
    value="$(hex)"
  fi
  case " ${seen} " in
    *" ${value} "*)
      echo "Generated the same value twice; run again." >&2
      exit 1
      ;;
  esac
  seen="${seen} ${value}"
  printf '%s=%s\n' "${name}" "${value}" >> "${out}"
  value=""
done
seen=""

echo
echo "Wrote the five secrets to ${out} (mode 0600). Paste each into its Infisical key (above), then delete the file."
