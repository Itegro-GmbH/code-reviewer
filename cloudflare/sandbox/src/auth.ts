// SPDX-License-Identifier: LicenseRef-Proprietary

/** A token shorter than this is not a token: a Worker with one refuses everything (fail closed). */
export const MIN_TOKEN_LENGTH = 32;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/**
 * The bearer check: `Authorization: Bearer <token>` against the Worker's secret `CF_SANDBOX_TOKEN`, in constant time (both sides are
 * hashed first, so neither the length nor a common prefix shows in the time). A missing, short or wrong one is false.
 */
export async function bearerAllowed(
  header: string | null,
  token: string | undefined,
): Promise<boolean> {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH)
    return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  const presented = match?.[1] ?? "";
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0 && presented.length > 0;
}
