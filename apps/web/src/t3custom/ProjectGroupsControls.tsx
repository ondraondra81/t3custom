import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../uiStateStore";
import { randomUUID } from "../lib/utils";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectGroup } from "@t3tools/contracts/t3custom/projectGroups";
import { ChevronDownIcon, FolderIcon, MoreHorizontalIcon } from "lucide-react";
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
import type { ProjectGroupsDrag } from "./projectGroupsDrag";
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
  parentId?: string | null;
};

export function ProjectGroupHeader({
  row,
  controller,
  onMenu,
  drag,
  label,
}: {
  row: Extract<ProjectGroupsRow, { kind: "environment" | "group" }>;
  controller: ProjectGroupsController;
  onMenu: (
    row: Extract<ProjectGroupsRow, { kind: "environment" | "group" }>,
    position: { x: number; y: number },
  ) => void;
  drag: ProjectGroupsDrag;
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
    <li
      className="group/project-group relative mt-1 list-none"
      style={{ marginInlineStart: row.depth * 12 }}
    >
      <div className="flex items-center gap-1">
        <button
          {...drag.targetProps(row.environmentId, isGroup ? (row.group?.id ?? null) : null, row.id)}
          type="button"
          aria-description={
            isGroup ? "Drop a project here to move it" : "Drop a project here to unassign it"
          }
          onContextMenu={(event) => {
            event.preventDefault();
            onMenu(row, { x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu(row, { x: rect.left, y: rect.bottom });
            }
          }}
          data-sidebar-row={row.id}
          data-sidebar-parent={isGroup ? row.parentId : undefined}
          aria-expanded={isGroup ? !row.collapsed : true}
          onClick={() => isGroup && controller.toggle(row.id)}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-xs font-medium text-sidebar-muted-foreground data-[drop-active=true]:bg-accent data-[drop-active=true]:ring-2 data-[drop-active=true]:ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
          <span className="opacity-0 group-hover/project-group:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              disabled={!canEdit}
              aria-label={`Actions for ${name}`}
              data-sidebar-action-for={row.id}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(row, { x: rect.left, y: rect.bottom });
              }}
            >
              <MoreHorizontalIcon />
            </Button>
          </span>
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
  controller,
  onClose,
}: {
  target: GroupEditorTarget;
  controller: ProjectGroupsController;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.group?.name ?? "");
  const state = controller.states.find((entry) => entry.environmentId === target.environmentId);
  const disabled = !state?.writable || controller.pending;
  const submit = async () => {
    if (disabled || !name.trim()) return;
    const command = target.group
      ? { type: "rename" as const, groupId: target.group.id, name }
      : {
          type: "create" as const,
          group: { id: randomUUID(), name, parentId: target.parentId ?? null },
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogTitle>{target.group ? "Rename group" : "New group"}</DialogTitle>
          <DialogDescription>
            {target.group
              ? "Choose a name for this group."
              : "Drag projects into your group to organize them."}
          </DialogDescription>
          <div className="py-4">
            <label className="flex flex-col gap-1 text-sm">
              Name
              <Input
                autoFocus
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {controller.error && (
              <p role="alert" className="mt-2 text-sm text-error">
                {controller.error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={controller.pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={disabled || !name.trim()}>
              {target.group ? "Save" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
