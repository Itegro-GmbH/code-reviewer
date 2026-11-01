// SPDX-License-Identifier: LicenseRef-Proprietary

// The address a turn clones from and pushes to (#753): the repository's own https address plus `.git`, in the shape the runner's
// git workspace accepts (https, a host, no credential, query or fragment).
import { describe, expect, it } from "vitest";
import { cloneUrlOf } from "./claim.ts";

describe("the clone address of a turn", () => {
  // #753
  it.each([
    ["https://github.com/acme/widgets", "https://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets/", "https://github.com/acme/widgets.git"],
    [
      "https://ghe.example.com:8443/acme/widgets",
      "https://ghe.example.com:8443/acme/widgets.git",
    ],
  ])("makes %s the address %s", (url, expected) => {
    expect(cloneUrlOf(url)).toBe(expected);
  });

  // #753
  it.each([
    ["http://github.com/acme/widgets"],
    ["ssh://git@github.com/acme/widgets"],
    ["https://token@github.com/acme/widgets"],
    ["https://user:secret@github.com/acme/widgets"],
    ["https://github.com/acme/widgets?x=1"],
    ["https://github.com/acme/widgets#frag"],
    ["https://github.com/acme/widgets.git"],
    ["https://github.com"],
    ["https://github.com/acme/wid gets"],
    ["not a url"],
    [""],
  ])("refuses %s", (url) => {
    expect(cloneUrlOf(url)).toBeNull();
  });
});
