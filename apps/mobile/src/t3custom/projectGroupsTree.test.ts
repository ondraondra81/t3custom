import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectGroupsSnapshot } from "@t3tools/contracts/t3custom/projectGroups";
import { expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../test-fixtures";
import { coordinationPrompt, groupDescendants, mobileGroupRows } from "./projectGroupsTree";

const environmentId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const projectId = ProjectId.make("api");
const scratchId = ProjectId.make("scratch");
const threadId = ThreadId.make("coordination");
const snapshot: ProjectGroupsSnapshot = {
  version: 1,
  revision: 5,
  groups: [
    { id: "parent", name: "Minion", parentId: null },
    { id: "child", name: "Nelson", parentId: "parent" },
  ],
  projects: [{ projectId, groupId: "child" }],
  threads: [{ threadId, groupId: "parent" }],
};
function project(id: typeof projectId, environment = environmentId): EnvironmentProject {
  return {
    id,
    environmentId: environment,
    title: id,
    workspaceRoot: `/workspaces/${environment}/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...(id === scratchId ? { isScratch: true } : {}),
  };
}
const projects = [project(projectId), project(scratchId), project(projectId, remoteId)];
const threads = [
  makeThreadShellFixture({
    environmentId,
    id: threadId,
    projectId: scratchId,
    title: "Coordinate",
  }),
  makeThreadShellFixture({ environmentId, id: ThreadId.make("api-work"), projectId, title: "API" }),
  makeThreadShellFixture({
    environmentId: remoteId,
    id: threadId,
    projectId,
    title: "Other machine",
  }),
];
const input = {
  environmentId,
  snapshot,
  projects,
  threads,
  collapsed: new Set<string>(),
  expandedProjects: new Set([projectId, scratchId]),
};

it("keeps environment boundaries and shows scratch coordination only under its group", () => {
  const rows = mobileGroupRows(input);
  expect(rows.map((row) => row.key)).toEqual([
    "group:parent",
    "group:child",
    "project:api",
    "thread:api-work",
    "thread:coordination",
    "project:scratch",
  ]);
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 1, 0]);
  expect(
    rows.filter((row) => row.kind === "thread").map((row) => row.thread.environmentId),
  ).toEqual([environmentId, environmentId]);
  expect(
    mobileGroupRows({ ...input, collapsed: new Set(["parent"]) }).map((row) => row.key),
  ).toEqual(["group:parent", "project:scratch"]);
});

it("keeps interrupted coordination setup retryable without showing an archived thread", () => {
  const pendingSnapshot = { ...snapshot, threads: [{ threadId, groupId: "child", pending: true }] };
  const rows = mobileGroupRows({
    ...input,
    snapshot: pendingSnapshot,
    threads: threads.map((thread) => ({ ...thread, archivedAt: "2026-11-02T00:00:00Z" })),
  });
  expect(rows.filter((row) => row.kind === "pending").map((row) => row.key)).toEqual([
    "thread:coordination",
  ]);
  expect(rows.some((row) => row.kind === "thread")).toBe(false);
});

it("includes descendant projects from only the selected environment in the unsent coordination draft", () => {
  expect([...groupDescendants(snapshot, "parent")]).toEqual(["parent", "child"]);
  const text = coordinationPrompt(environmentId, snapshot.groups[0]!, snapshot, projects);
  expect(text).toContain("/workspaces/local/api");
  expect(text).not.toContain("/workspaces/remote/api");
  expect(text).toContain("revision: 5");
  expect(text).toContain("does not change its working directory");
});
