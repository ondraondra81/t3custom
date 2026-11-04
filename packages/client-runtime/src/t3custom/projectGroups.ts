import { WS_METHODS } from "@t3tools/contracts";
import { type ProjectGroupsSnapshot } from "@t3tools/contracts/t3custom/projectGroups";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

export function createProjectGroupsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    coordinate: createEnvironmentRpcCommand(runtime, {
      label: "t3custom:groups:coordinate",
      tag: WS_METHODS.t3customProjectGroupsCoordinate,
    }),
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "t3custom:groups",
      tag: WS_METHODS.t3customProjectGroupsSubscribe,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "t3custom:groups:mutate",
      tag: WS_METHODS.t3customProjectGroupsMutate,
    }),
  };
}

export function projectGroupPaths(snapshot: ProjectGroupsSnapshot): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const byId = new Map(snapshot.groups.map((group) => [group.id, group]));
  for (const group of snapshot.groups) {
    const parts = [group.name];
    const visited = new Set([group.id]);
    let parent = group.parentId;
    while (parent !== null && !visited.has(parent)) {
      visited.add(parent);
      const entry = byId.get(parent);
      if (!entry) break;
      parts.unshift(entry.name);
      parent = entry.parentId;
    }
    names.set(group.id, parts.join(" / "));
  }
  return names;
}
