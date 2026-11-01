# product-identity

Who the product is, as a value (#715, cut 7; per deployment since #740).

| File                 | Role                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.ts`        | `ProductIdentity`: the name, the sender-name placeholder of the mail settings, the name of the check run, the name and description of the GitHub App and the name of the QA area (`qaAreaName`: Projects for code-review.com, QA for the factory; the address stays `/projects`). Imports nothing. |
| `code-review-com.ts` | The identity of code-review.com. Only `identities.ts` imports it.                                                                                                                                                                                                                                  |
| `factory.ts`         | The identity of the second product, under the codename `factory` until the owner picks the brand: the name is a one-line change. Only `identities.ts` imports it.                                                                                                                                  |
| `identities.ts`      | `IDENTITIES: Record<ProductId, ProductIdentity>` and `identityFor(id)`, keyed by the product ids of `capabilities/products.ts`. Pure, no `server-only`: tests load it.                                                                                                                             |
| `current.ts`         | `getProductIdentity()` (`server-only`): the one place that reads `PRODUCT_ID` (through the capability set) and picks the identity. Every composition root calls it.                                                                                                                                |
| `context.tsx`        | `ProductIdentityProvider` (the root layout) and `useProductIdentity()` for client components, which never call the selector.                                                                                                                                                                       |
| `public.ts`          | `builtProductIdentity()`: the identity of the build (`NEXT_PUBLIC_PRODUCT_ID`, inlined by `next.config.ts`) for `global-error.tsx`, which renders outside the layout.                                                                                                                              |

A module that writes a word of the product (a mail, a title, a sentence of a page, the description at the payment provider, the
check run, the manifest of the GitHub App) takes a `ProductIdentity` as a parameter and never imports a product's value or
`current.ts`, so it can move to a package that another product uses with its own identity. The composition roots (routes, pages,
`shared.ts`, `auth/`) call `getProductIdentity()` and hand the value down; a client component reads it from the provider.
`checkProductIdentityImports` (`src/ci/import-cycles/graph.ts`) holds the rule.

Three tests keep the brand where it belongs:

- `code-review-com-output.test.tsx` holds everything the value ends up in (the mails, the model chooser, the brand, the check run
  and the verdict, the manifest, the refusal notices and the message modules) against `code-review-com-output.golden.json`,
  recorded from the code before the cut and before the sweep. The output is made by `test-support/product-output.tsx`.
- `factory-output.test.tsx` renders the same output with the factory identity, finds nothing of code-review.com in it, and
  requires it to be the texts of code-review.com with the name exchanged.
- `copy/product-name.test.ts` scans every string, template and JSX text of the app: none writes the name of code-review.com
  outside its identity, and a file that takes a `ProductIdentity` has no exception at all.

A fact the product has no use for yet (a link to terms or privacy, a support address) is added to the type with its first
consumer. The hidden markers on GitHub (`<!-- code-reviewer:verdict`, `<!-- code-reviewer:refusal-notice`) and the internal
names (`Symbol.for("code-reviewer.*")`, the key-derivation salt) are not brand: they stay, because withdrawing an old review
finds it by its marker and the App's own login, and a salt that changed would orphan every stored secret.

The browser icons (`app/icon.svg`, `favicon.ico`, `apple-icon.png`) are file-convention static assets and the mark is shared
by both products; the app has no web manifest. A product's own icon is a later asset swap (see the follow-up in #740).
