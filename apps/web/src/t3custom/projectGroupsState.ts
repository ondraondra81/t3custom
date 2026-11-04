import { CommandId, ThreadId } from "@t3tools/contracts";
import { type ProjectGroupsCoordinateInput } from "@t3tools/contracts/t3custom/projectGroups";
import { serverEnvironment } from "../state/server";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { randomUUID } from "../lib/utils";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { useAtomValue } from "@effect/atom-react";
import { createProjectGroupsAtoms } from "@t3tools/client-runtime/t3custom/projectGroups";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { type ProjectGroupsCommand } from "@t3tools/contracts/t3custom/projectGroups";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "../state/query";
import { useLocalStorage } from "../hooks/useLocalStorage";

const collapsedGroupsSchema = Schema.Array(Schema.String);
const emptyCollapsedGroups: string[] = [];

const projectGroupsEnvironment = createProjectGroupsAtoms(connectionAtomRuntime);
export function useProjectGroupsEnabled() {
  return useLocalStorage("t3custom:project-groups:enabled", false, Schema.Boolean);
}
const statesAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? []
      : key.split("\n").map((id) => {
          const environmentId = EnvironmentId.make(id);
          const result = get(projectGroupsEnvironment.state({ environmentId, input: {} }));
          return {
            environmentId,
            snapshot: AsyncResult.getOrElse(result, () => null),
            writable:
              result._tag === "Success" &&
              AsyncResult.getOrElse(get(environmentCatalog.stateAtom(environmentId)), () => null)
                ?.phase === "connected" &&
              get(projectGroupsEnvironment.mutate.permissionAtom(environmentId)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
          };
        }),
  ),
);

export function useProjectGroups(configs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>) {
  const [enabled] = useProjectGroupsEnabled();
  const states = useAtomValue(
    statesAtom(
      enabled
        ? [...configs]
            .filter(([, config]) => config.environment.capabilities?.t3customProjectGroups === true)
            .map(([id]) => id)
            .sort()
            .join("\n")
        : "",
    ),
  );
  const [collapsed, setCollapsed] = useLocalStorage(
    "t3custom:project-groups:collapsed",
    emptyCollapsedGroups,
    collapsedGroupsSchema,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const snapshots = new Map(
    states.flatMap((state) =>
      state.snapshot ? [[state.environmentId, state.snapshot] as const] : [],
    ),
  );
  const mutate = async (environmentId: EnvironmentId, command: ProjectGroupsCommand) => {
    const state = states.find((entry) => entry.environmentId === environmentId);
    if (!state?.snapshot || !state.writable || pending) return false;
    setPending(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      projectGroupsEnvironment.mutate,
      {
        environmentId,
        input: { expectedRevision: state.snapshot.revision, mutationId: randomUUID(), command },
      },
      { reportFailure: false },
    );
    setPending(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      appAtomRegistry.refresh(projectGroupsEnvironment.state({ environmentId, input: {} }));
      return false;
    }
    return true;
  };
  const coordinate = async (
    environmentId: EnvironmentId,
    groupId: string,
    resumeThreadId?: ThreadId,
  ) => {
    const state = states.find((entry) => entry.environmentId === environmentId);
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (!state?.snapshot || !state.writable || !config || pending) return null;
    const modelSelection =
      config.settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(config.providers, config.settings, null);
    if (!modelSelection) {
      setError("Configure a provider and model on this environment first.");
      return null;
    }
    const input: ProjectGroupsCoordinateInput = resumeThreadId
      ? { type: "resume", threadId: resumeThreadId }
      : {
          type: "start",
          groupId,
          expectedRevision: state.snapshot.revision,
          threadId: ThreadId.make(randomUUID()),
          commandId: CommandId.make(randomUUID()),
          modelSelection,
          runtimeMode: config.settings.defaultRuntimeMode,
        };
    setPending(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      projectGroupsEnvironment.coordinate,
      { environmentId, input },
      { reportFailure: false },
    );
    setPending(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return null;
    }
    return result.value.threadId;
  };
  return {
    clearError: () => setError(null),
    coordinate,
    enabled,
    states,
    snapshots,
    collapsed: new Set(collapsed),
    pending,
    error,
    mutate,
    toggle: (id: string) =>
      setCollapsed(
        collapsed.includes(id) ? collapsed.filter((key) => key !== id) : [...collapsed, id],
      ),
  };
}
export type ProjectGroupsController = ReturnType<typeof useProjectGroups>;
