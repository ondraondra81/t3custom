import type {
  EnvironmentId,
  ProjectGroup,
  ProjectGroupsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import type { Project } from "../types";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";

export function seedCoordinationPrompt(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  group: ProjectGroup,
  snapshot: ProjectGroupsSnapshot | undefined,
  projects: ReadonlyMap<string, Project>,
) {
  if (!snapshot) return;
  const descendants = new Set([group.id]);
  const pending = [group.id];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const child of snapshot.groups) {
      if (child.parentId === parent && !descendants.has(child.id)) {
        descendants.add(child.id);
        pending.push(child.id);
      }
    }
  }
  const members = snapshot.projects
    .filter((entry) => descendants.has(entry.groupId))
    .map((entry) => {
      const project = projects.get(`${environmentId}:${entry.projectId}`);
      return project
        ? `- ${project.title}: ${project.workspaceRoot} (project ${entry.projectId})`
        : `- Unavailable project ${entry.projectId}`;
    });
  useComposerDraftStore
    .getState()
    .setPrompt(
      scopeThreadRef(environmentId, threadId),
      `Coordinate development across the ${group.name} group.\nEnvironment: ${environmentId}; group membership revision: ${snapshot.revision}.\nProjects:\n${members.join("\n")}\n\nStart with a plan and identify dependencies between repositories. This conversation has its own workspace; group membership does not change its working directory.`,
    );
}
