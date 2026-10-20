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

test(
  "release staging lets the SSH user enter before sudo without granting write or secret access",
  { skip: !existsSync(bash) },
  () => {
    const setup = readFileSync("scripts/setup-swarm.sh", "utf8");
    const staging = setup
      .split(/\r?\n/)
      .find((line) => line.startsWith('ssh_node daytick-1 "sudo mkdir'));
    assert.ok(
      staging,
      "Find the actual staging command, rather than test a copied implementation",
    );
    const harness = `
remote=/opt/daytick-tutor-project
mode=700
owner=root:root
id() { echo caller-group; }
sudo() {
  [[ "\${!#}" == "$remote" ]] || { echo 'unexpected or recursive permission change' >&2; return 1; }
  case "$1" in
    mkdir) [[ "$2" == -p ]] ;;
    chown) [[ "$#" == 3 ]]; owner=$2 ;;
    chmod) [[ "$#" == 3 ]]; mode=$2 ;;
    *) return 1 ;;
  esac
}
ssh_node() {
  shift
  id() { [[ "$1" == -gn ]]; echo vm-ssh-group; }
  eval "$*"
}
`;
    // Model Unix traversal here because Windows/Git Bash does not enforce Unix modes.
    const check = `
[[ "$owner" == root:vm-ssh-group ]] || { echo 'SSH group was not resolved on the VM' >&2; exit 1; }
[[ "$mode" == 750 ]] || { echo 'SSH user cannot enter the release directory securely' >&2; exit 1; }
echo SSH_CD_ALLOWED
`;
    const fixed = run(harness + staging + check);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /SSH_CD_ALLOWED/);
    const old = run(
      harness +
        "ssh_node daytick-1 \"sudo mkdir -p '$remote'; sudo chmod 700 '$remote'\"\n" +
        check,
    );
    assert.notEqual(
      old.status,
      0,
      "Regression must reproduce the original root-only failure",
    );
    assert.ok(!old.stdout.includes("SSH_CD_ALLOWED"));
    assert.ok(
      setup.indexOf(staging) <
        setup.indexOf("bash scripts/gcp-prepare-disk.sh"),
    );
    assert.match(
      readFileSync("scripts/gcp-release.sh", "utf8"),
      /chmod 700 \.secrets/,
    );
    assert.match(readFileSync("scripts/gcp-release.sh", "utf8"), /chmod 600/);
  },
);

test(
  "Swarm orchestration resumes the sole manager and reruns without rejoining or resetting",
  { skip: !existsSync(bash) },
  () => {
    const setup = readFileSync("scripts/setup-swarm.sh", "utf8");
    const section = setup.slice(
      setup.indexOf("# Initialize only inactive nodes."),
      setup.indexOf("CREATED+=(three-manager-swarm-and-labels)"),
    );
    assert.ok(section.includes("validate_members partial"));
    assert.ok(section.includes("validate_members final"));
    for (const joined of [false, true]) {
      const harness = `
PROJECT_ID=tutor-project
ips=(10.42.0.2 10.42.0.3 10.42.0.4)
state_dir=$(mktemp -d)
echo active > "$state_dir/daytick-1"
echo ${joined ? "active" : "inactive"} > "$state_dir/daytick-2"
echo ${joined ? "active" : "inactive"} > "$state_dir/daytick-3"
: > "$state_dir/joins"
: > "$state_dir/validation"
ssh_node() {
  local node=$1 cmd=$2
  case "$cmd" in
    *LocalNodeState*) cat "$state_dir/$node" ;;
    *Cluster.ID*) echo cluster1 ;;
    *NodeID*) echo "id\${node#daytick-}" ;;
    *join-token*) echo mock-token ;;
    *'swarm join --token'*) read -r token; echo active > "$state_dir/$node"; echo "$node" >> "$state_dir/joins" ;;
    *'node inspect'*) echo '[]' ;;
    *'node update'*) echo "$cmd" >> "$state_dir/validation" ;;
    *'node ls'*) true ;;
    *) echo "Unexpected mutation: $cmd" >&2; return 1 ;;
  esac
}
# Validator itself has independent Python tests with real GCE hostname fixtures.
python3() { cat >/dev/null; echo "$*" >> "$state_dir/validation"; }
`;
      const result = run(
        harness +
          section +
          '\necho JOINED; cat "$state_dir/joins"; echo VALIDATED; cat "$state_dir/validation"',
      );
      assert.equal(result.status, 0, result.stderr);
      const joins = result.stdout
        .split("JOINED\n")[1]
        .split("VALIDATED\n")[0]
        .trim();
      assert.equal(joins, joined ? "" : "daytick-2\ndaytick-3");
      assert.match(result.stdout, /gcp-validate-swarm.py partial/);
      assert.match(result.stdout, /gcp-validate-swarm.py final/);
      assert.match(result.stdout, /daytick.host=daytick-2 'id2'/);
      assert.match(result.stdout, /daytick.db=true 'id1'/);
    }
  },
);
