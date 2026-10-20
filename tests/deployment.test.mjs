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
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const available = existsSync(bash);
const unixPath = (value) =>
  value
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const source = (name) => readFileSync(`infrastructure/swarm/${name}`, "utf8");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "daytick-deployment-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "commands.log");
  writeFileSync(log, "");
  // Windows environments normally use "Path". Remove it before setting PATH,
  // otherwise spawn can retain the real tools instead of the sandbox stubs.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  const env = {
    ...inherited,
    PATH: unixPath(bin),
    BASH_ENV: "",
    DAYTICK_TEST_BIN: unixPath(bin),
    DAYTICK_TEST_LOG: unixPath(log),
  };
  return {
    root,
    bin,
    env,
    mock(name, text) {
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${text}\n`, {
        mode: 0o755,
      });
    },
    run(text, extra = {}) {
      // Set PATH inside Bash too: Git Bash can normalize the inherited PATH.
      const isolated = 'export PATH="$DAYTICK_TEST_BIN"\nhash -r\n' + text;
      return spawnSync(bash, ["--noprofile", "--norc", "-c", isolated], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 10000,
      });
    },
    calls() {
      return readFileSync(log, "utf8");
    },
  };
}

test(
  "GCE first boot installs Docker, second boot never invokes apt/curl or restarts Docker",
  { skip: !available },
  () => {
    const box = sandbox();
    const etc = `${unixPath(box.root)}/etc`;
    mkdirSync(join(box.root, "etc", "apt", "sources.list.d"), {
      recursive: true,
    });
    mkdirSync(join(box.root, "etc", "apt", "keyrings"), { recursive: true });
    box.mock("install", 'printf "install %s\\n" "$*" >> "$DAYTICK_TEST_LOG"');
    box.mock("chmod", ":");
    box.mock("curl", 'printf "curl\\n" >> "$DAYTICK_TEST_LOG"');
    box.mock(
      "systemctl",
      'printf "systemctl %s\\n" "$*" >> "$DAYTICK_TEST_LOG"',
    );
    box.mock(
      "apt-get",
      `
printf 'apt-get %s\\n' "$*" >> "$DAYTICK_TEST_LOG"
if [[ "$*" == *docker-ce* ]]; then
  printf '#!/bin/bash\\nexit 0\\n' > "$DAYTICK_TEST_BIN/docker"
  /bin/chmod +x "$DAYTICK_TEST_BIN/docker"
fi`,
    );
    // Rewrite only filesystem destinations in the test copy, never touch host /etc.
    const script = source("gce-startup.sh").replaceAll("/etc/", `${etc}/`);
    const first = box.run(script);
    assert.equal(first.status, 0, first.stderr);
    assert.match(box.calls(), /apt-get install -y docker-ce/);
    const initial = box.calls();
    const second = box.run(script);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      box.calls().slice(initial.length),
      "systemctl enable --now docker\n",
    );
  },
);

test(
  "existing incomplete Docker installation fails without package upgrades",
  { skip: !available },
  () => {
    const box = sandbox();
    box.mock("docker", "exit 1");
    box.mock("apt-get", 'echo unexpected >> "$DAYTICK_TEST_LOG"');
    box.mock("systemctl", 'echo unexpected >> "$DAYTICK_TEST_LOG"');
    const result = box.run(source("gce-startup.sh"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compose plugin missing/);
    assert.equal(box.calls(), "");
  },
);

test(
  "Docker startup failure propagates instead of bypassing a failed mount guard",
  { skip: !available },
  () => {
    const box = sandbox();
    box.mock("docker", "exit 0");
    box.mock("systemctl", "exit 1");
    assert.notEqual(box.run(source("gce-startup.sh")).status, 0);
  },
);

for (const [name, overrides, expectedSuccess] of [
  ["matching recorded, mounted and attached disk UUIDs", {}, true],
  ["missing mount", { MOUNT_OK: "0" }, false],
  ["wrong mounted filesystem", { MOUNT_UUID: "wrong-disk" }, false],
  ["wrong named GCE disk", { DEVICE_UUID: "wrong-disk" }, false],
  ["missing named GCE disk", { DEVICE_OK: "0" }, false],
  ["missing expected UUID configuration", { CONFIG_OK: "0" }, false],
]) {
  test(`disk guard: ${name}`, { skip: !available }, () => {
    const box = sandbox();
    box.mock(
      "cat",
      '[[ "$1" == /etc/daytick/postgres-disk-uuid ]]\n[[ "$CONFIG_OK" == 1 ]]\nprintf "%s\\n" "$EXPECTED_UUID"',
    );
    box.mock(
      "mountpoint",
      '[[ "$*" == "-q /srv/daytick/postgres" ]]\n[[ "$MOUNT_OK" == 1 ]]',
    );
    box.mock(
      "findmnt",
      '[[ "$*" == "-rn --mountpoint /srv/daytick/postgres --output UUID" ]]\nprintf "%s\\n" "$MOUNT_UUID"',
    );
    box.mock(
      "blkid",
      '[[ "$*" == "-s UUID -o value /dev/disk/by-id/google-daytick-postgres" ]]\n[[ "$DEVICE_OK" == 1 ]]\nprintf "%s\\n" "$DEVICE_UUID"',
    );
    const result = box.run(source("check-postgres-mount.sh"), {
      CONFIG_OK: "1",
      MOUNT_OK: "1",
      DEVICE_OK: "1",
      EXPECTED_UUID: "expected-disk",
      MOUNT_UUID: "expected-disk",
      DEVICE_UUID: "expected-disk",
      ...overrides,
    });
    assert.equal(result.status === 0, expectedSuccess, result.stderr);
    if (!expectedSuccess)
      assert.match(result.stderr, /DayTick PostgreSQL disk guard:/);
  });
}

test("disk-guard installer wires mount dependency, loss binding and identity check without formatting", () => {
  const script = source("install-postgres-mount-guard.sh");
  assert.match(script, /RequiresMountsFor=\/srv\/daytick\/postgres/);
  assert.match(script, /BindsTo=srv-daytick-postgres\.mount/);
  assert.match(script, /After=srv-daytick-postgres\.mount/);
  assert.match(
    script,
    /ExecStartPre=\/usr\/local\/sbin\/daytick-check-postgres-mount/,
  );
  assert.match(script, /refusing to silently authorize a replacement disk/);
  assert.doesNotMatch(script, /^\s*(mkfs|wipefs|umount|systemctl restart)\b/m);
});
