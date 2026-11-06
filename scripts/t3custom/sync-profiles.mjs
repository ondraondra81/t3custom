import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const SHARED = [
  "statev2.sqlite",
  "statev2.sqlite-wal",
  "state.sqlite",
  "state.sqlite-wal",
  "settings.json",
  "client-settings.json",
  "keybindings.json",
  "attachments",
  "browser-artifacts",
  "themes",
];
const SECRET =
  /^(provider-config-|provider-env-|source-control-|usage-limit-source-|device-host-|simlock-device-host-).+\.bin$/;
const localTable = (name) => name.startsWith("auth_") || name === "peer_environment_links";
const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
const exists = (name) => NodeFS.existsSync(name);
const fail = (message) => {
  throw new Error(message);
};
const readJson = (name) => JSON.parse(NodeFS.readFileSync(name, "utf8"));

function atomicJson(name, value) {
  const temporary = `${name}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(temporary, name);
}

function safePath(name) {
  for (
    let current = name;
    current !== NodePath.dirname(current);
    current = NodePath.dirname(current)
  ) {
    if (NodeFS.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      fail(`Datova cesta je symlink: ${current}`);
  }
}

function filesUnder(root, allowSymlinks = false) {
  const stat = NodeFS.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    if (allowSymlinks) return [root];
    fail(`Symlink v datech neni podporovany: ${root}`);
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) fail(`Nepodporovany typ souboru: ${root}`);
  return NodeFS.readdirSync(root)
    .sort()
    .flatMap((name) => filesUnder(NodePath.join(root, name), allowSymlinks));
}

function treeHash(root) {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of filesUnder(root, true)) {
    const relative = NodePath.relative(root, file);
    if (NodeFS.lstatSync(file).isSymbolicLink()) {
      hash.update(JSON.stringify([relative, "symlink", NodeFS.readlinkSync(file)]));
      continue;
    }
    hash.update(JSON.stringify([relative, "file"]));
    const fd = NodeFS.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let count;
      while ((count = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  return hash.digest("hex");
}

function copy(source, target) {
  if (!NodeFS.lstatSync(source, { throwIfNoEntry: false })) return;
  filesUnder(source, true);
  NodeFS.cpSync(source, target, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
}

function withDb(file, action, readOnly = true) {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function tables(db) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
}

function sharedPaths(root) {
  const names = [...SHARED];
  const secrets = NodePath.join(root, "secrets");
  const stat = NodeFS.lstatSync(secrets, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) fail(`Symlink v datech neni podporovany: ${secrets}`);
  if (stat) {
    names.push(
      ...NodeFS.readdirSync(NodePath.join(root, "secrets"))
        .filter((name) => SECRET.test(name))
        .map((name) => `secrets/${name}`),
    );
  }
  return names;
}

function sharedHash(root) {
  const hash = NodeCrypto.createHash("sha256");
  const names = sharedPaths(root).filter((name) => !name.endsWith("-wal"));
  for (const name of names.sort()) {
    const file = NodePath.join(root, name);
    if (!exists(file)) continue;
    hash.update(JSON.stringify(name));
    if (!name.endsWith(".sqlite")) {
      hash.update(treeHash(file));
      continue;
    }
    withDb(file, (db) => {
      for (const table of tables(db)) {
        if (localTable(table.name) || table.name.startsWith("sqlite_")) continue;
        hash.update(JSON.stringify([table.name, table.sql]));
        const columns = db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all();
        const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
        const order = primary.length
          ? primary.map((column) => quoted(column.name)).join(",")
          : columns.map((column) => quoted(column.name)).join(",");
        const statement = db.prepare(`SELECT * FROM ${quoted(table.name)} ORDER BY ${order}`);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) {
          hash.update(
            JSON.stringify(row, (_key, value) =>
              typeof value === "bigint" ? { integer: value.toString() } : value,
            ),
          );
        }
      }
    });
  }
  return hash.digest("hex");
}

function validateDatabase(root) {
  const file = NodePath.join(root, "statev2.sqlite");
  if (!exists(file))
    fail("Chybi statev2.sqlite. Otevri obe aplikace alespon jednou a pak je ukonci.");
  return withDb(file, (db) => {
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
      fail("Databaze neprosla kontrolou integrity.");
    const migrations = db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    const head = migrations.at(-1);
    if (
      !head ||
      !(
        (head.migration_id === 79 && head.name === "DelegatedRecoveryIndexes") ||
        (head.migration_id === 80 && head.name === "ScheduledTaskThreadMode")
      )
    ) {
      fail("Neznamy format databaze. Je potreba aktualizovat nastroj; nic nebude prepsano.");
    }
    const count = (table, condition) =>
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${condition}`).get().n;
    if (
      count(
        "orchestration_v2_projection_runs",
        "status NOT IN ('completed','interrupted','failed','cancelled','rolled_back')",
      ) > 0
    )
      fail("Nejprve dokonci nebo zastav vsechny behy agentu.");
    if (count("scheduled_tasks", "enabled <> 0") > 0)
      fail("Pred prenosem pozastav planovane ulohy v obou aplikacich.");
    if (count("orchestration_v2_effect_outbox", "status IN ('pending','running')") > 0)
      fail("Databaze obsahuje nedokoncene operace. Nejprve je nech dokoncit v puvodni aplikaci.");
    const workflows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='orchestration_v2_thread_launch_workflows'",
      )
      .get();
    if (
      workflows &&
      count(
        "orchestration_v2_thread_launch_workflows",
        "status NOT IN ('completed','failed','cancelled')",
      ) > 0
    )
      fail("Existuje nedokoncene zalozeni vlakna.");
    return {
      head: head.migration_id,
      threads: count("orchestration_v2_projection_threads", "deleted_at IS NULL"),
    };
  });
}

function preserveLocalTables(stage, target) {
  withDb(
    NodePath.join(stage, "statev2.sqlite"),
    (db) => {
      const original = new NodeSqlite.DatabaseSync(NodePath.join(target, "statev2.sqlite"), {
        readOnly: true,
      });
      try {
        db.exec("BEGIN");
        for (const table of tables(db).filter(({ name }) => localTable(name))) {
          const other = original
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
            .get(table.name);
          if (!other || other.sql !== table.sql)
            fail(`Nekompatibilni lokalni tabulka: ${table.name}`);
          db.exec(`DELETE FROM ${quoted(table.name)}`);
          const columns = original
            .prepare(`PRAGMA table_info(${quoted(table.name)})`)
            .all()
            .map(({ name }) => name);
          const insert = db.prepare(
            `INSERT INTO ${quoted(table.name)} (${columns.map(quoted).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          );
          const rows = original.prepare(`SELECT * FROM ${quoted(table.name)}`);
          rows.setReadBigInts(true);
          for (const row of rows.iterate()) insert.run(...columns.map((name) => row[name]));
        }
        db.exec("COMMIT");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        original.close();
      }
    },
    false,
  );
}

function stageShared(source, destination) {
  for (const name of ["statev2.sqlite-shm", "state.sqlite-shm"])
    NodeFS.rmSync(NodePath.join(destination, name), { force: true });
  for (const name of SHARED) {
    NodeFS.rmSync(NodePath.join(destination, name), { recursive: true, force: true });
    copy(NodePath.join(source, name), NodePath.join(destination, name));
  }
  const secrets = NodePath.join(destination, "secrets");
  if (exists(secrets))
    for (const name of NodeFS.readdirSync(secrets).filter((name) => SECRET.test(name)))
      NodeFS.rmSync(NodePath.join(secrets, name));
  if (exists(NodePath.join(source, "secrets"))) {
    for (const name of NodeFS.readdirSync(NodePath.join(source, "secrets")).filter((name) =>
      SECRET.test(name),
    )) {
      NodeFS.mkdirSync(secrets, { recursive: true, mode: 0o700 });
      copy(NodePath.join(source, "secrets", name), NodePath.join(secrets, name));
    }
  }
}

export function layout(home) {
  return {
    home,
    sync: NodePath.join(home, ".t3-profile-sync"),
    official: NodePath.join(home, ".t3", "userdata"),
    custom: NodePath.join(home, ".t3custom", "userdata"),
    officialProfile: NodePath.join(home, "Library", "Application Support", "t3code-v2"),
    customProfile: NodePath.join(home, "Library", "Application Support", "t3custom"),
  };
}

export function assertClosed(paths, runCommand = NodeChildProcess.spawnSync) {
  const candidates = [paths.official, paths.custom]
    .flatMap((root) =>
      ["statev2.sqlite", "statev2.sqlite-wal", "server-owner.sqlite"].map((name) =>
        NodePath.join(root, name),
      ),
    )
    .concat(
      [paths.officialProfile, paths.customProfile].map((root) =>
        NodePath.join(root, "Local Storage", "leveldb", "LOCK"),
      ),
    )
    .filter(exists);
  if (candidates.length) {
    const result = runCommand("lsof", ["-t", "--", ...candidates], {
      encoding: "utf8",
    });
    if (result.error || ![0, 1].includes(result.status))
      fail("Nelze overit, zda jsou aplikace zavrene (lsof).");
    if (result.stdout.trim())
      fail("T3 nebo jeho server jeste pouziva data. Ukonci obe aplikace pres Cmd+Q.");
  }
  const result = runCommand("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail("Nelze overit bezici aplikace.");
  if (
    result.stdout.split("\n").some((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return (
        match &&
        Number(match[1]) !== process.pid &&
        /\/T3 (?:Code[^/]*|Custom)\.app\/Contents\/MacOS\//.test(match[2])
      );
    })
  )
    fail("Ukonci obe aplikace pres Cmd+Q.");
}

function verifyGroups(root) {
  const file = NodePath.join(root, "t3custom", "sidebar-groups.v1.json");
  if (!exists(file)) return;
  const groups = readJson(file);
  if (
    (groups.pendingLaunches ?? []).length ||
    (groups.snapshot?.threads ?? []).some((thread) => thread.pending)
  )
    fail("Custom obsahuje nedokoncene koordinacni vlakno.");
}

export function transfer(paths, options, hooks) {
  for (const name of Object.values(paths)) safePath(name);
  NodeFS.mkdirSync(paths.sync, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(paths.sync, 0o700);
  const journal = NodePath.join(paths.sync, "transaction.json");
  const ledger = NodePath.join(paths.sync, "state.json");
  const lock = NodePath.join(paths.sync, "lock");
  try {
    NodeFS.mkdirSync(lock, { mode: 0o700 });
  } catch {
    fail("Jiny prenos bezi nebo byl prerusen. Neotvirej aplikace; pouzij --recover.");
  }
  NodeFS.writeFileSync(NodePath.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  let temporary;
  try {
    hooks.assertClosed(paths);
    if (exists(journal))
      fail("Predchozi prenos byl prerusen. Neotvirej aplikace; pouzij --recover.");
    const sourceKey = options.direction === "to-custom" ? "official" : "custom";
    const targetKey = sourceKey === "official" ? "custom" : "official";
    const target = paths[targetKey];
    const before = exists(ledger) ? readJson(ledger) : null;
    if (before && (before.version !== 1 || before.home !== paths.home))
      fail("Neplatny zaznam predchoziho prenosu.");
    if (!before && !options.initialize)
      fail("Prvni prenos vyzaduje --initialize: cilova historie bude po zaloze nahrazena zdrojem.");
    if (before && options.initialize)
      fail("Profily uz byly propojeny. --initialize nelze pouzit znovu.");
    const bytes = [paths.official, paths.custom].map((root) => {
      for (const name of sharedPaths(root)) filesUnder(NodePath.join(root, name));
      return filesUnder(root, true).reduce((total, name) => total + NodeFS.lstatSync(name).size, 0);
    });
    const disk = NodeFS.statfsSync(paths.sync);
    if (disk.bavail * disk.bsize < 2 * (bytes[0] + bytes[1]) + 64 * 1024 * 1024)
      fail("Nedostatek mista pro zalohy a pracovni kopii.");
    const backups = NodePath.join(paths.sync, "backups");
    NodeFS.mkdirSync(backups, { recursive: true, mode: 0o700 });
    temporary = NodeFS.mkdtempSync(NodePath.join(backups, options.apply ? "transfer-" : "check-"));
    const snapshots = {};
    const rawHashes = {};
    const fingerprints = {};
    for (const key of ["official", "custom"]) {
      snapshots[key] = NodePath.join(temporary, key);
      rawHashes[key] = treeHash(paths[key]);
      copy(paths[key], snapshots[key]);
      if (rawHashes[key] !== treeHash(snapshots[key]) || rawHashes[key] !== treeHash(paths[key]))
        fail("Data se behem vytvareni kopie zmenila.");
      validateDatabase(snapshots[key]);
      verifyGroups(snapshots[key]);
      fingerprints[key] = sharedHash(snapshots[key]);
    }
    if (before && fingerprints[targetKey] !== before.fingerprints[targetKey])
      fail(
        "Cilova aplikace ma zmeny od posledniho prenosu. Zvol opacny smer; pokud se zmenily oba profily, je potreba jejich samostatne slouceni.",
      );
    const info = validateDatabase(snapshots[sourceKey]);
    hooks.checkCompatibility(snapshots[sourceKey], targetKey, info, temporary);
    const stage = NodePath.join(temporary, "staging");
    copy(snapshots[targetKey], stage);
    NodeFS.chmodSync(stage, 0o700);
    stageShared(snapshots[sourceKey], stage);
    preserveLocalTables(stage, snapshots[targetKey]);
    validateDatabase(stage);
    if (sharedHash(stage) !== fingerprints[sourceKey]) fail("Pracovni kopie neodpovida zdroji.");
    if (!options.apply) return { checked: true, threads: info.threads };
    const record = {
      version: 1,
      home: paths.home,
      targetKey,
      backup: temporary,
      stageHash: treeHash(stage),
      originalHash: rawHashes[targetKey],
      before,
    };
    const installedHash = record.stageHash;
    hooks.assertClosed(paths);
    for (const key of ["official", "custom"])
      if (treeHash(paths[key]) !== rawHashes[key])
        fail("Profily se behem pripravy zmenily. Nic nebylo nahrazeno.");
    if (NodeFS.statSync(target).dev !== NodeFS.statSync(temporary).dev)
      fail("Zaloha a cil museji byt na stejnem disku.");
    atomicJson(NodePath.join(temporary, "transfer.json"), record);
    atomicJson(journal, record);
    try {
      NodeFS.renameSync(target, NodePath.join(temporary, "previous-userdata"));
      hooks.afterRename?.("saved");
      NodeFS.renameSync(stage, target);
      hooks.afterRename?.("installed");
      const next = {
        version: 1,
        home: paths.home,
        fingerprints: { ...fingerprints, [targetKey]: sharedHash(target) },
        lastTarget: targetKey,
        backup: temporary,
      };
      if (treeHash(target) !== installedHash) fail("Cilova data se po instalaci zmenila.");
      atomicJson(ledger, next);
      NodeFS.unlinkSync(journal);
    } catch (error) {
      recoverRecord(paths, record, hooks);
      throw error;
    }
    return { checked: false, threads: info.threads, backup: temporary, target: targetKey };
  } finally {
    if (!options.apply && temporary) NodeFS.rmSync(temporary, { recursive: true, force: true });
    NodeFS.rmSync(lock, { recursive: true, force: true });
  }
}

function recoverRecord(paths, record, hooks) {
  if (
    record.version !== 1 ||
    record.home !== paths.home ||
    !["official", "custom"].includes(record.targetKey) ||
    NodePath.dirname(record.backup) !== NodePath.join(paths.sync, "backups")
  )
    fail("Neplatny zaznam obnovy.");
  const target = paths[record.targetKey];
  const previous = NodePath.join(record.backup, "previous-userdata");
  hooks.assertClosed(paths);
  if (exists(previous)) {
    if (exists(target)) {
      if (treeHash(target) !== record.stageHash)
        fail(
          "Cil se po prenosu zmenil. Automaticka obnova by prepsala novou praci; zalohy zustaly zachovane.",
        );
      NodeFS.renameSync(target, NodePath.join(record.backup, `unused-${NodeCrypto.randomUUID()}`));
    }
    NodeFS.renameSync(previous, target);
  } else if (treeHash(target) !== record.originalHash)
    fail("Nelze automaticky rozpoznat stav preruseneho prenosu.");
  const ledger = NodePath.join(paths.sync, "state.json");
  if (record.before) atomicJson(ledger, record.before);
  else NodeFS.rmSync(ledger, { force: true });
  NodeFS.rmSync(NodePath.join(paths.sync, "transaction.json"), { force: true });
}

export function recover(paths, hooks, backup) {
  for (const name of Object.values(paths)) safePath(name);
  NodeFS.mkdirSync(paths.sync, { recursive: true, mode: 0o700 });
  const lock = NodePath.join(paths.sync, "lock");
  if (exists(lock)) {
    const pidFile = NodePath.join(lock, "pid");
    if (!exists(pidFile))
      fail("Zamek bez PID. Over, ze zadny prenos nebezi, a odstran pouze ~/.t3-profile-sync/lock.");
    const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("Neplatny zamek prenosu.");
    try {
      process.kill(pid, 0);
      fail("Jiny prenos stale bezi.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    NodeFS.rmSync(lock, { recursive: true });
  }
  NodeFS.mkdirSync(lock, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  try {
    const journal = NodePath.join(paths.sync, "transaction.json");
    if (!backup && !exists(journal)) {
      hooks.assertClosed(paths);
      return { recovered: false };
    }
    if (backup && exists(journal)) fail("Nejprve obnov preruseny prenos pomoci --recover.");
    if (backup) {
      const ledger = readJson(NodePath.join(paths.sync, "state.json"));
      if (ledger.backup !== backup)
        fail("Obnovit lze pouze posledni prenos. Starsi zalohy zustavaji pro rucni obnovu.");
    }
    const record = readJson(backup ? NodePath.join(backup, "transfer.json") : journal);
    recoverRecord(paths, record, hooks);
    return { recovered: true };
  } finally {
    NodeFS.rmSync(lock, { recursive: true, force: true });
  }
}

function appInfo(app) {
  const plist = NodePath.join(app, "Contents", "Info.plist");
  const field = (key) => {
    const result = NodeChildProcess.spawnSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plist],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0) fail(`Nelze precist instalaci: ${app}`);
    return result.stdout.trim();
  };
  return {
    id: field("CFBundleIdentifier"),
    version: field("CFBundleShortVersionString"),
    executable: NodePath.join(app, "Contents", "MacOS", field("CFBundleExecutable")),
    entry: NodePath.join(app, "Contents", "Resources", "app.asar", "apps/server/dist/bin.mjs"),
  };
}

function installedApps(home) {
  const result = {};
  for (const directory of ["/Applications", NodePath.join(home, "Applications")]) {
    if (!exists(directory)) continue;
    for (const name of NodeFS.readdirSync(directory).filter((name) => name.endsWith(".app"))) {
      const app = NodePath.join(directory, name);
      const plist = NodePath.join(app, "Contents", "Info.plist");
      if (!exists(plist)) continue;
      const id = NodeChildProcess.spawnSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleIdentifier", plist],
        {
          encoding: "utf8",
        },
      ).stdout.trim();
      const key =
        id === "dev.ondraondra81.t3custom"
          ? "custom"
          : id === "com.t3tools.t3code"
            ? "official"
            : null;
      if (!key) continue;
      if (result[key])
        fail(`Nalezeno vice instalaci ${key}. Ponech jednu instalaci v Applications.`);
      result[key] = appInfo(app);
    }
  }
  if (!result.official || !result.custom) fail("Nainstaluj a jednou otevri obe aplikace.");
  return result;
}

function preflight(app, file, temporary) {
  const result = NodeChildProcess.spawnSync(
    app.executable,
    [app.entry, "__service-preflight", "--database-path", file, "--launcher-protocol", "3"],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: NodePath.join(temporary, "preflight-home"),
      },
    },
  );
  const lines = (result.stdout ?? "").split("\n");
  for (const line of lines) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      continue;
    }
    if (result.status === 0 && response.status === "ready" && response.launcherProtocol === 3)
      return response;
    if (result.status === 0 && response.status === "blocked") return response;
  }
  fail("Nelze prokazat kompatibilitu aplikace. Aktualizuj ji; prenos nic nenahradil.");
}

export function checkAppCompatibility(apps, source, targetKey, info, temporary) {
  const heads = {};
  for (const key of ["official", "custom"]) {
    const app = apps[key];
    if (
      app.version === "0.1.8-nightly.20261104.4165" ||
      app.version === "0.1.7-preview.20261105.6"
    ) {
      heads[key] = 79;
      continue;
    }
    const probe = NodePath.join(temporary, `probe-${key}.sqlite`);
    withDb(
      probe,
      (db) =>
        db.exec(
          "CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT); INSERT INTO effect_sql_migrations VALUES(81,'ProfileSyncCompatibilityProbe')",
        ),
      false,
    );
    if (preflight(app, probe, temporary).status === "ready")
      fail("Instalace pouziva novejsi databazovy format, nez tento nastroj umi overit.");
    withDb(
      probe,
      (db) =>
        db.exec("UPDATE effect_sql_migrations SET migration_id=80, name='ScheduledTaskThreadMode'"),
      false,
    );
    if (preflight(app, probe, temporary).status === "ready") heads[key] = 80;
    else {
      withDb(
        probe,
        (db) =>
          db.exec(
            "UPDATE effect_sql_migrations SET migration_id=79, name='DelegatedRecoveryIndexes'",
          ),
        false,
      );
      if (preflight(app, probe, temporary).status !== "ready")
        fail("Aplikace nepodporuje overene databazove formaty.");
      heads[key] = 79;
    }
  }
  if (heads.official !== heads.custom || info.head > heads[targetKey])
    fail(
      "Verze aplikaci neumoznuji prenos tam i zpet. Aktualizuj obe aplikace na kompatibilni verze (stejnou databazovou migraci).",
    );
  if (
    heads[targetKey] === 80 &&
    preflight(apps[targetKey], NodePath.join(source, "statev2.sqlite"), temporary).status !==
      "ready"
  )
    fail("Cilova aplikace zdrojovou databazi odmitla.");
}

const HELP = `Rucni predani prace mezi T3 Code a T3 Custom (Mac).
Obe aplikace museji byt ukoncene pres Cmd+Q. Planovane ulohy pozastav.

bash sync-profiles.sh to-custom --check --initialize  # prvni kontrola
bash sync-profiles.sh to-custom --apply --initialize  # prvni prenos
bash sync-profiles.sh to-official --check             # kontrola navratu
bash sync-profiles.sh to-official --apply             # predani zpet
bash sync-profiles.sh to-custom --apply               # dalsi predani do Custom
bash sync-profiles.sh --recover                      # preruseny prenos
bash sync-profiles.sh --restore /cesta/k/zaloze       # vratit posledni prenos

Prenasi historii, projekty, prilohy, nastaveni a klice provideru.
Parovani a Chromium profil zustavaji vlastni kazde aplikaci; koncepty v nem se neprenaseji.
Prvni prenos po zaloze nahradi cilovou historii. Dalsi odmitne prepsat zmeneny cil.
Pracovni adresare zustavaji na miste; ~/.t3 ani ~/.t3custom nemaz.
`;

export function main(args) {
  process.umask(0o077);
  if (!args.length || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone helper ships without workspace dependencies.
  if (NodeOS.platform() !== "darwin" || process.env.T3CODE_HOME)
    fail("Podporovan je pouze Mac s vychozimi profily a bez T3CODE_HOME.");
  const paths = layout(NodeFS.realpathSync(NodeOS.homedir()));
  const hooks = { assertClosed, checkCompatibility: () => {} };
  if (args[0] === "--recover" && args.length === 1) {
    const result = recover(paths, hooks);
    console.log(
      result.recovered ? "Predchozi stav byl obnoven." : "Neni co obnovovat; zamek je uvolneny.",
    );
    return;
  }
  if (args[0] === "--restore" && args.length === 2) {
    recover(paths, hooks, NodePath.resolve(args[1]));
    console.log("Posledni prenos byl vracen.");
    return;
  }
  const [direction, ...flags] = args;
  if (
    !["to-custom", "to-official"].includes(direction) ||
    flags.some((flag) => !["--apply", "--check", "--initialize"].includes(flag)) ||
    (flags.includes("--apply") && flags.includes("--check")) ||
    new Set(flags).size !== flags.length
  )
    fail(HELP);
  const apps = installedApps(paths.home);
  hooks.checkCompatibility = (source, targetKey, info, temporary) =>
    checkAppCompatibility(apps, source, targetKey, info, temporary);
  const result = transfer(
    paths,
    { direction, apply: flags.includes("--apply"), initialize: flags.includes("--initialize") },
    hooks,
  );
  if (result.checked)
    console.log(`Kontroly prosly. Vlaken: ${result.threads}. Pro prenos pouzij --apply.`);
  else
    console.log(
      `Hotovo. Otevri pouze ${result.target === "custom" ? "T3 Custom" : "T3 Code"}. Vlaken: ${result.threads}.\nZaloha pro navrat: ${result.backup}\nPred dalsim prechodem proved prenos opacnym smerem.`,
    );
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`CHYBA: ${error.message}`);
    process.exitCode = 1;
  }
}
