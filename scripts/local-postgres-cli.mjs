// Run PostgreSQL from an isolated copy, not the npm dependency directory.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalSetupError, projectRoot, runtime } from "./postgres-runtime.mjs";

const execute = promisify(execFile);
const databaseDir = join(projectRoot, ".local", "postgres");
const log = join(projectRoot, ".local", "postgres.log");
const secret = async (name) =>
  (await readFile(join(projectRoot, ".secrets", name), "utf8")).trim();
const command = (file, args) =>
  execute(file, args, { windowsHide: true, timeout: 45000 });

function startPostgres(bin) {
  return new Promise((resolve, reject) => {
    // On Windows the server can inherit pg_ctl's pipe handles. Ignore those
    // streams and use the exit event, otherwise execFile can hang after startup.
    const child = spawn(
      bin.pg_ctl,
      [
        "start",
        "-D",
        databaseDir,
        "-l",
        log,
        "-o",
        "-p 55432 -h 127.0.0.1",
        "-w",
        "-t",
        "30",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new LocalSetupError(
              "PostgreSQL could not start. See .local/postgres.log; existing data was retained.",
            ),
          ),
    );
  });
}

async function isRunning(bin) {
  try {
    await command(bin.pg_ctl, ["status", "-D", databaseDir]);
    return true;
  } catch (error) {
    if (error.code === 3 || error.code === 4) return false;
    throw error;
  }
}

async function stop(bin) {
  if (!(await isRunning(bin))) {
    console.log("DayTick PostgreSQL is already stopped. Data is retained.");
    return;
  }
  // pg_ctl targets this exact data directory, never an unrelated postgres process.
  await command(bin.pg_ctl, [
    "stop",
    "-D",
    databaseDir,
    "-m",
    "fast",
    "-w",
    "-t",
    "30",
  ]);
  console.log("DayTick PostgreSQL stopped cleanly. Data is retained.");
}

async function ensurePortFree() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new LocalSetupError(
          "Port 55432 is in use. Stop an existing DayTick database with npm.cmd run dev:db:stop; do not stop unrelated processes.",
        ),
      ),
    );
    server.listen(55432, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

async function initialize(bin, password) {
  const versionFile = join(databaseDir, "PG_VERSION");
  if (existsSync(versionFile)) {
    const major = (await readFile(versionFile, "utf8")).trim();
    const { stdout } = await command(bin.postgres, ["--version"]);
    if (stdout.match(/PostgreSQL\) (\d+)/)?.[1] !== major)
      throw new LocalSetupError(
        `Existing database is PostgreSQL ${major}; automatic major-version upgrades are refused. Your data has not been changed.`,
      );
    return;
  }
  await mkdir(databaseDir, { recursive: true });
  if ((await readdir(databaseDir)).length)
    throw new LocalSetupError(
      "Database directory is nonempty but has no PG_VERSION. Inspect or restore it first; no files were removed.",
    );
  const passwordFile = join(projectRoot, ".secrets", "initdb-password.tmp");
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
  try {
    await command(bin.initdb, [
      "-D",
      databaseDir,
      "--username=postgres",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--lc-messages=C",
    ]);
  } finally {
    await unlink(passwordFile);
  }
}

async function provision(Client, password) {
  const connect = (database) =>
    new Client({
      host: "127.0.0.1",
      port: 55432,
      user: "postgres",
      password,
      database,
    });
  const admin = connect("postgres");
  await admin.connect();
  try {
    if (
      !(await admin.query("SELECT 1 FROM pg_database WHERE datname='daytick'"))
        .rowCount
    )
      await admin.query("CREATE DATABASE daytick");
  } finally {
    await admin.end();
  }
  const client = connect("daytick");
  await client.connect();
  try {
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query("REVOKE ALL ON DATABASE daytick FROM PUBLIC");
    for (const service of ["auth", "task", "timer"]) {
      if (
        !(
          await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
            service,
          ])
        ).rowCount
      ) {
        const rolePassword = await secret(`${service}_db_password`);
        if (!/^[0-9a-f]{64}$/.test(rolePassword))
          throw new LocalSetupError("Expected setup-generated password");
        await client.query(
          `CREATE ROLE ${service} LOGIN PASSWORD '${rolePassword}'`,
        );
        await client.query(`GRANT CONNECT ON DATABASE daytick TO ${service}`);
        await client.query(`CREATE SCHEMA ${service} AUTHORIZATION ${service}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  if (process.argv.includes("--stop")) {
    await stop(await runtime({ cachedOnly: true }));
    return;
  }
  const bin = await runtime();
  if (await isRunning(bin)) {
    console.log(
      "DayTick PostgreSQL is already running on 127.0.0.1:55432. Use npm.cmd run dev:db:stop to stop it.",
    );
    return;
  }
  await ensurePortFree();
  const { Client } = await import("pg");
  const password = await secret("postgres_password");
  await initialize(bin, password);
  await startPostgres(bin);
  try {
    await provision(Client, password);
  } catch (error) {
    await stop(bin);
    throw error;
  }
  console.log(
    "Local PostgreSQL ready on 127.0.0.1:55432. Ctrl+C stops it; data is retained.",
  );
  console.log(
    "Runtime: .local/postgres-runtime/ (safe to run npm ci while this database is running).",
  );
  let stopping = false;
  const timer = setInterval(() => {
    if (!existsSync(join(databaseDir, "postmaster.pid"))) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 1000);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      try {
        await stop(bin);
        process.exit(0);
      } catch {
        console.error(
          "Shutdown failed. Run npm.cmd run dev:db:stop and inspect .local/postgres.log.",
        );
        process.exit(1);
      }
    });
}

main().catch((error) => {
  console.error(
    error instanceof LocalSetupError
      ? error.message
      : "DayTick database startup/control failed. Check npm dependencies, .secrets files and .local/postgres.log. No database files were deleted.",
  );
  process.exitCode = 1;
});
