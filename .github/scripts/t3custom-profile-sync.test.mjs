import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { layout, transfer, recover, assertClosed } from "../../scripts/t3custom/sync-profiles.mjs";
import { checkAppCompatibility } from "../../scripts/t3custom/sync-profiles.mjs";
import * as NodeURL from "node:url";

function database(file, label, head = 79) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO effect_sql_migrations VALUES(79,'DelegatedRecoveryIndexes');
      CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_runs(status TEXT);
      INSERT INTO orchestration_v2_projection_runs VALUES('completed');
      CREATE TABLE scheduled_tasks(enabled INTEGER);
      INSERT INTO scheduled_tasks VALUES(0);
      CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
      INSERT INTO orchestration_v2_effect_outbox VALUES('succeeded');
      CREATE TABLE orchestration_v2_thread_launch_workflows(status TEXT);
      CREATE TABLE auth_sessions(id TEXT PRIMARY KEY, token TEXT);
      CREATE TABLE peer_environment_links(id TEXT PRIMARY KEY, token TEXT);
      CREATE TABLE payloads(id INTEGER PRIMARY KEY, bytes BLOB, big INTEGER);
      INSERT INTO payloads VALUES(1, X'001122', 9223372036854775807);
    `);
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,NULL)").run(label);
    db.prepare("INSERT INTO auth_sessions VALUES(?,?)").run(label, `${label}-session`);
    db.prepare("INSERT INTO peer_environment_links VALUES(?,?)").run(label, `${label}-peer`);
    if (head === 80)
      db.exec("INSERT INTO effect_sql_migrations VALUES(80,'ScheduledTaskThreadMode')");
  } finally {
    db.close();
  }
}

function fixture(t, head = 79) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-profile-sync-"));
  t.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  const paths = layout(home);
  for (const key of ["official", "custom"]) {
    const root = paths[key];
    NodeFS.mkdirSync(NodePath.join(root, "attachments"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(root, "secrets"));
    NodeFS.writeFileSync(NodePath.join(root, "attachments", "image.png"), `${key}-image`);
    NodeFS.writeFileSync(NodePath.join(root, "settings.json"), JSON.stringify({ label: key }));
    NodeFS.writeFileSync(NodePath.join(root, "environment-id"), `${key}-id`);
    NodeFS.writeFileSync(NodePath.join(root, "connection-catalog.json"), `${key}-pairing`);
    NodeFS.writeFileSync(
      NodePath.join(root, "secrets", "server-signing-key.bin"),
      `${key}-signing`,
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "secrets", "provider-config-test.bin"),
      `${key}-provider`,
    );
    database(NodePath.join(root, "statev2.sqlite"), key, head);
  }
  NodeFS.mkdirSync(NodePath.join(paths.custom, "t3custom"));
  NodeFS.writeFileSync(
    NodePath.join(paths.custom, "t3custom", "sidebar-groups.v1.json"),
    JSON.stringify({ snapshot: { version: 1, threads: [], groups: [{ id: "keep" }] } }),
  );
  const hooks = {
    assertClosed,
    checkCompatibility: (_source, _target, info) => {
      if (info.head !== head) throw new Error("Incompatible fixture build");
    },
  };
  const run = (direction = "to-custom", flags = {}, overrides = {}) =>
    transfer(paths, { direction, apply: true, ...flags }, { ...hooks, ...overrides });
  return { paths, hooks, run };
}

function sql(root, statement) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "statev2.sqlite"));
  try {
    return db.prepare(statement).all();
  } finally {
    db.close();
  }
}

function snapshot(root) {
  return Object.fromEntries(
    NodeFS.readdirSync(root, { recursive: true })
      .sort()
      .flatMap((name) => {
        const file = NodePath.join(root, name);
        return NodeFS.lstatSync(file).isFile()
          ? [[name, NodeFS.readFileSync(file).toString("hex")]]
          : [];
      }),
  );
}

for (const head of [79, 80])
  NodeTest.test(
    `round trip at migration ${head} preserves history, groups, app identities and credentials`,
    (t) => {
      const { paths, run } = fixture(t, head);
      const original = snapshot(paths.official);
      const first = run("to-custom", { initialize: true });
      NodeAssert.deepEqual(snapshot(paths.official), original);
      NodeAssert.equal(
        sql(paths.custom, "SELECT thread_id FROM orchestration_v2_projection_threads")[0].thread_id,
        "official",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(paths.custom, "environment-id"), "utf8"),
        "custom-id",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(paths.custom, "secrets/server-signing-key.bin"), "utf8"),
        "custom-signing",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(
          NodePath.join(paths.custom, "secrets/provider-config-test.bin"),
          "utf8",
        ),
        "official-provider",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(paths.custom, "connection-catalog.json"), "utf8"),
        "custom-pairing",
      );
      NodeAssert.equal(
        sql(paths.custom, "SELECT token FROM auth_sessions")[0].token,
        "custom-session",
      );
      NodeAssert.equal(
        sql(paths.custom, "SELECT token FROM peer_environment_links")[0].token,
        "custom-peer",
      );
      sql(
        paths.custom,
        "INSERT INTO orchestration_v2_projection_threads VALUES('custom-work',NULL)",
      );
      NodeFS.writeFileSync(NodePath.join(paths.custom, "attachments/new.png"), "new-attachment");
      run("to-official");
      NodeAssert.equal(
        sql(paths.official, "SELECT count(*) AS n FROM orchestration_v2_projection_threads")[0].n,
        2,
      );
      NodeAssert.equal(
        sql(paths.official, "SELECT token FROM auth_sessions")[0].token,
        "official-session",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(paths.official, "attachments/new.png"), "utf8"),
        "new-attachment",
      );
      NodeAssert.ok(!NodeFS.existsSync(NodePath.join(paths.official, "t3custom")));
      sql(
        paths.official,
        "INSERT INTO orchestration_v2_projection_threads VALUES('back-in-official',NULL)",
      );
      run();
      NodeAssert.equal(
        sql(paths.custom, "SELECT count(*) AS n FROM orchestration_v2_projection_threads")[0].n,
        3,
      );
      NodeAssert.equal(
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(paths.custom, "t3custom/sidebar-groups.v1.json")),
        ).snapshot.groups[0].id,
        "keep",
      );
      NodeAssert.deepEqual(snapshot(NodePath.join(first.backup, "official")), original);
    },
  );

NodeTest.test(
  "checks, initialization and conflicting targets never overwrite either profile",
  (t) => {
    const { paths, run } = fixture(t);
    const original = snapshot(paths.official);
    const custom = snapshot(paths.custom);
    NodeAssert.throws(() => run(), /Prvni prenos/);
    run("to-custom", { initialize: true, apply: false });
    NodeAssert.deepEqual(snapshot(paths.official), original);
    NodeAssert.deepEqual(snapshot(paths.custom), custom);
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(paths.sync, "state.json")));
    run("to-custom", { initialize: true });
    NodeAssert.throws(() => run("to-custom", { initialize: true }), /nelze pouzit znovu/);
    sql(paths.custom, "INSERT INTO orchestration_v2_projection_threads VALUES('keep-me',NULL)");
    const modified = snapshot(paths.custom);
    NodeAssert.throws(() => run(), /Cilova aplikace ma zmeny/);
    NodeAssert.deepEqual(snapshot(paths.custom), modified);
    run("to-official");
    sql(
      paths.custom,
      "INSERT INTO orchestration_v2_projection_threads VALUES('custom-branch',NULL)",
    );
    sql(
      paths.official,
      "INSERT INTO orchestration_v2_projection_threads VALUES('official-branch',NULL)",
    );
    NodeAssert.throws(() => run(), /Cilova aplikace ma zmeny/);
    NodeAssert.throws(() => run("to-official"), /Cilova aplikace ma zmeny/);
  },
);

for (const phase of ["saved", "installed"])
  NodeTest.test(`rollback after failure at ${phase}`, (t) => {
    const { paths, run } = fixture(t);
    const original = snapshot(paths.official);
    const custom = snapshot(paths.custom);
    NodeAssert.throws(
      () =>
        run(
          "to-custom",
          { initialize: true },
          {
            afterRename: (current) => {
              if (current === phase) throw new Error("Injected failure");
            },
          },
        ),
      /Injected failure/,
    );
    NodeAssert.deepEqual(snapshot(paths.official), original);
    NodeAssert.deepEqual(snapshot(paths.custom), custom);
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(paths.sync, "transaction.json")));
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(paths.sync, "state.json")));
  });

NodeTest.test("last transfer can be restored without silently discarding subsequent work", (t) => {
  const { paths, run, hooks } = fixture(t);
  const custom = snapshot(paths.custom);
  const result = run("to-custom", { initialize: true });
  recover(paths, hooks, result.backup);
  NodeAssert.deepEqual(snapshot(paths.custom), custom);
  const next = run("to-custom", { initialize: true });
  sql(paths.custom, "INSERT INTO orchestration_v2_projection_threads VALUES('new-work',NULL)");
  NodeAssert.throws(() => recover(paths, hooks, next.backup), /prepsala novou praci/);
  NodeAssert.equal(
    sql(paths.custom, "SELECT count(*) AS n FROM orchestration_v2_projection_threads")[0].n,
    2,
  );
});

NodeTest.test("WAL-only committed history is transferred without changing the source", (t) => {
  const { paths, run } = fixture(t);
  const writer = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as NodeSqlite from 'node:sqlite';
    const db = new NodeSqlite.DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO orchestration_v2_projection_threads VALUES('wal-only',NULL)");
    process.reallyExit(0);
  `,
      NodePath.join(paths.official, "statev2.sqlite"),
    ],
    { encoding: "utf8" },
  );
  NodeAssert.equal(writer.status, 0, writer.stderr);
  NodeAssert.ok(NodeFS.statSync(NodePath.join(paths.official, "statev2.sqlite-wal")).size > 0);
  const before = snapshot(paths.official);
  run("to-custom", { initialize: true });
  NodeAssert.deepEqual(snapshot(paths.official), before);
  NodeAssert.equal(
    sql(paths.custom, "SELECT count(*) AS n FROM orchestration_v2_projection_threads")[0].n,
    2,
  );
});

for (const [label, mutation, error] of [
  ["unknown migration", "INSERT INTO effect_sql_migrations VALUES(81,'Future')", /Neznamy format/],
  [
    "active run",
    "UPDATE orchestration_v2_projection_runs SET status='running'",
    /zastav vsechny behy/,
  ],
  ["enabled schedule", "UPDATE scheduled_tasks SET enabled=1", /pozastav planovane/],
  [
    "pending effect",
    "UPDATE orchestration_v2_effect_outbox SET status='pending'",
    /nedokoncene operace/,
  ],
  [
    "pending launch",
    "INSERT INTO orchestration_v2_thread_launch_workflows VALUES('pending')",
    /nedokoncene zalozeni/,
  ],
])
  NodeTest.test(`refuses ${label} on either side`, (t) => {
    for (const key of ["official", "custom"]) {
      const { paths, run } = fixture(t);
      sql(paths[key], mutation);
      const original = snapshot(paths.official);
      const custom = snapshot(paths.custom);
      NodeAssert.throws(() => run("to-custom", { initialize: true }), error);
      NodeAssert.deepEqual(snapshot(paths.official), original);
      NodeAssert.deepEqual(snapshot(paths.custom), custom);
    }
  });

NodeTest.test("refuses incompatible installed binaries and changes during staging", (t) => {
  const { paths, run } = fixture(t);
  const custom = snapshot(paths.custom);
  NodeAssert.throws(
    () =>
      run(
        "to-custom",
        { initialize: true },
        {
          checkCompatibility: () => {
            throw new Error("Incompatible build");
          },
        },
      ),
    /Incompatible build/,
  );
  NodeAssert.deepEqual(snapshot(paths.custom), custom);
  NodeAssert.throws(
    () =>
      run(
        "to-custom",
        { initialize: true },
        {
          checkCompatibility: () => {
            NodeFS.writeFileSync(NodePath.join(paths.official, "settings.json"), "changed");
          },
        },
      ),
    /Profily se behem pripravy zmenily/,
  );
  NodeAssert.deepEqual(snapshot(paths.custom), custom);
});

NodeTest.test("local auth changes do not count as diverging history", (t) => {
  const { paths, run } = fixture(t);
  run("to-custom", { initialize: true });
  sql(paths.official, "UPDATE auth_sessions SET token='refreshed'");
  NodeFS.writeFileSync(NodePath.join(paths.official, "secrets/server-signing-key.bin"), "rotated");
  run("to-official");
  NodeAssert.equal(sql(paths.official, "SELECT token FROM auth_sessions")[0].token, "refreshed");
});

NodeTest.test("refuses open database handles and symlinks", (t) => {
  const { paths, run } = fixture(t);
  const fd = NodeFS.openSync(NodePath.join(paths.official, "statev2.sqlite"), "r");
  try {
    NodeAssert.throws(() => run("to-custom", { initialize: true }), /jeste pouziva data/);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.symlinkSync(
    NodePath.join(paths.official, "settings.json"),
    NodePath.join(paths.custom, "symlink"),
  );
  NodeAssert.throws(() => run("to-custom", { initialize: true }), /Symlink v datech/);
});

for (const phase of ["saved", "installed"]) {
  NodeTest.test(`recovers after abrupt process exit at ${phase}`, (t) => {
    const { paths, hooks } = fixture(t);
    const original = snapshot(paths.official);
    const custom = snapshot(paths.custom);
    const moduleUrl = new URL("../../scripts/t3custom/sync-profiles.mjs", import.meta.url).href;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { layout, transfer } from ${JSON.stringify(moduleUrl)};
      transfer(layout(process.argv[1]), {direction:'to-custom', initialize:true, apply:true}, {
        assertClosed() {}, checkCompatibility() {},
        afterRename(phase) { if (phase === process.argv[2]) process.reallyExit(42); }
      });
    `,
        paths.home,
        phase,
      ],
      { encoding: "utf8" },
    );
    NodeAssert.equal(result.status, 42, result.stderr);
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(paths.sync, "transaction.json")));
    recover(paths, hooks);
    NodeAssert.deepEqual(snapshot(paths.official), original);
    NodeAssert.deepEqual(snapshot(paths.custom), custom);
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(paths.sync, "state.json")));
  });
}

NodeTest.test("installed binary probes reject incompatible and unknown formats", (t) => {
  const { paths } = fixture(t);
  const wrapped = (head) => {
    const entry = NodePath.join(paths.home, `preflight-${head}.mjs`);
    NodeFS.writeFileSync(
      entry,
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[4], {readOnly:true});
    const head = db.prepare('SELECT max(migration_id) AS n FROM effect_sql_migrations').get().n;
    db.close();
    const build = ${head};
    console.log(JSON.stringify(head > build ? {status:'blocked',reason:'newer migration'} : {status:'ready',launcherProtocol:3}));
  `,
    );
    return { executable: process.execPath, entry, version: "probe-build" };
  };
  for (const name of ["probe-a", "probe-b", "probe-c"])
    NodeFS.mkdirSync(NodePath.join(paths.home, name));
  NodeAssert.doesNotThrow(() =>
    checkAppCompatibility(
      { official: wrapped(80), custom: wrapped(80) },
      paths.official,
      "custom",
      { head: 79 },
      NodePath.join(paths.home, "probe-a"),
    ),
  );
  NodeAssert.throws(
    () =>
      checkAppCompatibility(
        { official: wrapped(79), custom: wrapped(80) },
        paths.official,
        "custom",
        { head: 79 },
        NodePath.join(paths.home, "probe-b"),
      ),
    /neumoznuji prenos tam i zpet/,
  );
  NodeAssert.throws(
    () =>
      checkAppCompatibility(
        { official: wrapped(81), custom: wrapped(81) },
        paths.official,
        "custom",
        { head: 79 },
        NodePath.join(paths.home, "probe-c"),
      ),
    /novejsi databazovy format/,
  );
});

NodeTest.test(
  "round trip works with the actual application schema, including search indexes",
  (t) => {
    const { paths, run } = fixture(t, 80);
    const setup = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import * as Effect from 'effect/Effect';
    import * as Sqlite from '@t3tools/shared/nodeSqliteClient';
    import * as fs from 'node:fs';
    import { runMigrations } from './src/persistence/Migrations.ts';
    for (const filename of process.argv.slice(1)) {
      fs.unlinkSync(filename);
      await Effect.runPromise(runMigrations().pipe(Effect.provide(Sqlite.layer({filename}))));
    }
  `,
        NodePath.join(paths.official, "statev2.sqlite"),
        NodePath.join(paths.custom, "statev2.sqlite"),
      ],
      {
        cwd: NodeURL.fileURLToPath(new URL("../../apps/server", import.meta.url)),
        encoding: "utf8",
      },
    );
    NodeAssert.equal(setup.status, 0, setup.stderr);
    sql(
      paths.official,
      `INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES('real-history','project','Test','codex','full-access','default','2026-11-06','2026-11-06','{}')`,
    );
    run("to-custom", { initialize: true });
    run("to-official");
    NodeAssert.equal(
      sql(paths.official, "SELECT title FROM orchestration_v2_projection_threads")[0].title,
      "Test",
    );
  },
);
