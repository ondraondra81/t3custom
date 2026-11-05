import { useState, type DragEvent } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectGroupsSnapshot } from "@t3tools/contracts/t3custom/projectGroups";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { ProjectGroupsController } from "./projectGroupsState";
import { groupRowId } from "./projectGroupsTree";

const PROJECT_DRAG_TYPE = "application/x-t3custom-project";

export function canDropProjects(
  source: SidebarProjectSnapshot | null,
  environmentId: EnvironmentId,
  groupId: string | null,
  snapshot: ProjectGroupsSnapshot | undefined,
  writable: boolean,
  dragTypes: readonly string[],
) {
  return Boolean(
    dragTypes.includes(PROJECT_DRAG_TYPE) &&
    writable &&
    snapshot &&
    source &&
    !source.isScratch &&
    source.memberProjectRefs.length > 0 &&
    source.memberProjectRefs.every((ref) => ref.environmentId === environmentId) &&
    (groupId === null || snapshot.groups.some((group) => group.id === groupId)) &&
    source.memberProjectRefs.some(
      (ref) =>
        (snapshot.projects.find((entry) => entry.projectId === ref.projectId)?.groupId ?? null) !==
        groupId,
    ),
  );
}

export function useProjectGroupsDrag(controller: ProjectGroupsController) {
  const [source, setSource] = useState<SidebarProjectSnapshot | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const writable = (environmentId: EnvironmentId) =>
    controller.enabled &&
    !controller.pending &&
    controller.states.some((state) => state.environmentId === environmentId && state.writable);
  const end = () => {
    setSource(null);
    setOver(null);
  };
  return {
    sourceProps: (project: SidebarProjectSnapshot) => ({
      draggable: !project.isScratch && writable(project.environmentId),
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        if (project.isScratch || !writable(project.environmentId)) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.folderId ?? project.projectKey);
        setSource(project);
        controller.clearError();
      },
      onDragEnd: end,
    }),
    targetProps: (environmentId: EnvironmentId, groupId: string | null, rowId: string) => {
      const allowed = (event: DragEvent<HTMLButtonElement>) =>
        canDropProjects(
          source,
          environmentId,
          groupId,
          controller.snapshots.get(environmentId),
          writable(environmentId),
          event.dataTransfer.types,
        );
      return {
        "data-drop-active":
          source && writable(environmentId) && over === rowId ? "true" : undefined,
        onDragOver: (event: DragEvent<HTMLButtonElement>) => {
          if (!source || !event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
          event.preventDefault();
          const accepted = allowed(event);
          event.dataTransfer.dropEffect = accepted ? "move" : "none";
          setOver(accepted ? rowId : null);
        },
        onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setOver(null);
        },
        onDrop: async (event: DragEvent<HTMLButtonElement>) => {
          const accepted = allowed(event);
          end();
          if (!source || !accepted) return;
          event.preventDefault();
          if (
            await controller.mutate(environmentId, {
              type: "assignProjects",
              groupId,
              projectIds: source.memberProjectRefs.map((ref) => ref.projectId),
            })
          )
            controller.expand(groupRowId(environmentId, groupId));
        },
      };
    },
  };
}
export type ProjectGroupsDrag = ReturnType<typeof useProjectGroupsDrag>;
