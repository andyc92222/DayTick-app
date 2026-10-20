import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyRuntime, runtime } from "../scripts/postgres-runtime.mjs";

test("runtime is a complete independent copy and is not overwritten on reinstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytick-runtime-test-"));
  const source = join(root, "node_modules", "native");
  const target = join(root, ".local", "runtime");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "share"), { recursive: true });
  await writeFile(join(source, "bin", "library.dll"), "installed version");
  await writeFile(join(source, "share", "postgres.bki"), "catalog");
  await copyRuntime(source, target);
  await writeFile(join(source, "bin", "library.dll"), "reinstalled version");
  await copyRuntime(source, target);
  assert.equal(
    await readFile(join(target, "native", "bin", "library.dll"), "utf8"),
    "installed version",
  );
  assert.equal(
    await readFile(join(target, "native", "share", "postgres.bki"), "utf8"),
    "catalog",
  );
});

test("cached stop runtime resolves without any npm packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytick-cached-test-"));
  const base = join(root, ".local", "postgres-runtime");
  await mkdir(base, { recursive: true });
  await writeFile(
    join(base, "current.json"),
    JSON.stringify({ directory: "test-version" }),
  );
  const bin = await runtime({ root, cachedOnly: true });
  assert.ok(bin.pg_ctl.startsWith(join(base, "test-version")));
  assert.ok(!bin.pg_ctl.includes("node_modules"));
});

test("cached paths cannot escape the runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytick-path-test-"));
  const base = join(root, ".local", "postgres-runtime");
  await mkdir(base, { recursive: true });
  await writeFile(
    join(base, "current.json"),
    JSON.stringify({ directory: "../../unrelated" }),
  );
  await assert.rejects(
    runtime({ root, cachedOnly: true }),
    /Invalid local runtime path/,
  );
});

test("missing dependencies give an actionable installation command", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytick-deps-test-"));
  await writeFile(join(root, "package.json"), "{}");
  await assert.rejects(
    runtime({ root }),
    /npm.cmd ci --include=dev --include=optional/,
  );
});
