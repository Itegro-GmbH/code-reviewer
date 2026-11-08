# Decision records

Architecture decision records (ADRs) capture decisions that shape the whole system and are costly to
reverse: what was decided, why, what it costs, and what stays open. They are written before the
implementation starts and are not rewritten afterwards. A later decision that changes an earlier one
gets a new record and marks the old one as superseded.

Planning and tracking of the work itself happens in GitHub Issues and milestones; a record links to
the milestone that implements it.

## Format

Every record is a file `NNNN-short-title.md` (four digits, counting up) with these sections:

| Section | Content |
|---|---|
| Header | Status (`Proposed`, `Accepted`, `Superseded by NNNN`), date, deciders |
| Context | The situation and the forces at play, grounded in the current code |
| Decision | What was decided, in enough detail to implement and test |
| Alternatives considered | What was rejected and why (short) |
| Consequences | What becomes easier, what becomes harder, what it costs |
| Open questions | Decisions deliberately postponed |
| Out of scope | What this record does not cover |

## Index

| No. | Title | Status |
|---|---|---|
| [0001](0001-editions-setup-and-accounts.md) | One codebase for self-hosted and hosted, first-run setup, accounts and workspaces | Accepted |
| [0002](0002-dynamic-review-deployment.md) | How Dynamic Review is deployed and switched on | Accepted |
| [0003](0003-dynamic-engine-boundary.md) | The engine boundary of Dynamic Review | Accepted |
| [0004](0004-dynamic-runner-image-and-self-check.md) | The Dynamic runner image and the startup self-check | Accepted |
| [0005](0005-providers-model-catalog-and-paddle-billing.md) | LLM providers, the model catalog and billing with Paddle | Proposed, billing part superseded by [0006](0006-prepaid-billing-via-stripe-managed-payments.md) |
