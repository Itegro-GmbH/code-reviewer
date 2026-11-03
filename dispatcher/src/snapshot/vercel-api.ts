// SPDX-License-Identifier: LicenseRef-Proprietary

// What the snapshot tooling reads from the Vercel API (#403): which golden snapshot pair a Dispatcher deployment
// was started with. The deploy step puts the pair into the deployment's meta (`pair.ts`), so the live production
// deployment says what production really runs, whatever the variables of the project hold. Every call is a GET with
// the access token, goes to the platform's address only, follows no redirect and prints nothing. "Unavailable" is
// never turned into "none": a caller that is about to delete something must be able to tell the two apart.
import { pairFromValues, PAIR_META, type SnapshotPair } from "./pair.ts";

export type VercelAuth = { token: string; teamId: string; projectId: string };

export type PairLookup =
  | { status: "pair"; pair: SnapshotPair }
  | { status: "none" }
  | { status: "unavailable" };

const API = "https://api.vercel.com";

async function get(
  auth: VercelAuth,
  path: string,
  request: typeof fetch,
): Promise<unknown | undefined> {
  const url = new URL(path, API);
  url.searchParams.set("teamId", auth.teamId);
  try {
    const answer = await request(url, {
      headers: { authorization: `Bearer ${auth.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (answer.status !== 200) return undefined;
    return await answer.json();
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The pair of one deployment of the Dispatcher project (its id or its host), read from its meta. */
export async function pairOfDeployment(
  auth: VercelAuth,
  idOrHost: string,
  request: typeof fetch = fetch,
): Promise<PairLookup> {
  const deployment = await get(
    auth,
    `/v13/deployments/${encodeURIComponent(idOrHost)}`,
    request,
  );
  if (!isRecord(deployment)) return { status: "unavailable" };
  // A deployment of another project or team is not an answer about this one.
  if (
    deployment.projectId !== auth.projectId ||
    deployment.ownerId !== auth.teamId
  )
    return { status: "unavailable" };
  const meta = isRecord(deployment.meta) ? deployment.meta : {};
  const pair = pairFromValues(
    meta[PAIR_META.snapshotId],
    meta[PAIR_META.imageDigest],
    meta[PAIR_META.commit],
    meta[PAIR_META.sysbox],
  );
  return pair === undefined ? { status: "none" } : { status: "pair", pair };
}

/** The pair of the deployment the Dispatcher project serves on its production domains now. */
export async function livePair(
  auth: VercelAuth,
  request: typeof fetch = fetch,
): Promise<PairLookup> {
  const project = await get(
    auth,
    `/v9/projects/${encodeURIComponent(auth.projectId)}`,
    request,
  );
  if (!isRecord(project)) return { status: "unavailable" };
  const targets = isRecord(project.targets) ? project.targets : {};
  const production = isRecord(targets.production)
    ? targets.production
    : undefined;
  const id = production?.id;
  if (typeof id !== "string" || id === "") return { status: "none" };
  return pairOfDeployment(auth, id, request);
}

/** Whether a deployment is a ready production deployment of the project and team. "unavailable" is not "no". */
export async function productionDeployment(
  auth: VercelAuth,
  idOrHost: string,
  request: typeof fetch = fetch,
): Promise<"yes" | "no" | "unavailable"> {
  const url = new URL(`/v13/deployments/${encodeURIComponent(idOrHost)}`, API);
  url.searchParams.set("teamId", auth.teamId);
  let answer: Response;
  try {
    answer = await request(url, {
      headers: { authorization: `Bearer ${auth.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return "unavailable";
  }
  if (answer.status === 429 || answer.status >= 500) return "unavailable";
  if (answer.status !== 200) return "no";
  let deployment: unknown;
  try {
    deployment = await answer.json();
  } catch {
    return "unavailable";
  }
  if (!isRecord(deployment)) return "no";
  return deployment.projectId === auth.projectId &&
    deployment.ownerId === auth.teamId &&
    deployment.target === "production" &&
    deployment.readyState === "READY"
    ? "yes"
    : "no";
}
