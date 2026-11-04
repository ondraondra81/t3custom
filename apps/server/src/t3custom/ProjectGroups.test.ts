import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, ProviderInstanceId, ProjectId } from "@t3tools/contracts";
import { type ProjectGroupsMutation } from "@t3tools/contracts/t3custom/projectGroups";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectGroups from "./ProjectGroups.ts";

const layerService = ProjectGroups.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/test",
        isScratchProject: () => Effect.succeed(false),
      }),
    ),
  ),
);
const create = (
  id: string,
  revision: number,
  parentId: string | null = null,
): ProjectGroupsMutation => ({
  expectedRevision: revision,
  mutationId: `create-${id}`,
  command: { type: "create", group: { id, name: id, parentId } },
});
const setup = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3custom-groups-" }));

it.layer(NodeServices.layer)("project groups", (it) => {
  it.effect(
    "persists atomic receipts, rejects stale edits and retries without undoing newer changes",
    () =>
      Effect.gen(function* () {
        const service = yield* ProjectGroups.ProjectGroups;
        const first = create("Minion", 0);
        yield* service.mutate(first);
        yield* service.mutate(create("Nelson", 1, "Minion"));
        assert.equal((yield* service.mutate(first)).revision, 2);
        const stale = yield* service.mutate(create("Clients", 0)).pipe(Effect.flip);
        assert.equal(stale.reason, "conflict");
        const changedRetry = yield* service
          .mutate({ ...first, command: { type: "remove", groupId: "Minion" } })
          .pipe(Effect.flip);
        assert.equal(changedRetry.reason, "conflict");
        const restarted = yield* Effect.gen(function* () {
          const fresh = yield* ProjectGroups.ProjectGroups;
          return yield* fresh.mutate(first);
        }).pipe(Effect.provide(Layer.fresh(layerService)));
        assert.equal(restarted.revision, 2);
        assert.deepEqual(
          restarted.groups.map((group) => group.id),
          ["Minion", "Nelson"],
        );
      }).pipe(Effect.provide(layerService.pipe(Layer.provideMerge(setup())))),
  );

  it.effect("rejects cycles and foreign references; removing a group preserves its children", () =>
    Effect.gen(function* () {
      const service = yield* ProjectGroups.ProjectGroups;
      yield* service.mutate(create("Minion", 0));
      yield* service.mutate(create("Nelson", 1, "Minion"));
      const cycle = yield* service
        .mutate({
          expectedRevision: 2,
          mutationId: "cycle",
          command: { type: "move", groupId: "Minion", parentId: "Nelson", beforeId: null },
        })
        .pipe(Effect.flip);
      assert.equal(cycle.reason, "invalid");
      const missing = yield* service
        .mutate({
          expectedRevision: 2,
          mutationId: "missing",
          command: {
            type: "assignProjects",
            projectIds: [ProjectId.make("foreign")],
            groupId: "Nelson",
          },
        })
        .pipe(Effect.flip);
      assert.equal(missing.reason, "missing-reference");
      const removed = yield* service.mutate({
        expectedRevision: 2,
        mutationId: "remove",
        command: { type: "remove", groupId: "Minion" },
      });
      assert.deepEqual(removed.groups, [{ id: "Nelson", name: "Nelson", parentId: null }]);
    }).pipe(Effect.provide(layerService.pipe(Layer.provideMerge(setup())))),
  );

  it.effect("serializes concurrent writers so only one edit to a revision commits", () =>
    Effect.gen(function* () {
      const service = yield* ProjectGroups.ProjectGroups;
      const results = yield* Effect.all(
        [
          service.mutate(create("a", 0)).pipe(Effect.result),
          service.mutate(create("b", 0)).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal((yield* service.snapshot).revision, 1);
    }).pipe(Effect.provide(layerService.pipe(Layer.provideMerge(setup())))),
  );

  it.effect("subscribes before its snapshot and observes the next persisted edit", () =>
    Effect.gen(function* () {
      const service = yield* ProjectGroups.ProjectGroups;
      const seen: number[] = [];
      const fiber = yield* service.changes.pipe(
        Stream.tap((snapshot) =>
          Effect.gen(function* () {
            seen.push(snapshot.revision);
            if (snapshot.revision === 0) yield* service.mutate(create("a", 0));
          }),
        ),
        Stream.take(2),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Fiber.join(fiber);
      assert.deepEqual(seen, [0, 1]);
    }).pipe(Effect.provide(layerService.pipe(Layer.provideMerge(setup())))),
  );

  it.effect(
    "keeps a failed coordination launch durable and resumes with the same IDs after restart",
    () =>
      Effect.gen(function* () {
        const attempted: ThreadLaunchService.ThreadLaunchInput[] = [];
        const scratchId = ProjectId.make("scratch");
        const testLayer = ProjectGroups.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () => Effect.succeed(null),
              }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/test",
                ensureScratchProject: Effect.succeed({ projectId: scratchId }),
                isScratchProject: () => Effect.succeed(true),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) => {
                  attempted.push(input);
                  return Effect.fail(
                    new ThreadLaunchService.ThreadLaunchError({
                      operation: "create-thread",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: new Error("simulated interruption"),
                    }),
                  );
                },
              }),
            ),
          ),
        );
        const threadId = ThreadId.make("coordination");
        const commandId = CommandId.make("launch-coordination");
        yield* Effect.gen(function* () {
          const service = yield* ProjectGroups.ProjectGroups;
          yield* service.mutate(create("Minion", 0));
          const failure = yield* service
            .coordinate({
              type: "start",
              groupId: "Minion",
              expectedRevision: 1,
              threadId,
              commandId,
              modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "test" },
              runtimeMode: "full-access",
            })
            .pipe(Effect.flip);
          assert.equal(failure.reason, "thread-setup");
          assert.deepEqual((yield* service.snapshot).threads, [
            { threadId, groupId: "Minion", pending: true },
          ]);
        }).pipe(Effect.provide(Layer.fresh(testLayer)));
        yield* Effect.gen(function* () {
          const service = yield* ProjectGroups.ProjectGroups;
          yield* service.coordinate({ type: "resume", threadId }).pipe(Effect.flip);
          assert.equal((yield* service.snapshot).threads.length, 1);
          yield* service.mutate({
            expectedRevision: 2,
            mutationId: "remove-pending",
            command: { type: "remove", groupId: "Minion" },
          });
          assert.equal(
            (yield* service.coordinate({ type: "resume", threadId }).pipe(Effect.flip)).reason,
            "missing-reference",
          );
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const raw = yield* fs.readFileString(
            path.join(config.stateDir, "t3custom", "sidebar-groups.v1.json"),
          );
          assert.deepEqual(JSON.parse(raw).pendingLaunches, []);
        }).pipe(Effect.provide(Layer.fresh(testLayer)));
        assert.equal(attempted.length, 2);
        assert.deepEqual(attempted[0], attempted[1]);
        assert.equal(attempted[1]?.threadId, threadId);
        assert.equal(attempted[1]?.commandId, commandId);
        assert.equal(attempted[1]?.initialMessage, undefined);
        assert.notEqual(attempted[0]?.reuseExistingThread, true);
      }).pipe(Effect.provide(setup())),
  );

  it.effect("preserves unknown newer documents", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(config.stateDir, "t3custom", "sidebar-groups.v1.json");
      const raw = '{"snapshot":{"version":2,"newField":"preserve"}}';
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, raw);
      const service = yield* ProjectGroups.ProjectGroups;
      assert.equal(
        (yield* service.mutate(create("a", 0)).pipe(Effect.flip)).reason,
        "unsupported-version",
      );
      assert.equal(yield* fs.readFileString(file), raw);
    }).pipe(Effect.provide(layerService.pipe(Layer.provideMerge(setup())))),
  );
});
