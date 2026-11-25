// SPDX-License-Identifier: LicenseRef-Proprietary

// The routes of contracts/cf-sandbox.v1.json, as a pure function of method and path.
export type Route =
  | { kind: "health" }
  | { kind: "create" }
  | { kind: "list" }
  | { kind: "delete"; name: string }
  | { kind: "exec"; name: string }
  | { kind: "network"; name: string }
  | { kind: "startProcess"; name: string }
  | { kind: "processStatus"; name: string; id: string }
  | { kind: "stdin"; name: string; id: string }
  | { kind: "stdinClose"; name: string; id: string };

export function routeOf(method: string, pathname: string): Route | null {
  const parts = pathname
    .split("/")
    .filter((part, index) => !(index === 0 && part === ""));
  const [first, second, name, third, id, fourth, fifth] = parts;
  if (first === "health" && parts.length === 1)
    return method === "GET" ? { kind: "health" } : null;
  if (first !== "v1" || second !== "vms") return null;
  if (name === undefined) {
    if (method === "POST") return { kind: "create" };
    return method === "GET" ? { kind: "list" } : null;
  }
  if (third === undefined)
    return method === "DELETE" ? { kind: "delete", name } : null;
  if (third === "exec" && id === undefined)
    return method === "POST" ? { kind: "exec", name } : null;
  if (third === "network" && id === undefined)
    return method === "PUT" ? { kind: "network", name } : null;
  if (third !== "processes") return null;
  if (id === undefined)
    return method === "POST" ? { kind: "startProcess", name } : null;
  if (fourth === undefined)
    return method === "GET" ? { kind: "processStatus", name, id } : null;
  if (fourth !== "stdin") return null;
  if (fifth === undefined)
    return method === "POST" ? { kind: "stdin", name, id } : null;
  if (fifth === "close" && parts.length === 7)
    return method === "POST" ? { kind: "stdinClose", name, id } : null;
  return null;
}
