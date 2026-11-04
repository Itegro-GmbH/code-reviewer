# network-rule

The environment's rule for the agent's network (#745, step 7): `off`, `list` (host names, exact or `*.suffix`) or `open`, and the
check that brings a typed host to the one form it is stored and compared in. A module of its own, below `db`, `implementer` and
`runner-api`, which all need the same rule and must not import one another for it. The runner (`implementer/network_rule.py`) and the
Dispatcher (`network/rule.ts`) keep the same bounds, and a test of each holds them to `contracts/runner-api.v1.json`.
