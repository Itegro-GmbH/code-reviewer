# fakes/cf-sandbox

The double of the Cloudflare Worker `cr-sandbox` for the Dispatcher's Cloudflare `SandboxService` and `SandboxFleet` (`dispatcher/src/launchers/cf-sandbox.ts`, #1158). It speaks the API of
`contracts/cf-sandbox.v1.json` as a `fetch` function (no socket, no process): `new FakeCfSandbox({ token })` and hand `fake.fetch` to the client. Nothing here imports the Dispatcher.

| Method                                        | What it does                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `onExec(label or regular expression, answer)` | scripts a command; every other one ends with exit 0 and no output                            |
| `exitProcess(vm, code)`                       | ends the processes of a VM (the Worker's `docker run`)                                       |
| `failNext(status, body?)`                     | the next authenticated call is answered with that status                                     |
| `holdNextCreate()`                            | keeps the next create pending (returns the function that releases it) so a test can abort it |
| `healthDown()`                                | `GET /health` answers 503                                                                    |
| `seedVm({ name, tags, status })`              | a VM that no launch made, for the reaper                                                     |
| `requests`, `requestText()`, `stdinOf(vm)`    | everything that was sent, so a test can prove the credential went through stdin only         |

A real call to Cloudflare from a test is a bug. The Worker itself is tested in `cloudflare/sandbox/` (#1159); both are held to the contract's examples.
