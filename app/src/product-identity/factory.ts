// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of the second product (#740, epic #729): the codename `factory` until the owner picks the brand. The name is
// a one-line change here; no text of the application writes it itself, every word comes from this value. There is no real
// domain: the public address of a deployment is its `BETTER_AUTH_URL`, and nothing here names one. Only the table of the
// products (`identities.ts`) imports this module.
import type { ProductIdentity } from "./identity.ts";

const NAME = "Factory";

export const FACTORY: ProductIdentity = {
  name: NAME,
  mailSenderNamePlaceholder: NAME,
  checkName: NAME,
  githubAppName: NAME,
  githubAppDescription: `Automatic pull request reviews by ${NAME}.`,
  // "Qualitätssicherung": the area of the repositories is the quality assurance of the factory (#757).
  qaAreaName: "QA",
  qaAreaNameInSentence: "QA",
};
