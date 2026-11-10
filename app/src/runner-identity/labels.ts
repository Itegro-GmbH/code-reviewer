// SPDX-License-Identifier: LicenseRef-Proprietary

// The labels of the platform (#971, Runner v2, ADR 0005): every job requires labels and a dispatcher takes a job only when it has all of
// them. The namespace `cr:` is reserved. `cr:managed` marks a job the platform runs itself and `cr:size-<vCPUs>` names the VM size it
// needs (one label for each size of `contracts/environment-sizes.v1.json`). Only the platform identity (the Dispatcher's shared token)
// may carry them: whether a caller may is decided by who it is (`claimLabelsOf`, the registration), never by what a job's text says, and
// a customer's runner that announces one is refused (`reservedLabelIssues`).
//
// A job of a runner environment requires the labels of that environment, which are the customer's own and never start with `cr:`.

/** The prefix no customer's runner may announce. */
export const RESERVED_LABEL_PREFIX = "cr:";

/** A job the platform runs on its own Dispatcher. */
export const MANAGED_LABEL = "cr:managed";

/**
 * The VM sizes of the platform in vCPUs (`vcpus` of `contracts/environment-sizes.v1.json`; `labels.test.ts` holds this copy to the
 * file). 1 vCPU is the size reviews run on.
 */
export const HOSTED_VCPUS = [1, 2, 4, 6, 8] as const;

/** What a review job (Diff or Dynamic) runs on. */
export const REVIEW_VCPUS = 1;

/** What a turn of the Implementer without an environment runs on (the Dispatcher's default for the kind). */
export const DEFAULT_IMPLEMENTER_VCPUS = 2;

const SIZE_PREFIX = "cr:size-";

/** The label of a VM size. */
export function sizeLabel(vcpus: number): string {
  return `${SIZE_PREFIX}${String(vcpus)}`;
}

/** The labels of a hosted job of one size. */
export function hostedLabels(vcpus: number): string[] {
  return [MANAGED_LABEL, sizeLabel(vcpus)];
}

/** Every label of the platform identity: `cr:managed` and one for each size. */
export const PLATFORM_LABELS: readonly string[] = [
  MANAGED_LABEL,
  ...HOSTED_VCPUS.map(sizeLabel),
];

/** The size a label names, or undefined for any other label and for a size the platform does not offer. */
export function vcpusOfSizeLabel(label: string): number | undefined {
  return HOSTED_VCPUS.find((vcpus) => sizeLabel(vcpus) === label);
}

/** The size label among the labels of a job, or undefined for a job that has none (a runner turn, or one written before the labels). */
export function sizeLabelOf(
  labels: readonly string[] | null | undefined,
): string | undefined {
  return labels?.find((label) => vcpusOfSizeLabel(label) !== undefined);
}

/** Whether a label is in the namespace of the platform, whatever its case or spacing. */
export function isReservedLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith(RESERVED_LABEL_PREFIX);
}

export type ReservedLabelIssue = { field: string; code: "reserved" };

/** The labels of an announcement that are in the reserved namespace, by position in the body (a value that is no text is the form check's). */
export function reservedLabelIssues(
  labels: readonly unknown[],
): ReservedLabelIssue[] {
  const issues: ReservedLabelIssue[] = [];
  for (const [index, label] of labels.entries())
    if (typeof label === "string" && isReservedLabel(label))
      issues.push({ field: `labels[${String(index)}]`, code: "reserved" });
  return issues;
}

/** The dispatcher has every label the job requires. */
export function hasAllLabels(
  have: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((label) => have.includes(label));
}

/**
 * The labels a turn of the Implementer requires, from the environment it was started with: a runner environment's own labels, or
 * `cr:managed` and the size of a hosted environment (the Dispatcher's size for the kind when the task has none). A runner environment
 * stored before the namespace was reserved may hold `cr:` labels; they are dropped, or the turn would be one the platform could take.
 */
export function requiredLabelsOfTurn(environments: {
  environment?: { vcpus: number } | null;
  runnerEnvironment?: { labels: readonly string[] } | null;
}): string[] {
  if (environments.runnerEnvironment)
    return environments.runnerEnvironment.labels.filter(
      (label) => !isReservedLabel(label),
    );
  return hostedLabels(
    environments.environment?.vcpus ?? DEFAULT_IMPLEMENTER_VCPUS,
  );
}
