import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../uiStateStore";
import { randomUUID } from "../lib/utils";
import { useState } from "react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ProjectGroup } from "@t3tools/contracts/t3custom/projectGroups";
import { projectGroupPaths } from "@t3tools/client-runtime/t3custom/projectGroups";
import { ChevronDownIcon, FolderIcon, Settings2Icon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { SettingsRow } from "../components/settings/settingsLayout";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../components/Sidebar.logic";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useProjectGroupsEnabled, type ProjectGroupsController } from "./projectGroupsState";
import type { ProjectGroupsRow } from "./projectGroupsTree";

export function ProjectGroupsSetting() {
  const [enabled, setEnabled] = useProjectGroupsEnabled();
  return (
    <SettingsRow
      title="Project groups"
      description="Organize projects into nested groups on each environment. Uses project folders; the Working shelf and thread dragging are hidden. Turning this off preserves your groups."
      control={
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Project groups" />
      }
    />
  );
}

export type GroupEditorTarget = {
  environmentId: EnvironmentId;
  group?: ProjectGroup;
  projectIds?: readonly ProjectId[];
  parentId?: string | null;
};

export function ProjectGroupHeader({
  row,
  controller,
  onEdit,
  label,
}: {
  row: Extract<ProjectGroupsRow, { kind: "environment" | "group" }>;
  controller: ProjectGroupsController;
  onEdit: (target: GroupEditorTarget) => void;
  label?: string | null | undefined;
}) {
  const state = controller.states.find((entry) => entry.environmentId === row.environmentId);
  const canEdit = state?.writable && !controller.pending;
  const isGroup = row.kind === "group";
  const name = isGroup ? (row.group?.name ?? "Unassigned") : (label ?? "Environment");
  const localVisits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = isGroup
    ? resolveSidebarFolderDot(
        row.hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localVisits[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
          ),
        })),
      )
    : null;
  return (
    <li className="relative mt-2 list-none" style={{ marginInlineStart: row.depth * 12 }}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-sidebar-row={row.id}
          data-sidebar-parent={isGroup ? row.parentId : undefined}
          aria-expanded={isGroup ? !row.collapsed : true}
          onClick={() => isGroup && controller.toggle(row.id)}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-sm font-medium hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {isGroup ? (
            <ChevronDownIcon className={`size-3 shrink-0 ${row.collapsed ? "-rotate-90" : ""}`} />
          ) : (
            <FolderIcon className="size-4 shrink-0" />
          )}
          <span className="truncate">{name}</span>
          {dot && (
            <span className="ml-auto text-xs text-sidebar-muted-foreground">
              {dot === "attention"
                ? "Needs you"
                : dot === "working"
                  ? "Working"
                  : dot === "failed"
                    ? "Failed"
                    : "Unread"}
            </span>
          )}
        </button>
        {(!isGroup || row.group) && (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            disabled={!canEdit}
            aria-label={isGroup ? `Manage ${name}` : `New group in ${name}`}
            data-sidebar-action-for={row.id}
            onClick={() =>
              onEdit({
                environmentId: row.environmentId,
                ...(isGroup && row.group ? { group: row.group } : {}),
              })
            }
          >
            <Settings2Icon />
          </Button>
        )}
      </div>
      {!isGroup && state?.error && (
        <p role="status" className="px-2 text-xs text-error">
          {state.error}
        </p>
      )}
    </li>
  );
}

export function ProjectGroupsEditor({
  target,
  threads,
  controller,
  projects,
  onClose,
  onTarget,
  onCoordinate,
}: {
  target: GroupEditorTarget;
  threads: readonly EnvironmentThreadShell[];
  controller: ProjectGroupsController;
  projects: readonly SidebarProjectSnapshot[];
  onClose: () => void;
  onTarget: (target: GroupEditorTarget) => void;
  onCoordinate: (target: GroupEditorTarget, resumeThreadId?: ThreadId) => Promise<void>;
}) {
  const snapshot = controller.snapshots.get(target.environmentId);
  const [name, setName] = useState(target.group?.name ?? "");
  const [parentId, setParentId] = useState(target.group?.parentId ?? target.parentId ?? "");
  const [destination, setDestination] = useState(
    target.group?.id ??
      snapshot?.projects.find((entry) => entry.projectId === target.projectIds?.[0])?.groupId ??
      "",
  );
  const [beforeId, setBeforeId] = useState("");
  const [selectedProjects, setSelectedProjects] = useState<readonly ProjectId[]>(
    target.projectIds ?? [],
  );
  if (!snapshot) return null;
  const state = controller.states.find((entry) => entry.environmentId === target.environmentId);
  const disabled = !state?.writable || controller.pending;
  const paths = projectGroupPaths(snapshot);
  const options = snapshot.groups.map((group) => (
    <option key={group.id} value={group.id}>
      {paths.get(group.id)}
    </option>
  ));
  const validParents = options.filter((option) => {
    let group = snapshot.groups.find((entry) => entry.id === option.key);
    while (group) {
      if (group.id === target.group?.id) return false;
      group = snapshot.groups.find((entry) => entry.id === group?.parentId);
    }
    return true;
  });
  const physicalProjects = [
    ...new Map(
      projects
        .flatMap((project) => project.memberProjects)
        .filter((project) => project.environmentId === target.environmentId && !project.isScratch)
        .map((project) => [project.id, project]),
    ).values(),
  ];
  const submit = async () => {
    const command = target.projectIds
      ? {
          type: "assignProjects" as const,
          projectIds: target.projectIds,
          groupId: destination || null,
        }
      : target.group
        ? { type: "rename" as const, groupId: target.group.id, name }
        : {
            type: "create" as const,
            group: { id: randomUUID(), name, parentId: parentId || null },
          };
    if (await controller.mutate(target.environmentId, command)) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !controller.pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogTitle>
          {target.projectIds
            ? "Move projects to group"
            : target.group
              ? `Manage ${target.group.name}`
              : "New group"}
        </DialogTitle>
        <DialogDescription>
          Groups organize projects on this environment. Removing a group moves its contents to its
          parent and keeps every project and thread.
        </DialogDescription>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto py-4">
          {!target.projectIds && (
            <label className="flex flex-col gap-1 text-sm">
              Name
              <Input
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {!target.projectIds && (
            <label className="flex flex-col gap-1 text-sm">
              Parent group
              <select
                className="rounded border bg-background p-2"
                value={parentId}
                onChange={(event) => {
                  setParentId(event.target.value);
                  setBeforeId("");
                }}
              >
                <option value="">Top level</option>
                {validParents}
              </select>
            </label>
          )}
          {target.group && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void onCoordinate(target)}
              >
                New coordination thread
              </Button>
              {snapshot.threads
                .filter((thread) => thread.groupId === target.group?.id && thread.pending)
                .map((thread) => (
                  <Button
                    key={thread.threadId}
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onCoordinate(target, thread.threadId)}
                  >
                    Retry coordination thread setup
                  </Button>
                ))}
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  onTarget({ environmentId: target.environmentId, parentId: target.group!.id })
                }
              >
                New subgroup
              </Button>
              <label className="flex flex-col gap-1 text-sm">
                Position
                <select
                  className="rounded border bg-background p-2"
                  value={beforeId}
                  onChange={(event) => setBeforeId(event.target.value)}
                >
                  <option value="">Last</option>
                  {snapshot.groups
                    .filter(
                      (group) =>
                        group.id !== target.group?.id && group.parentId === (parentId || null),
                    )
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        Before {group.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={async () => {
                    if (
                      await controller.mutate(target.environmentId, {
                        type: "move",
                        groupId: target.group!.id,
                        parentId: parentId || null,
                        beforeId: beforeId || null,
                      })
                    )
                      onClose();
                  }}
                >
                  Move group
                </Button>
              </div>
              <details>
                <summary className="cursor-pointer text-sm">Assign projects</summary>
                <div className="flex flex-col gap-2 py-2">
                  {physicalProjects.map((project) => (
                    <label key={project.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedProjects.includes(project.id)}
                        onChange={(event) =>
                          setSelectedProjects(
                            event.target.checked
                              ? [...selectedProjects, project.id]
                              : selectedProjects.filter((id) => id !== project.id),
                          )
                        }
                      />
                      <span className="truncate">{project.title}</span>
                    </label>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || selectedProjects.length === 0}
                    onClick={async () => {
                      if (
                        await controller.mutate(target.environmentId, {
                          type: "assignProjects",
                          projectIds: selectedProjects,
                          groupId: target.group!.id,
                        })
                      )
                        onClose();
                    }}
                  >
                    Move selected projects here
                  </Button>
                </div>
              </details>
              <details>
                <summary className="cursor-pointer text-sm">
                  Move or detach coordination threads
                </summary>
                <div className="flex flex-col gap-2 py-2">
                  {snapshot.threads
                    .filter((binding) => binding.groupId === target.group?.id)
                    .map((binding) => {
                      const thread = threads.find(
                        (entry) =>
                          entry.environmentId === target.environmentId &&
                          entry.id === binding.threadId,
                      );
                      return (
                        <label key={binding.threadId} className="flex flex-col gap-1 text-sm">
                          {thread?.title ??
                            (binding.pending
                              ? "Pending coordination thread"
                              : "Unavailable coordination thread")}
                          <select
                            className="rounded border bg-background p-2"
                            value={binding.groupId}
                            disabled={disabled}
                            onChange={(event) =>
                              void controller.mutate(target.environmentId, {
                                type: "assignThread",
                                threadId: binding.threadId,
                                groupId: event.target.value || null,
                              })
                            }
                          >
                            <option value="">
                              {binding.pending ? "Cancel pending setup" : "No group (keep thread)"}
                            </option>
                            {binding.pending ? (
                              <option value={binding.groupId}>{paths.get(binding.groupId)}</option>
                            ) : (
                              options
                            )}
                          </select>
                        </label>
                      );
                    })}
                </div>
              </details>
              <Button
                variant="destructive"
                size="sm"
                disabled={disabled}
                onClick={async () => {
                  if (
                    await controller.mutate(target.environmentId, {
                      type: "remove",
                      groupId: target.group!.id,
                    })
                  )
                    onClose();
                }}
              >
                Remove group, keep contents
              </Button>
            </>
          )}
          {target.projectIds && (
            <label className="flex flex-col gap-1 text-sm">
              Destination
              <select
                className="rounded border bg-background p-2"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="">Unassigned</option>
                {options}
              </select>
            </label>
          )}
          {controller.error && (
            <p role="alert" className="text-sm text-error">
              {controller.error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={controller.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={disabled || (!target.projectIds && !name.trim())}
            onClick={() => void submit()}
          >
            {target.projectIds ? "Move projects" : target.group ? "Rename" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
