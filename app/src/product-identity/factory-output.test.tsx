// SPDX-License-Identifier: LicenseRef-Proprietary

// The second product reads the same texts under its own name (#740). Everything a product's identity ends up in is rendered with
// the factory identity (`test-support/product-output.tsx`: the mails, the model chooser, the brand, the check run and the
// verdict, the GitHub App manifest, the refusal notices and every message module that names the product). Nothing of
// code-review.com may be left, and the texts must be those of code-review.com with the name exchanged: so a text that
// forgot the identity, or a second wording that drifted, fails here.
//
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { describeSaveFailure } from "../review-settings/ui/messages.ts";
import { productOutput } from "../test-support/product-output.tsx";
import { identityFor } from "./identities.ts";

const CODE_REVIEW_COM = identityFor("code-review-com");
const FACTORY = identityFor("factory");

/** What of the other product may not show: its name, and the name of its check run and App. */
const FOREIGN = /code-review\.com|code\s+reviewer/i;

function exchanged(text: string): string {
  return text
    .replaceAll(CODE_REVIEW_COM.name, FACTORY.name)
    .replaceAll(CODE_REVIEW_COM.checkName, FACTORY.checkName)
    .replaceAll(
      `listed under ${CODE_REVIEW_COM.qaAreaName}`,
      `listed under ${FACTORY.qaAreaName}`,
    );
}

describe("the texts of the factory", () => {
  const factory = JSON.stringify(productOutput(FACTORY), null, 2);

  // #740-T02
  it("name the factory and nothing of code-review.com", () => {
    expect(factory.match(FOREIGN)).toBeNull();
    expect(factory.match(/Factory/g)?.length).toBeGreaterThan(20);
  });

  // #740-T02
  it("are the texts of code-review.com with the name exchanged, word for word", () => {
    const codeReviewCom = JSON.stringify(
      productOutput(CODE_REVIEW_COM),
      null,
      2,
    );

    expect(JSON.parse(factory)).toEqual(JSON.parse(exchanged(codeReviewCom)));
  });

  // #740-T04
  it("give the GitHub App the name and the description of the factory, with the addresses of the deployment", () => {
    const { manifest } = productOutput(FACTORY);

    expect(manifest.built.name).toBe("Factory reviews.example.test");
    expect(manifest.built.description).toBe(FACTORY.githubAppDescription);
    expect(manifest.built.name.length).toBeLessThanOrEqual(34);
    expect(manifest.built.url).toBe("https://reviews.example.test");
    expect(manifest.built.hook_attributes.url).toBe(
      "https://reviews.example.test/api/webhooks/github-app",
    );
  });

  // #740-T05
  it("call the check run by the name of the factory and sign the verdict with it", () => {
    const { checkRuns } = productOutput(FACTORY);

    expect(checkRuns.checkName).toBe("Factory");
    expect(checkRuns.verdictChanges).toContain(
      "**Factory: changes requested.**",
    );
    expect(checkRuns.verdictApproved).toContain("**Factory: approved.**");
    expect(checkRuns.withdrawMessage).toContain("verdict of Factory");
  });

  // #757-T02
  it("call the area of the repositories QA wherever a sentence sends the person there", () => {
    const { messages } = productOutput(FACTORY);

    expect(messages.installation.RESULT_COPY.linked.text).toBe(
      "GitHub is connected. The repositories of the installation are listed under QA.",
    );
    expect(
      describeSaveFailure(FACTORY, "REVIEW_SETTINGS_PROJECT_NOT_FOUND"),
    ).toBe("This repository was not found. Reload the QA page and try again.");
  });

  // #757-T05
  it("find no foreign name in the area words either", () => {
    const words = [FACTORY.qaAreaName, FACTORY.qaAreaNameInSentence];

    for (const word of words) expect(word).not.toMatch(FOREIGN);
    expect(words).not.toContain(CODE_REVIEW_COM.qaAreaName);
  });
});
