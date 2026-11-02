# models.dev fixture

`api.json` is a trimmed copy of the public catalog <https://models.dev/api.json>, used by the models.dev fake
(`fakes/models-dev/`) and by the catalog tests of the app (#548).

- **Source and date:** downloaded from `https://models.dev/api.json` on 2026-10-19 (232 providers, 9,079 models).
- **License:** the data are community maintained in <https://github.com/sst/models.dev> under the MIT License,
  Copyright (c) 2025 models.dev. The permission notice of that license applies to this file.
- **Trimmed, not edited:** a handful of providers with two to four models each, picked for their shape, nothing changed in a
  value. What the choice covers: a provider with an `api` address (`deepseek`, `openrouter`, `opencode`) and without one
  (`anthropic`, `openai`, `google`, `xai`); the three wire families of the supported file (Chat, Responses, Messages, Google);
  a model with `status: "deprecated"` (`deepseek-v4-flash`), models without `tool_call` (`gpt-3.5-turbo`,
  `text-embedding-3-small`, `gemini-embedding-001`, `grok-imagine-image`), a model with a `type` that is not a language
  model, models with a `provider` override of their own (`opencode`), `interleaved` reasoning, `cost.tiers`, and a provider
  of each kind that is left out (`amazon-bedrock` cloud IAM, `venice` runtime install, `cohere` its own wire).
- Dummy values only are added by the tests, never to this file.

`implementer-lane.json` is **not** a copy of the public catalog: it is made up, in the same shape, for the Implementer's journeys in the
privileged lane (#767). The app takes only the providers it supports, so it is the provider `deepseek` (its real address, an
OpenAI-compatible chat API) with two models that do not exist, with prices the journeys know: `lane-coder`, and `claude-lane-coder`,
whose id carries the word the engine marks a prompt for the cache by; and the provider `anthropic` (the address the committed file
records for it, the Messages wire) with one model, `claude-sonnet-5-5`, for the journey of a workspace on its own Anthropic key. The journeys fill the catalog of the factory app from it
(`app/src/test-support/e2e-models-dev-child.ts fetch <db> <file>`), so that the models the fake LLM answers on the chat route are the
ones the form offers.
