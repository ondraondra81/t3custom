import { useAtomValue } from "@effect/atom-react";
import { createProjectGroupsAtoms } from "@t3tools/client-runtime/t3custom/projectGroups";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { CommandId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { ProjectGroupsCommand } from "@t3tools/contracts/t3custom/projectGroups";
import * as Cause from "effect/Cause";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../state/atom-registry";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../lib/modelOptions";

const groups = createProjectGroupsAtoms(connectionAtomRuntime);
const message = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "The group change could not be saved.";
};

export function useProjectGroups(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(groups.state({ environmentId, input: {} }));
  const connection = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const connected = connection._tag === "Success" && connection.value.phase === "connected";
  const canMutate = useAtomValue(groups.mutate.permissionAtom(environmentId));
  const canCoordinate = useAtomValue(groups.coordinate.permissionAtom(environmentId));
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = connected && query.isSuccess && !query.isPending && canMutate;
  const execute = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    setError(null);
    return Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : "The group change could not be saved.");
        return null;
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };
  return {
    snapshot: query.data,
    pending,
    writable,
    canCoordinate: writable && canCoordinate,
    error: error ?? query.error,
    refresh: query.refresh,
    mutate: async (command: ProjectGroupsCommand) => {
      if (!writable || !query.data) return null;
      const revision = query.data.revision;
      return execute(async () => {
        const result = await runAtomCommand(
          appAtomRegistry,
          groups.mutate,
          {
            environmentId,
            input: { expectedRevision: revision, mutationId: randomUUID(), command },
          },
          { reportFailure: false },
        );
        if (result._tag === "Failure") {
          setError(message(result.cause));
          query.refresh();
          return false;
        }
        return true;
      });
    },
    coordinate: async (groupId: string, resumeThreadId?: ThreadId) => {
      if (!writable || !canCoordinate || !query.data) return null;
      const snapshot = query.data;
      return execute(async () => {
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        const modelSelection = resolveNewTaskModelSelection({
          draftSelection: null,
          stickySelection: null,
          projectDefaultSelection: resolveDefaultableModelSelection(
            config,
            config?.settings.defaultModelSelection ?? null,
            null,
          ),
          modelOptions: buildModelOptions(config, null, undefined, null),
        });
        if (!config || (!resumeThreadId && !modelSelection)) {
          setError("Configure a provider and model on this environment first.");
          return null;
        }
        if (!resumeThreadId && !modelSelection) return null;
        const input = resumeThreadId
          ? { type: "resume" as const, threadId: resumeThreadId }
          : {
              type: "start" as const,
              groupId,
              expectedRevision: snapshot.revision,
              threadId: ThreadId.make(randomUUID()),
              commandId: CommandId.make(randomUUID()),
              modelSelection: modelSelection!,
              runtimeMode: config.settings.defaultRuntimeMode,
            };
        const result = await runAtomCommand(
          appAtomRegistry,
          groups.coordinate,
          { environmentId, input },
          { reportFailure: false },
        );
        if (result._tag === "Failure") {
          setError(message(result.cause));
          query.refresh();
          return null;
        }
        return result.value.threadId;
      });
    },
  };
}
