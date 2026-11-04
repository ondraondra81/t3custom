import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import {
  OrchestrationV2ThreadLaunchInput,
  type ProjectGroupsCoordinateInput,
  type ThreadId,
  ProjectGroupsError,
  ProjectGroupsSnapshot,
  ProjectGroupsMutation,
} from "@t3tools/contracts";
import {
  applyProjectGroupsCommand,
  emptyProjectGroups,
  validateProjectGroups,
} from "@t3tools/shared/t3custom/projectGroups";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const Document = Schema.Struct({
  snapshot: ProjectGroupsSnapshot,
  pendingLaunches: Schema.optionalKey(Schema.Array(OrchestrationV2ThreadLaunchInput)),
  receipts: Schema.Array(Schema.Struct({ id: Schema.String, request: Schema.String })),
});
const DocumentJson = Schema.fromJsonString(Document);
const decodeDocument = Schema.decodeEffect(DocumentJson);
const encodeDocument = Schema.encodeEffect(DocumentJson);
const encodeMutation = Schema.encodeEffect(Schema.fromJsonString(ProjectGroupsMutation));
const isGroupsError = Schema.is(ProjectGroupsError);
const decodeVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ snapshot: Schema.Struct({ version: Schema.Number }) })),
);

export class ProjectGroups extends Context.Service<
  ProjectGroups,
  {
    readonly coordinate: (
      input: ProjectGroupsCoordinateInput,
    ) => Effect.Effect<{ threadId: ThreadId }, ProjectGroupsError>;
    readonly snapshot: Effect.Effect<ProjectGroupsSnapshot, ProjectGroupsError>;
    readonly changes: Stream.Stream<ProjectGroupsSnapshot, ProjectGroupsError>;
    readonly mutate: (
      input: ProjectGroupsMutation,
    ) => Effect.Effect<ProjectGroupsSnapshot, ProjectGroupsError>;
  }
>()("t3/t3custom/ProjectGroups") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const semaphore = yield* Semaphore.make(1);
  const launches = yield* Semaphore.make(1);
  const pubsub = yield* PubSub.unbounded<ProjectGroupsSnapshot>();
  const filePath = path.join(config.stateDir, "t3custom", "sidebar-groups.v1.json");
  const storageError = () => new ProjectGroupsError({ reason: "storage" });
  let cached: typeof Document.Type | undefined;

  const read = Effect.fn("ProjectGroups.read")(function* () {
    if (cached) return cached;
    if (!(yield* fs.exists(filePath).pipe(Effect.mapError(storageError)))) {
      cached = { snapshot: emptyProjectGroups, receipts: [] };
      return cached;
    }
    const raw = yield* fs.readFileString(filePath).pipe(Effect.mapError(storageError));
    const version = yield* decodeVersion(raw).pipe(Effect.mapError(storageError));
    if (version.snapshot.version !== 1)
      return yield* new ProjectGroupsError({ reason: "unsupported-version" });
    const document = yield* decodeDocument(raw).pipe(Effect.mapError(storageError));
    yield* Effect.try({ try: () => validateProjectGroups(document.snapshot), catch: storageError });
    cached = document;
    return document;
  });
  const save = Effect.fn("ProjectGroups.save")(function* (document: typeof Document.Type) {
    const contents = yield* encodeDocument(document).pipe(Effect.mapError(storageError));
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storageError),
    );
    cached = document;
    yield* PubSub.publish(pubsub, document.snapshot);
  }, Effect.uninterruptible);
  const snapshot = semaphore.withPermits(1)(
    read().pipe(Effect.map((document) => document.snapshot)),
  );
  const mutate = Effect.fn("ProjectGroups.mutate")(
    function* (input: ProjectGroupsMutation) {
      const document = yield* read();
      const request = yield* encodeMutation(input).pipe(Effect.mapError(storageError));
      const receipt = document.receipts.find((entry) => entry.id === input.mutationId);
      if (receipt) {
        if (receipt.request !== request)
          return yield* new ProjectGroupsError({ reason: "conflict" });
        return document.snapshot;
      }
      if (document.snapshot.revision !== input.expectedRevision)
        return yield* new ProjectGroupsError({ reason: "conflict" });
      const command = input.command;
      if (command.type === "assignProjects" && command.groupId !== null) {
        for (const projectId of command.projectIds) {
          const project = yield* projectStore.get(projectId).pipe(Effect.mapError(storageError));
          if (Option.isNone(project) || (yield* managedFolders.isScratchProject(projectId)))
            return yield* new ProjectGroupsError({ reason: "missing-reference" });
        }
      }
      if (command.type === "assignThread" && command.groupId !== null) {
        const thread = yield* projectionStore
          .getThreadShell(command.threadId)
          .pipe(Effect.mapError(storageError));
        if (!thread || !(yield* managedFolders.isScratchProject(thread.projectId)))
          return yield* new ProjectGroupsError({ reason: "missing-reference" });
      }
      const next = yield* Effect.try({
        try: () => applyProjectGroupsCommand(document.snapshot, command),
        catch: (cause) => (isGroupsError(cause) ? cause : storageError()),
      });
      const saved = {
        ...document,
        snapshot: next,
        pendingLaunches: (document.pendingLaunches ?? []).filter((launch) =>
          next.threads.some((thread) => thread.threadId === launch.threadId && thread.pending),
        ),
        receipts: [...document.receipts, { id: input.mutationId, request }].slice(-256),
      };
      yield* save(saved);
      return next;
    },
    semaphore.withPermits(1),
    Effect.uninterruptible,
  );
  const prepareCoordination = Effect.fn("ProjectGroups.prepareCoordination")(
    function* (input: ProjectGroupsCoordinateInput) {
      const document = yield* read();
      const existing = document.snapshot.threads.find((entry) => entry.threadId === input.threadId);
      const pending = document.pendingLaunches?.find((entry) => entry.threadId === input.threadId);
      if (existing && !existing.pending) return null;
      if (existing && pending) return pending;
      if (input.type === "resume")
        return yield* new ProjectGroupsError({ reason: "missing-reference" });
      if (document.snapshot.revision !== input.expectedRevision)
        return yield* new ProjectGroupsError({ reason: "conflict" });
      const group = document.snapshot.groups.find((entry) => entry.id === input.groupId);
      if (!group) return yield* new ProjectGroupsError({ reason: "invalid" });
      if (yield* projectionStore.getThreadShell(input.threadId).pipe(Effect.mapError(storageError)))
        return yield* new ProjectGroupsError({ reason: "invalid" });
      const scratch = yield* managedFolders.ensureScratchProject.pipe(
        Effect.mapError(() => new ProjectGroupsError({ reason: "thread-setup" })),
      );
      const launch: OrchestrationV2ThreadLaunchInput = {
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: scratch.projectId,
        title: `${group.name} coordination`,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      };
      yield* save({
        ...document,
        snapshot: {
          ...document.snapshot,
          revision: document.snapshot.revision + 1,
          threads: [
            ...document.snapshot.threads,
            { threadId: input.threadId, groupId: input.groupId, pending: true },
          ],
        },
        pendingLaunches: [...(document.pendingLaunches ?? []), launch],
      });
      return launch;
    },
    semaphore.withPermits(1),
    Effect.uninterruptible,
  );
  const coordinate = Effect.fn("ProjectGroups.coordinate")(function* (
    input: ProjectGroupsCoordinateInput,
  ) {
    const launch = yield* prepareCoordination(input);
    if (launch) {
      yield* launcher
        .launch({
          commandId: launch.commandId,
          threadId: input.threadId,
          projectId: launch.projectId,
          title: launch.title,
          modelSelection: launch.modelSelection,
          runtimeMode: launch.runtimeMode,
          interactionMode: launch.interactionMode,
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(() => new ProjectGroupsError({ reason: "thread-setup" })));
      yield* semaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const document = yield* read();
            const bound = document.snapshot.threads.some(
              (entry) => entry.threadId === input.threadId && entry.pending,
            );
            yield* save({
              ...document,
              snapshot: {
                ...document.snapshot,
                revision: document.snapshot.revision + 1,
                threads: document.snapshot.threads.map((entry) =>
                  entry.threadId === input.threadId ? { ...entry, pending: false } : entry,
                ),
              },
              pendingLaunches: (document.pendingLaunches ?? []).filter(
                (entry) => entry.threadId !== input.threadId,
              ),
            });
            if (!bound) return yield* new ProjectGroupsError({ reason: "missing-reference" });
          }),
        )
        .pipe(Effect.uninterruptible);
    }
    return { threadId: input.threadId };
  }, launches.withPermits(1));
  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(pubsub);
      const initial = yield* snapshot;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(queue)).pipe(
        Stream.filter((state) => state.revision >= initial.revision),
      );
    }),
  );
  return ProjectGroups.of({ snapshot, mutate, changes, coordinate });
});

export const layer = Layer.effect(ProjectGroups, make);
