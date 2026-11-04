import {
  ProjectGroupsError,
  type ProjectGroupsCommand,
  type ProjectGroupsSnapshot,
} from "@t3tools/contracts/t3custom/projectGroups";

export const emptyProjectGroups: ProjectGroupsSnapshot = {
  version: 1,
  revision: 0,
  groups: [],
  projects: [],
  threads: [],
};

export function validateProjectGroups(state: ProjectGroupsSnapshot): void {
  const byId = new Map(state.groups.map((group) => [group.id, group]));
  const invalid = () => {
    throw new ProjectGroupsError({ reason: "invalid" });
  };
  if (byId.size !== state.groups.length || state.groups.length > 2000) invalid();
  for (const group of state.groups) {
    const visited = new Set([group.id]);
    let parentId = group.parentId;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent || visited.has(parentId)) return invalid();
      visited.add(parentId);
      parentId = parent.parentId;
    }
  }
  if (new Set(state.projects.map((entry) => entry.projectId)).size !== state.projects.length)
    invalid();
  if (new Set(state.threads.map((entry) => entry.threadId)).size !== state.threads.length)
    invalid();
  for (const entry of [...state.projects, ...state.threads])
    if (!byId.has(entry.groupId)) invalid();
}

export function applyProjectGroupsCommand(
  state: ProjectGroupsSnapshot,
  command: ProjectGroupsCommand,
): ProjectGroupsSnapshot {
  let groups = [...state.groups];
  let projects = [...state.projects];
  let threads = [...state.threads];
  const requireGroup = (id: string | null) => {
    if (id !== null && !groups.some((group) => group.id === id))
      throw new ProjectGroupsError({ reason: "invalid" });
  };
  if (command.type !== "create") requireGroup(command.groupId);
  switch (command.type) {
    case "create":
      if (groups.some((group) => group.id === command.group.id))
        throw new ProjectGroupsError({ reason: "invalid" });
      requireGroup(command.group.parentId);
      groups.push(command.group);
      break;
    case "rename":
      groups = groups.map((group) =>
        group.id === command.groupId ? { ...group, name: command.name } : group,
      );
      break;
    case "move": {
      requireGroup(command.parentId);
      const moving = groups.find((group) => group.id === command.groupId)!;
      groups = groups.filter((group) => group.id !== command.groupId);
      const index =
        command.beforeId === null
          ? groups.length
          : groups.findIndex(
              (group) => group.id === command.beforeId && group.parentId === command.parentId,
            );
      if (index < 0) throw new ProjectGroupsError({ reason: "invalid" });
      groups.splice(index, 0, { ...moving, parentId: command.parentId });
      break;
    }
    case "remove": {
      const parentId = groups.find((group) => group.id === command.groupId)!.parentId;
      groups = groups
        .filter((group) => group.id !== command.groupId)
        .map((group) => (group.parentId === command.groupId ? { ...group, parentId } : group));
      projects = projects.flatMap((entry) =>
        entry.groupId !== command.groupId
          ? [entry]
          : parentId === null
            ? []
            : [{ ...entry, groupId: parentId }],
      );
      threads = threads.flatMap((entry) =>
        entry.groupId !== command.groupId
          ? [entry]
          : parentId === null
            ? []
            : [{ ...entry, groupId: parentId }],
      );
      break;
    }
    case "assignProjects":
      projects = projects.filter((entry) => !command.projectIds.includes(entry.projectId));
      if (command.groupId !== null)
        for (const projectId of new Set(command.projectIds))
          projects.push({ projectId, groupId: command.groupId });
      break;
    case "assignThread":
      threads = threads.filter((entry) => entry.threadId !== command.threadId);
      if (command.groupId !== null)
        threads.push({ threadId: command.threadId, groupId: command.groupId });
      break;
  }
  const next = { ...state, revision: state.revision + 1, groups, projects, threads };
  validateProjectGroups(next);
  return next;
}
