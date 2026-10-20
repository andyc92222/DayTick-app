import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export class LocalSetupError extends Error {}

export async function copyRuntime(source, destination) {
  if (existsSync(join(destination, "ready.json"))) return;
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.preparing-`);
  // PostgreSQL needs its entire native tree. Dereference links so the copy
  // never loads files from node_modules while npm ci replaces that directory.
  await cp(source, join(staging, "native"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(staging, "ready.json"), "{}\n");
  try {
    await rename(staging, destination);
  } catch (error) {
    if (!existsSync(join(destination, "ready.json"))) throw error;
    // Another launcher completed this version. Never overwrite an active copy.
  }
}

function binaries(directory) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return Object.fromEntries(
    ["postgres", "initdb", "pg_ctl"].map((name) => [
      name,
      join(directory, "native", "bin", `${name}${suffix}`),
    ]),
  );
}

export async function runtime({ root = projectRoot, cachedOnly = false } = {}) {
  const base = join(root, ".local", "postgres-runtime");
  const pointer = join(base, "current.json");
  if (cachedOnly) {
    if (!existsSync(pointer))
      throw new LocalSetupError(
        "No DayTick runtime exists yet. Run npm.cmd run dev:db first.",
      );
    const { directory } = JSON.parse(await readFile(pointer, "utf8"));
    const resolved = resolve(base, directory);
    if (!resolved.startsWith(resolve(base) + sep))
      throw new LocalSetupError("Invalid local runtime path");
    return binaries(resolved);
  }
  let entry;
  try {
    const require = createRequire(join(root, "package.json"));
    const embeddedEntry = require.resolve("embedded-postgres");
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    entry = createRequire(embeddedEntry).resolve(
      `@embedded-postgres/${platform}-${process.arch}`,
    );
  } catch {
    throw new LocalSetupError(
      "PostgreSQL dependencies are missing. Run npm.cmd ci --include=dev --include=optional from the DayTick root.",
    );
  }
  const packageDir = resolve(dirname(entry), "..");
  const { version } = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  if (!/^[\w.-]+$/.test(version))
    throw new LocalSetupError("Invalid PostgreSQL package version");
  const directory = `${version}-${process.platform}-${process.arch}`;
  const destination = join(base, directory);
  await copyRuntime(join(packageDir, "native"), destination);
  await writeFile(pointer, JSON.stringify({ directory }));
  return binaries(destination);
}
