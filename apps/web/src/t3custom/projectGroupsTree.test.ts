import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { type ProjectGroupsSnapshot } from "@t3tools/contracts/t3custom/projectGroups";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import { groupRowId, projectGroupsRows, splitProjectGroups } from "./projectGroupsTree";
import { sidebarFolderExpansionKeys } from "../components/Sidebar.logic";

const mac = EnvironmentId.make("mac");
const mf1 = EnvironmentId.make("mf1");
const project = (id: string, environmentId = mac): Project => ({
  id: ProjectId.make(id),
  environmentId,
  title: "Shared repository",
  workspaceRoot: `/repos/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  scripts: [],
});
const snapshots = (projects: Project[]) =>
  buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: mac,
    resolveEnvironmentLabel: (id) => id,
  });
const tree: ProjectGroupsSnapshot = {
  version: 1,
  revision: 2,
  groups: [
    { id: "root", name: "Minion", parentId: null },
    { id: "child", name: "Nelson", parentId: "root" },
  ],
  projects: [{ projectId: ProjectId.make("a"), groupId: "child" }],
  threads: [],
};

describe("organized sidebar", () => {
  it("splits a shared logical folder by environment and placement without sharing collapse identity", () => {
    expect(groupRowId(mac, "unassigned")).not.toBe(groupRowId(mac, null));
    const base = snapshots([project("a"), project("b"), project("c", mf1)]);
    const merged = {
      ...base[0]!,
      memberProjects: base.flatMap((group) => group.memberProjects),
      memberProjectRefs: base.flatMap((group) => group.memberProjectRefs),
    };
    const split = splitProjectGroups(
      [merged],
      new Map([
        [mac, tree],
        [mf1, { ...tree, projects: [] }],
      ]),
    );
    expect(split).toHaveLength(3);
    expect(new Set(split.map((group) => group.folderId)).size).toBe(3);
    expect(new Set(split.flatMap(sidebarFolderExpansionKeys)).size).toBe(3);
    expect(split.map((group) => group.memberProjects.map((member) => member.id))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
    expect(split.every((group) => group.projectKey === merged.projectKey)).toBe(true);
  });

  it("keeps empty groups, orders visible threads with the tree, and reveals an active descendant", () => {
    const state = new Map([[mac, tree]]);
    const thread = makeThreadFixture({ environmentId: mac, projectId: ProjectId.make("a") });
    const folders = splitProjectGroups(snapshots([project("a"), project("b")]), state).map(
      (group) => ({
        group,
        collapsed: false,
        hiddenThreads: [],
        threads: group.id === "a" ? [thread] : [],
      }),
    );
    const collapsed = new Set([groupRowId(mac, "root")]);
    const closed = projectGroupsRows({
      folders,
      snapshots: state,
      collapsed,
      routeThreadKey: null,
    });
    expect(closed.filter((row) => row.kind === "folder").map((row) => row.folder.group.id)).toEqual(
      ["b"],
    );
    const visible = projectGroupsRows({
      folders,
      snapshots: state,
      collapsed,
      routeThreadKey: `${mac}:${thread.id}`,
    });
    expect(visible.map((row) => row.kind)).toEqual([
      "environment",
      "group",
      "group",
      "folder",
      "group",
      "folder",
    ]);
    expect(visible.flatMap((row) => (row.kind === "folder" ? row.folder.threads : []))).toEqual([
      thread,
    ]);
    expect(new Set(visible.map((row) => row.id)).size).toBe(visible.length);
  });

  it("moves only bound Scratch threads into groups and leaves uncustomized environments visible", () => {
    const thread = makeThreadFixture({ environmentId: mac, projectId: ProjectId.make("scratch") });
    const state = new Map([
      [mac, { ...tree, projects: [], threads: [{ threadId: thread.id, groupId: "child" }] }],
    ]);
    const groups = splitProjectGroups(
      snapshots([{ ...project("scratch"), isScratch: true }, project("remote", mf1)]),
      state,
    );
    const rows = projectGroupsRows({
      folders: groups.map((group) => ({
        group,
        collapsed: false,
        hiddenThreads: [],
        threads: group.isScratch ? [thread] : [],
      })),
      snapshots: state,
      collapsed: new Set(),
      routeThreadKey: null,
    });
    expect(rows.filter((row) => row.kind === "thread").map((row) => row.thread.id)).toEqual([
      thread.id,
    ]);
    expect(
      rows.filter((row) => row.kind === "folder").flatMap((row) => row.folder.threads),
    ).toEqual([]);
    expect(rows.at(-1)?.kind).toBe("folder");
  });
});
