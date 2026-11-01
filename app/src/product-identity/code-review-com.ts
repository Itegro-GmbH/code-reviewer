// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of code-review.com (#635, #715 cut 7): "code-review.com", in lowercase everywhere, also at the start of a
// sentence (the design board, #633). The repository, the package names and the code identifiers keep "code-reviewer".
//
// Only the table of the products (`identities.ts`) imports this module: the places where the application is composed call
// `getProductIdentity()` (`current.ts`), and the code that writes a word of the product receives the value (`identity.ts`).
// `checkProductIdentityImports` (`ci/import-cycles/graph.ts`) holds that rule.
import type { ProductIdentity } from "./identity.ts";

const NAME = "code-review.com";

export const CODE_REVIEW_COM: ProductIdentity = {
  name: NAME,
  mailSenderNamePlaceholder: NAME,
  // The name the check run and the GitHub App have always had here; branch protection rules of the customers match it.
  checkName: "Code Reviewer",
  githubAppName: "Code Reviewer",
  githubAppDescription: `Automatic pull request reviews by ${NAME}.`,
  qaAreaName: "Projects",
  qaAreaNameInSentence: "projects",
};
