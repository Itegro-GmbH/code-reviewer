// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the build and deployment of the Cloudflare Worker cr-sandbox (#1159, epic #1157): cloudflare-sandbox.yml, how ci.yml calls it, and the account
// guard (nothing but resources named cr-sandbox*, never the spike's cr-spike-* or the other apps of the account). It reads the files as text and
// YAML; that GitHub and Cloudflare accept them is verified by the run itself.
import { describe, expect, it } from "vitest";
import {
  readText,
  readWorkflow,
  REPOSITORY,
  stepsOf,
} from "./workflow-support.ts";

const workflow = readWorkflow("cloudflare-sandbox.yml");
const source = readText(".github/workflows/cloudflare-sandbox.yml");
const image = workflow.jobs.image;
if (!image) throw new Error("cloudflare-sandbox.yml has no image job");
const steps = stepsOf(image);
const named = (text: string) =>
  steps.findIndex((step) => (step.name ?? "").includes(text));

/** wrangler.jsonc as data: the file has only whole-line comments, and Prettier gives it trailing commas. */
const wrangler = JSON.parse(
  readText("cloudflare/sandbox/wrangler.jsonc")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1"),
) as {
  name: string;
  containers: { class_name: string; scheduling_policy: string }[];
  durable_objects: { bindings: { class_name: string }[] };
  exports: Record<string, unknown>;
  vars: Record<string, string>;
  routes?: unknown;
  workers_dev: boolean;
};

describe("the Cloudflare sandbox workflow", () => {
  // #1159-T32
  it("runs for a call from ci.yml, for a push to main and by hand, and holds the token to read access", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "push",
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job["timeout-minutes"], id).toBeGreaterThan(0);
      expect(job["timeout-minutes"], id).toBeLessThanOrEqual(90);
    }
  });

  // #1159-T32
  it("deploys only for a push or a run by hand on main, in this repository, and never for the old repository name", () => {
    const deploy = String(
      (image.env as Record<string, string> | undefined)?.DEPLOY,
    );
    expect(deploy).toContain("github.event_name == 'push'");
    expect(deploy).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain(`github.repository == '${REPOSITORY}'`);
    for (const step of steps.filter((s) =>
      /wrangler (deploy|secret)/.test(s.run ?? ""),
    )) {
      if (/--dry-run/.test(step.run ?? "")) continue;
      expect(step.if, step.name).toBe("${{ env.DEPLOY == 'true' }}");
    }
  });

  // #1159-T33
  it("fails clearly, first and before anything is built, when a Cloudflare secret is missing", () => {
    const check = steps[0];
    expect(check?.name).toContain("Check the Cloudflare secrets");
    expect(check?.if).toBe("${{ env.DEPLOY == 'true' }}");
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_SANDBOX_TOKEN",
    ]) {
      expect(check?.env?.[name], name).toBe(`\${{ secrets.${name} }}`);
      expect(check?.run, name).toContain(name);
    }
    expect(check?.run).toContain("::error");
    expect(check?.run).toContain("exit 1");
    expect(check?.run).toMatch(/-lt 32/);
  });

  // #1159-T33
  it("hands the secrets only to the steps that deploy, and the Worker secret is set after the deploy", () => {
    for (const step of steps) {
      const uses = JSON.stringify(step.env ?? {}) + (step.run ?? "");
      if (!/secrets\./.test(uses)) continue;
      expect(
        [
          "Check the Cloudflare secrets (a deployment only)",
          "Deploy the Worker",
          "Set the Worker secret",
        ],
        step.name,
      ).toContain(step.name);
    }
    expect(JSON.stringify(workflow.jobs.verify)).not.toMatch(/secrets\./);
    expect(named("Set the Worker secret")).toBeGreaterThan(
      named("Deploy the Worker"),
    );
    // The token goes in through stdin, never as an argument.
    expect(source).toContain(
      `printf '%s' "$CF_SANDBOX_TOKEN" | pnpm exec wrangler secret put CF_SANDBOX_TOKEN`,
    );
  });

  // #1159-T34
  it("builds and runs the whole image before it deploys, on a pull request too, and dry-runs the deployment when it does not deploy", () => {
    const order = [
      "Prepare the image context",
      "Build the Worker and agent images",
      "Build the Container image",
      "Run the image",
      "Dry run of the deployment",
      "Deploy the Worker",
    ].map(named);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(steps[named("Dry run of the deployment")]?.if).toBe(
      "${{ env.DEPLOY != 'true' }}",
    );
  });

  // #1159-T34
  it("gives wrangler the git SHA and what the self-check read from the images, as variables", () => {
    const run = steps[named("Deploy the Worker")]?.run ?? "";
    for (const variable of [
      "IMAGE_VERSION:$GITHUB_SHA",
      "WORKER_FEATURES:$WORKER_FEATURES",
      "WORKER_IMAGE_ID:$WORKER_IMAGE_ID",
      "AGENT_IMAGE_ID:$AGENT_IMAGE_ID",
    ])
      expect(run).toContain(`--var "${variable}"`);
  });

  // #1159-T35
  it("pins every third-party action to a commit and takes the Node and pnpm versions from the repository", () => {
    for (const job of Object.values(workflow.jobs))
      for (const step of stepsOf(job)) {
        if (!step.uses || step.uses.startsWith("actions/")) continue;
        expect(step.uses).toMatch(/@[0-9a-f]{40}/);
      }
    expect(source).not.toMatch(/\bnode-version:/);
    expect(source).toContain("node-version-file: .nvmrc");
    expect(source).toContain(
      "package_json_file: cloudflare/sandbox/package.json",
    );
  });
});

describe("the account guard of cloudflare/sandbox", () => {
  // #1159-T36
  it("names every resource it creates cr-sandbox*, and never one of the spike or of another app of the account", () => {
    expect(wrangler.name).toMatch(/^cr-sandbox/);
    const classes = [
      ...wrangler.containers.map((c) => c.class_name),
      ...wrangler.durable_objects.bindings.map((b) => b.class_name),
      ...Object.keys(wrangler.exports),
    ];
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) expect(name, name).toMatch(/^CrSandbox/);
    for (const file of [
      "cloudflare/sandbox/wrangler.jsonc",
      ".github/workflows/cloudflare-sandbox.yml",
    ]) {
      const text = readText(file).replace(/^\s*(#|\/\/).*$/gm, "");
      expect(text, file).not.toMatch(
        /cr-spike|reserwirt|office-preview|officepreview|previewcontainer/,
      );
    }
  });

  // #1159-T36
  it("is a Worker on the scheduling policy the epic accepted, on workers.dev only, with no route and no domain", () => {
    expect(wrangler.containers).toHaveLength(1);
    expect(wrangler.containers[0]?.scheduling_policy).toBe("durable_object");
    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.routes).toBeUndefined();
    expect(wrangler.vars.INSTANCE_TYPES).toBe("standard-4");
  });

  // #1159-T36
  it("calls wrangler for deploy and secret only, never for a delete, a billing or a plan command", () => {
    const commands = [...source.matchAll(/pnpm exec wrangler[ \t]+([a-z-]+)/g)];
    const verbs = commands.map((match) => match[1]);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) expect(["deploy", "secret"]).toContain(verb);
    expect(source).not.toMatch(/wrangler\s+(delete|containers|billing)/);
  });
});
