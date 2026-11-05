import type { ContextMenuItem, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { projectGroupPaths } from "@t3tools/client-runtime/t3custom/projectGroups";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../localApi";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { GroupEditorTarget } from "./ProjectGroupsControls";
import type { ProjectGroupsController } from "./projectGroupsState";
import type { ProjectGroupsRow } from "./projectGroupsTree";
import { groupRowId } from "./projectGroupsTree";

export function projectDestinationMenu(
  controller: ProjectGroupsController,
  project: SidebarProjectSnapshot,
): ContextMenuItem[] {
  const snapshot = controller.snapshots.get(project.environmentId);
  if (!controller.enabled || !snapshot || project.isScratch) return [];
  const paths = projectGroupPaths(snapshot);
  const current =
    snapshot.projects.find((entry) => entry.projectId === project.id)?.groupId ?? null;
  const disabled =
    controller.pending ||
    !controller.states.some(
      (state) => state.environmentId === project.environmentId && state.writable,
    );
  return [
    {
      id: "organize-project",
      label: "Move to group",
      disabled,
      children: [
        { id: "t3custom:project:", label: "Unassigned", checked: current === null },
        ...snapshot.groups.map((group) => ({
          id: `t3custom:project:${group.id}`,
          label: paths.get(group.id) ?? group.name,
          checked: current === group.id,
        })),
      ],
    },
  ];
}

export async function moveProjectFromMenu(
  controller: ProjectGroupsController,
  project: SidebarProjectSnapshot,
  action: string | null,
) {
  if (!action?.startsWith("t3custom:project:")) return false;
  const groupId = action.slice("t3custom:project:".length) || null;
  if (
    await controller.mutate(project.environmentId, {
      type: "assignProjects",
      groupId,
      projectIds: project.memberProjectRefs.map((ref) => ref.projectId),
    })
  )
    controller.expand(groupRowId(project.environmentId, groupId));
  return true;
}

export async function showProjectGroupMenu(input: {
  row: Extract<ProjectGroupsRow, { kind: "environment" | "group" }>;
  controller: ProjectGroupsController;
  threads: readonly EnvironmentThreadShell[];
  onEdit: (target: GroupEditorTarget) => void;
  onCoordinate: (target: GroupEditorTarget, resumeThreadId?: ThreadId) => Promise<void>;
  position: { x: number; y: number };
}) {
  const { row, controller, onEdit, onCoordinate } = input;
  const api = readLocalApi();
  const snapshot = controller.snapshots.get(row.environmentId);
  if (!api || !snapshot) return;
  const writable =
    controller.states.some(
      (state) => state.environmentId === row.environmentId && state.writable,
    ) && !controller.pending;
  if (!writable) return;
  controller.clearError();
  const group = row.kind === "group" ? row.group : null;
  const target = { environmentId: row.environmentId, ...(group ? { group } : {}) };
  const actions = new Map<string, () => unknown>();
  const item = (
    label: string,
    action: () => unknown,
    extra?: Partial<ContextMenuItem>,
  ): ContextMenuItem => {
    const id = String(actions.size);
    actions.set(id, action);
    return { id, label, ...extra };
  };
  const mutate = (command: Parameters<ProjectGroupsController["mutate"]>[1]) =>
    controller.mutate(row.environmentId, command);
  const paths = projectGroupPaths(snapshot);
  const destinations = (
    action: (id: string | null) => unknown,
    current: string | null,
    root: string,
    exclude?: string,
  ): ContextMenuItem[] => [
    item(root, () => action(null), { checked: current === null }),
    ...snapshot.groups
      .filter((candidate) => {
        let cursor: typeof candidate | undefined = candidate;
        while (cursor) {
          if (cursor.id === exclude) return false;
          cursor = snapshot.groups.find((entry) => entry.id === cursor?.parentId);
        }
        return true;
      })
      .map((candidate) =>
        item(paths.get(candidate.id) ?? candidate.name, () => action(candidate.id), {
          checked: current === candidate.id,
        }),
      ),
  ];
  const items: ContextMenuItem[] = group
    ? [
        item("New coordination thread", () => onCoordinate(target)),
        item("New subgroup…", () =>
          onEdit({ environmentId: row.environmentId, parentId: group.id }),
        ),
        item("Rename…", () => onEdit(target), { separatorBefore: true }),
        {
          id: "move",
          label: "Move to",
          children: destinations(
            (parentId) => mutate({ type: "move", groupId: group.id, parentId, beforeId: null }),
            group.parentId,
            "Top level",
            group.id,
          ),
        },
      ]
    : [item("New group…", () => onEdit(target))];
  if (group) {
    const siblings = snapshot.groups.filter((entry) => entry.parentId === group.parentId);
    const index = siblings.findIndex((entry) => entry.id === group.id);
    items.push(
      item(
        "Move up",
        () =>
          mutate({
            type: "move",
            groupId: group.id,
            parentId: group.parentId,
            beforeId: siblings[index - 1]!.id,
          }),
        { disabled: index === 0 },
      ),
      item(
        "Move down",
        () =>
          mutate({
            type: "move",
            groupId: group.id,
            parentId: group.parentId,
            beforeId: siblings[index + 2]?.id ?? null,
          }),
        { disabled: index === siblings.length - 1 },
      ),
    );
    const bindings = snapshot.threads.filter((binding) => binding.groupId === group.id);
    if (bindings.length)
      items.push({
        id: "threads",
        label: "Coordination threads",
        children: bindings.map((binding) => ({
          id: `thread:${binding.threadId}`,
          label:
            input.threads.find(
              (thread) =>
                thread.environmentId === row.environmentId && thread.id === binding.threadId,
            )?.title ?? "Pending coordination thread",
          children: binding.pending
            ? [
                item("Retry setup", () => onCoordinate(target, binding.threadId)),
                item("Cancel pending setup", () =>
                  mutate({ type: "assignThread", threadId: binding.threadId, groupId: null }),
                ),
              ]
            : destinations(
                (groupId) => mutate({ type: "assignThread", threadId: binding.threadId, groupId }),
                binding.groupId,
                "No group (keep thread)",
              ),
        })),
      });
    items.push(
      item(
        "Remove group…",
        async () => {
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(
              `Remove “${group.name}”? Projects, subgroups and threads move to its parent. Nothing is deleted.`,
              { variant: "destructive" },
            ),
          );
          if (confirmed._tag === "Success" && confirmed.value)
            await mutate({ type: "remove", groupId: group.id });
        },
        { destructive: true, separatorBefore: true },
      ),
    );
  }
  const clicked = await settlePromise(() => api.contextMenu.show(items, input.position));
  if (clicked._tag === "Success" && clicked.value !== null) await actions.get(clicked.value)?.();
}
