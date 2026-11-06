import type { ProjectGroupsSnapshot } from "@t3tools/contracts/t3custom/projectGroups";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

type Group = ProjectGroupsSnapshot["groups"][number];
export type GroupTreeRow =
  | { kind: "group"; key: string; depth: number; group: Group; expanded: boolean }
  | { kind: "project"; key: string; depth: number; project: EnvironmentProject; expanded: boolean }
  | {
      kind: "thread";
      key: string;
      depth: number;
      thread: EnvironmentThreadShell;
      coordination: boolean;
    }
  | {
      kind: "pending";
      key: string;
      depth: number;
      entry: ProjectGroupsSnapshot["threads"][number];
    };

export function groupDescendants(snapshot: ProjectGroupsSnapshot, groupId: string) {
  const ids = new Set([groupId]);
  const pending = [groupId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    for (const group of snapshot.groups) {
      if (group.parentId === parentId && !ids.has(group.id)) {
        ids.add(group.id);
        pending.push(group.id);
      }
    }
  }
  return ids;
}

export function mobileGroupRows(input: {
  environmentId: EnvironmentId;
  snapshot: ProjectGroupsSnapshot;
  projects: readonly EnvironmentProject[];
  threads: readonly EnvironmentThreadShell[];
  collapsed: ReadonlySet<string>;
  expandedProjects: ReadonlySet<string>;
}): GroupTreeRow[] {
  const { snapshot, environmentId } = input;
  const projects = input.projects.filter((p) => p.environmentId === environmentId && !p.archivedAt);
  const threads = input.threads.filter((t) => t.environmentId === environmentId && !t.archivedAt);
  const byThread = new Map(threads.map((t) => [t.id, t]));
  const placements = new Map(snapshot.projects.map((p) => [p.projectId, p.groupId]));
  const coordination = new Set(snapshot.threads.map((t) => t.threadId));
  const rows: GroupTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const group of snapshot.groups) {
      if (group.parentId !== parentId || visited.has(group.id)) continue;
      visited.add(group.id);
      const expanded = !input.collapsed.has(group.id);
      rows.push({ kind: "group", key: `group:${group.id}`, group, depth, expanded });
      if (expanded) visit(group.id, depth + 1);
    }
    for (const entry of snapshot.threads) {
      if (entry.groupId !== parentId) continue;
      if (entry.pending) {
        rows.push({ kind: "pending", key: `thread:${entry.threadId}`, entry, depth });
      } else {
        const thread = byThread.get(entry.threadId);
        if (thread)
          rows.push({
            kind: "thread",
            key: `thread:${thread.id}`,
            thread,
            depth,
            coordination: true,
          });
      }
    }
    for (const project of projects) {
      if ((placements.get(project.id) ?? null) !== parentId) continue;
      const expanded = input.expandedProjects.has(project.id);
      rows.push({ kind: "project", key: `project:${project.id}`, project, depth, expanded });
      if (expanded) {
        for (const thread of threads) {
          if (thread.projectId === project.id && !coordination.has(thread.id)) {
            rows.push({
              kind: "thread",
              key: `thread:${thread.id}`,
              thread,
              depth: depth + 1,
              coordination: false,
            });
          }
        }
      }
    }
  };
  visit(null, 0);
  return rows;
}

export function coordinationPrompt(
  environmentId: EnvironmentId,
  group: Group,
  snapshot: ProjectGroupsSnapshot,
  projects: readonly EnvironmentProject[],
) {
  const ids = groupDescendants(snapshot, group.id);
  const byId = new Map(
    projects.filter((p) => p.environmentId === environmentId).map((p) => [p.id, p]),
  );
  const members = snapshot.projects
    .filter((p) => ids.has(p.groupId))
    .map((entry) => {
      const project = byId.get(entry.projectId);
      return project
        ? `- ${project.title}: ${project.workspaceRoot} (project ${entry.projectId})`
        : `- Unavailable project ${entry.projectId}`;
    });
  return `Coordinate development across the ${group.name} group.\nEnvironment: ${environmentId}; group membership revision: ${snapshot.revision}.\nProjects:\n${members.join("\n")}\n\nStart with a plan and identify dependencies between repositories. This conversation has its own workspace; group membership does not change its working directory.`;
}
