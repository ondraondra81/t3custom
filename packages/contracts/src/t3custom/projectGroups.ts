import { ModelSelection } from "../modelSelection.ts";
import { RuntimeMode } from "../providerPolicy.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

const GroupId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const ParentId = Schema.NullOr(GroupId);
export const ProjectGroup = Schema.Struct({
  id: GroupId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  parentId: ParentId,
});
export type ProjectGroup = typeof ProjectGroup.Type;

export const ProjectGroupsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  groups: Schema.Array(ProjectGroup).check(Schema.isMaxLength(2000)),
  projects: Schema.Array(Schema.Struct({ projectId: ProjectId, groupId: GroupId })),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      groupId: GroupId,
      pending: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ProjectGroupsSnapshot = typeof ProjectGroupsSnapshot.Type;

export const ProjectGroupsCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create"), group: ProjectGroup }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    groupId: GroupId,
    name: ProjectGroup.fields.name,
  }),
  Schema.Struct({
    type: Schema.Literal("move"),
    groupId: GroupId,
    parentId: ParentId,
    beforeId: ParentId,
  }),
  Schema.Struct({ type: Schema.Literal("remove"), groupId: GroupId }),
  Schema.Struct({
    type: Schema.Literal("assignProjects"),
    projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(2000)),
    groupId: ParentId,
  }),
  Schema.Struct({ type: Schema.Literal("assignThread"), threadId: ThreadId, groupId: ParentId }),
]);
export type ProjectGroupsCommand = typeof ProjectGroupsCommand.Type;

export const ProjectGroupsMutation = Schema.Struct({
  expectedRevision: NonNegativeInt,
  mutationId: GroupId,
  command: ProjectGroupsCommand,
});
export type ProjectGroupsMutation = typeof ProjectGroupsMutation.Type;

export const ProjectGroupsCoordinateInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    groupId: GroupId,
    expectedRevision: NonNegativeInt,
    threadId: ThreadId,
    commandId: CommandId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({ type: Schema.Literal("resume"), threadId: ThreadId }),
]);
export type ProjectGroupsCoordinateInput = typeof ProjectGroupsCoordinateInput.Type;

export class ProjectGroupsError extends Schema.TaggedError<ProjectGroupsError>()(
  "ProjectGroupsError",
  {
    reason: Schema.Literals([
      "conflict",
      "invalid",
      "missing-reference",
      "storage",
      "unsupported-version",
      "thread-setup",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "conflict":
        return "Groups changed on another client. Reload and try again.";
      case "invalid":
        return "This group change is not valid.";
      case "missing-reference":
        return "The project or coordination thread is not available on this environment.";
      case "unsupported-version":
        return "Group data belongs to a newer version. Update this app before editing it.";
      case "thread-setup":
        return "Coordination thread setup did not finish. Retry setup from its group.";
      case "storage":
        return "Group data could not be read or saved. Existing data has been preserved.";
    }
  }
}

export const PROJECT_GROUPS_METHODS = {
  t3customProjectGroupsCoordinate: "t3custom.groups.coordinate",
  t3customProjectGroupsSnapshot: "t3custom.groups.snapshot",
  t3customProjectGroupsSubscribe: "t3custom.groups.subscribe",
  t3customProjectGroupsMutate: "t3custom.groups.mutate",
} as const;
const error = Schema.Union([ProjectGroupsError, EnvironmentAuthorizationError]);
export const PROJECT_GROUPS_RPCS = [
  Rpc.make(PROJECT_GROUPS_METHODS.t3customProjectGroupsCoordinate, {
    payload: ProjectGroupsCoordinateInput,
    success: Schema.Struct({ threadId: ThreadId }),
    error,
  }),
  Rpc.make(PROJECT_GROUPS_METHODS.t3customProjectGroupsSnapshot, {
    payload: Schema.Struct({}),
    success: ProjectGroupsSnapshot,
    error,
  }),
  Rpc.make(PROJECT_GROUPS_METHODS.t3customProjectGroupsSubscribe, {
    payload: Schema.Struct({}),
    success: ProjectGroupsSnapshot,
    error,
    stream: true,
  }),
  Rpc.make(PROJECT_GROUPS_METHODS.t3customProjectGroupsMutate, {
    payload: ProjectGroupsMutation,
    success: ProjectGroupsSnapshot,
    error,
  }),
] as const;
export const PROJECT_GROUPS_SCOPES = {
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsCoordinate]: AuthOrchestrationOperateScope,
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsSnapshot]: AuthOrchestrationReadScope,
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsSubscribe]: AuthOrchestrationReadScope,
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsMutate]: AuthOrchestrationOperateScope,
} as const;
export const PROJECT_GROUPS_AGGREGATES = {
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsCoordinate]: "t3custom.groups",
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsSnapshot]: "t3custom.groups",
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsSubscribe]: "t3custom.groups",
  [PROJECT_GROUPS_METHODS.t3customProjectGroupsMutate]: "t3custom.groups",
} as const;
