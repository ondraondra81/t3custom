import type { EnvironmentId, ProjectGroup, ProjectGroupsSnapshot } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

export const groupRowId = (environmentId: EnvironmentId, groupId: string | null) =>
  `t3custom:group:${JSON.stringify([environmentId, groupId])}`;
const environmentRowId = (environmentId: EnvironmentId) => `t3custom:environment:${environmentId}`;
export type ProjectFolder = {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  threads: readonly EnvironmentThreadShell[];
  hiddenThreads: readonly EnvironmentThreadShell[];
};
export type ProjectGroupsRow =
  | { kind: "environment"; id: string; environmentId: EnvironmentId; depth: number }
  | {
      kind: "group";
      id: string;
      parentId: string;
      environmentId: EnvironmentId;
      group: ProjectGroup | null;
      collapsed: boolean;
      hiddenThreads: readonly EnvironmentThreadShell[];
      depth: number;
    }
  | { kind: "folder"; id: string; parentId?: string; folder: ProjectFolder; depth: number }
  | { kind: "thread"; id: string; parentId: string; thread: EnvironmentThreadShell; depth: number };

export function splitProjectGroups(
  groups: readonly SidebarProjectSnapshot[],
  snapshots: ReadonlyMap<EnvironmentId, ProjectGroupsSnapshot>,
): SidebarProjectSnapshot[] {
  return groups.flatMap((group) => {
    const buckets = new Map<string, (typeof group.memberProjects)[number][]>();
    for (const member of group.memberProjects) {
      const snapshot = snapshots.get(member.environmentId);
      const placement =
        snapshot?.projects.find((entry) => entry.projectId === member.id)?.groupId ?? null;
      const key = snapshot ? groupRowId(member.environmentId, placement) : "upstream";
      const bucket = buckets.get(key) ?? [];
      bucket.push(member);
      buckets.set(key, bucket);
    }
    return [...buckets].map(([key, members]) => {
      if (key === "upstream" && members.length === group.memberProjects.length) return group;
      const first = members[0]!;
      return {
        ...group,
        ...first,
        folderId: `${key}:${group.projectKey}`,
        memberProjects: members,
        memberProjectRefs: members.map((member) => ({
          environmentId: member.environmentId,
          projectId: member.id,
        })),
        groupedProjectCount: members.length,
        pinned: members.some((member) => member.pinnedAt != null),
        archived: members.every((member) => member.archivedAt != null),
      };
    });
  });
}

export function projectGroupsRows(input: {
  folders: readonly ProjectFolder[];
  snapshots: ReadonlyMap<EnvironmentId, ProjectGroupsSnapshot>;
  collapsed: ReadonlySet<string>;
  routeThreadKey: string | null;
  environmentIds?: readonly EnvironmentId[];
}): ProjectGroupsRow[] {
  const rows: ProjectGroupsRow[] = [];
  for (const environmentId of input.environmentIds ?? []) {
    if (!input.snapshots.has(environmentId))
      rows.push({
        kind: "environment",
        id: environmentRowId(environmentId),
        environmentId,
        depth: 0,
      });
  }
  const keyOf = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  for (const [environmentId, snapshot] of input.snapshots) {
    const envId = environmentRowId(environmentId);
    rows.push({ kind: "environment", id: envId, environmentId, depth: 0 });
    const folders = input.folders.filter((folder) => folder.group.environmentId === environmentId);
    const placement = new Map(snapshot.projects.map((entry) => [entry.projectId, entry.groupId]));
    const coordination = new Map(snapshot.threads.map((entry) => [entry.threadId, entry.groupId]));
    const activeCoordination = folders.flatMap((folder) =>
      folder.group.isScratch
        ? [...folder.threads, ...folder.hiddenThreads].filter((thread) =>
            coordination.has(thread.id),
          )
        : [],
    );
    const foldersIn = (id: string | null) =>
      folders.filter((folder) => (placement.get(folder.group.id) ?? null) === id);
    const descendantThreads = (id: string): EnvironmentThreadShell[] => {
      const ids = new Set([id]);
      const pending = [id];
      while (pending.length > 0) {
        const parent = pending.pop();
        for (const group of snapshot.groups)
          if (group.parentId === parent && !ids.has(group.id)) {
            ids.add(group.id);
            pending.push(group.id);
          }
      }
      return folders
        .flatMap((folder) =>
          ids.has(placement.get(folder.group.id) ?? "")
            ? [...folder.threads, ...folder.hiddenThreads]
            : [],
        )
        .concat(activeCoordination.filter((thread) => ids.has(coordination.get(thread.id)!)));
    };
    const visit = (group: ProjectGroup | null, depth: number, parentId: string) => {
      const id = groupRowId(environmentId, group?.id ?? null);
      const ownFolders = foldersIn(group?.id ?? null);
      const allThreads = group
        ? descendantThreads(group.id)
        : ownFolders.flatMap((folder) => [...folder.threads, ...folder.hiddenThreads]);
      const collapsed =
        input.collapsed.has(id) &&
        !allThreads.some((thread) => keyOf(thread) === input.routeThreadKey);
      rows.push({
        kind: "group",
        id,
        parentId,
        environmentId,
        group,
        depth,
        collapsed,
        hiddenThreads: collapsed ? allThreads : [],
      });
      if (collapsed) return;
      if (group) {
        for (const child of snapshot.groups)
          if (child.parentId === group.id) visit(child, depth + 1, id);
        for (const thread of activeCoordination)
          if (coordination.get(thread.id) === group.id)
            rows.push({
              kind: "thread",
              id: keyOf(thread),
              parentId: id,
              depth: depth + 1,
              thread,
            });
      }
      for (const folder of ownFolders) {
        const filtered = folder.group.isScratch
          ? {
              ...folder,
              threads: folder.threads.filter((thread) => !coordination.has(thread.id)),
              hiddenThreads: folder.hiddenThreads.filter((thread) => !coordination.has(thread.id)),
            }
          : folder;
        rows.push({
          kind: "folder",
          id: `folder:${folder.group.folderId ?? folder.group.projectKey}`,
          parentId: id,
          depth: depth + 1,
          folder: filtered,
        });
      }
    };
    for (const group of snapshot.groups) if (group.parentId === null) visit(group, 1, envId);
    if (foldersIn(null).length > 0) visit(null, 1, envId);
  }
  for (const folder of input.folders)
    if (!input.snapshots.has(folder.group.environmentId))
      rows.push({
        kind: "folder",
        id: `folder:${folder.group.folderId ?? folder.group.projectKey}`,
        depth: 0,
        folder,
      });
  return rows;
}
