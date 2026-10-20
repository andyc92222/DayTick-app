import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const unix = (s) =>
  s
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const common = unix(resolve("scripts/gcp-common.sh"));
function run(code, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "daytick-cloud-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "gcloud.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gcloud"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$DAYTICK_GC_LOG"
[[ "$1" == --project=tutor-project ]] || exit 91
shift
case "$*" in
  'projects describe '*) printf 'Tutor Project\\ttutor-project\\tACTIVE\\n' ;;
  'billing projects describe '*) echo "\${TEST_BILLING:-True}" ;;
  'compute networks list '*) if [[ "\${TEST_DENY:-0}" == 1 ]]; then echo 'permission denied' >&2; exit 1; fi; echo "\${TEST_RESOURCE:-}" ;;
  *) echo 'unexpected cloud operation blocked by test' >&2; exit 92 ;;
esac
`,
    { mode: 0o755 },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "path"),
  );
  const result = spawnSync(
    bash,
    [
      "--noprofile",
      "--norc",
      "-c",
      `export PATH='${unix(bin)}':/usr/bin:/bin\nsource '${common}'\n${code}`,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      input: options.input ?? "",
      env: { ...env, BASH_ENV: "", DAYTICK_GC_LOG: unix(log), ...options.env },
    },
  );
  return { ...result, log: readFileSync(log, "utf8") };
}

test(
  "both cloud entrypoints and their helpers have valid Bash syntax",
  { skip: !existsSync(bash) },
  () => {
    for (const file of [
      "setup-gcp.sh",
      "setup-swarm.sh",
      "gcp-common.sh",
      "gcp-prepare-disk.sh",
      "gcp-release.sh",
    ]) {
      const result = spawnSync(bash, ["-n", `scripts/${file}`], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
  },
);

test(
  "invalid/missing project and unsafe tag stop before any cloud access",
  { skip: !existsSync(bash) },
  () => {
    for (const args of [
      "",
      "--project-id=DayClick",
      "--project-id=tutor-project --tag='bad;tag'",
      "--unexpected=yes",
    ]) {
      const result = run(`parse_args ${args}`);
      assert.notEqual(result.status, 0);
      assert.equal(result.log, "");
    }
  },
);

test(
  "billing or project confirmation failure prevents mutations",
  { skip: !existsSync(bash) },
  () => {
    for (const options of [
      { env: { TEST_BILLING: "False" } },
      { input: "wrong-project\n" },
    ]) {
      const result = run(
        "PROJECT_ID=tutor-project; confirm_project; gc compute networks create forbidden",
        options,
      );
      assert.notEqual(result.status, 0);
      assert.ok(!result.log.includes("create forbidden"));
      assert.match(result.stdout, /Tutor Project.*tutor-project/);
    }
  },
);

test(
  "project-scoped lookups distinguish existing/missing resources and permission failures",
  { skip: !existsSync(bash) },
  () => {
    const code =
      "PROJECT_ID=tutor-project; if exists compute networks list --filter=name=daytick-vpc; then echo REUSED; else echo MISSING; fi";
    const reused = run(code, { env: { TEST_RESOURCE: "daytick-vpc" } });
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, /REUSED/);
    const missing = run(code);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /MISSING/);
    const denied = run(code, { env: { TEST_DENY: "1" } });
    assert.notEqual(denied.status, 0);
    assert.ok(!denied.stdout.includes("MISSING"));
    assert.match(denied.stderr, /refusing to assume/);
    assert.ok(reused.log.startsWith("--project=tutor-project "));
  },
);

test(
  "SSH commands stop on intermediate failures and preserve stdin for tar/token streams",
  { skip: !existsSync(bash) },
  () => {
    const result = run(
      "PROJECT_ID=tutor-project; ssh_node daytick-1 'false; echo must-not-run'",
    );
    assert.match(
      result.log,
      /--tunnel-through-iap.*--command=set -e; false; echo must-not-run/,
    );
  },
);

test(
  "disk preparation refuses unauthorized blank disks before invoking format",
  { skip: !existsSync(bash) },
  () => {
    const original = readFileSync("scripts/gcp-prepare-disk.sh", "utf8");
    // Replace only hardware discovery in the harness; keep the actual confirmation branch.
    const harness = original
      .replace("[[ $EUID -eq 0 ]] || fail 'root required'", "true")
      .replace(
        "[[ -b \"$device\" ]] || fail 'named PostgreSQL disk is not attached'",
        "true",
      )
      .replace('type=$(blkid -s TYPE -o value "$device" || true)', "type=");
    const result = run(`mkfs.ext4() { echo UNSAFE_FORMAT; };\n${harness}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires explicit confirmation/);
    assert.ok(!result.stdout.includes("UNSAFE_FORMAT"));
  },
);

test(
  "disk preparation refuses signatures and nonzero raw data even with confirmation",
  { skip: !existsSync(bash) },
  () => {
    const original = readFileSync("scripts/gcp-prepare-disk.sh", "utf8");
    const harness = original
      .replace("[[ $EUID -eq 0 ]] || fail 'root required'", "true")
      .replace(
        "[[ -b \"$device\" ]] || fail 'named PostgreSQL disk is not attached'",
        "true",
      )
      .replace('type=$(blkid -s TYPE -o value "$device" || true)', "type=");
    for (const signed of [true, false]) {
      const mocks = `
set -- --format-confirmed-empty
mkfs.ext4() { echo UNSAFE_FORMAT; }
wipefs() { ${signed ? "echo existing-signature" : "true"}; }
lsblk() { if [[ "$*" == *MOUNTPOINTS* ]]; then return 0; fi; echo disk; }
python3() { echo 'nonzero disk data' >&2; return 1; }
`;
      const result = run(mocks + harness);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        signed ? /contains a signature/ : /nonzero disk data/,
      );
      assert.ok(!result.stdout.includes("UNSAFE_FORMAT"));
    }
  },
);
