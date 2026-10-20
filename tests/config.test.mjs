import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

const load = (file) => parse(readFileSync(file, "utf8"), { merge: true });
test("Compose has all components, health checks, secrets and durable database storage", () => {
  const compose = load("compose.yml");
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "auth",
    "frontend",
    "gateway",
    "postgres",
    "task",
    "timer",
  ]);
  for (const [name, service] of Object.entries(compose.services)) {
    if (service.build) assert.ok(existsSync(service.build.dockerfile));
    if (["auth", "task", "timer"].includes(name)) {
      assert.ok(service.healthcheck);
      assert.ok(service.environment.JWT_PUBLIC_KEY_FILE);
      assert.ok(
        !service.ports,
        "Only the gateway should publish application traffic",
      );
      assert.ok(service.secrets.includes(`${name}_db_password`));
      assert.equal(service.secrets.includes("jwt_private"), name === "auth");
    }
  }
  assert.ok(
    compose.services.postgres.volumes.some((value) =>
      value.startsWith("postgres_data:"),
    ),
  );
  for (const secret of Object.values(compose.secrets))
    assert.ok(secret.file.startsWith("./.secrets/"));
});
test("Swarm uses replicated, health-checked app images and stop-first single database updates", () => {
  const stack = load("infrastructure/swarm/stack.yml");
  for (const name of ["auth", "task", "timer", "frontend", "gateway"]) {
    const service = stack.services[name];
    assert.ok(service.image.includes("${TAG}"));
    assert.equal(service.deploy.replicas, 2);
    assert.equal(service.deploy.update_config.failure_action, "rollback");
    assert.equal(service.deploy.update_config.parallelism, 1);
    assert.deepEqual(service.deploy.placement.preferences, [
      { spread: "node.labels.daytick.host" },
    ]);
    assert.ok(!service.build, "Swarm does not build images");
  }
  assert.equal(stack.services.postgres.deploy.replicas, 1);
  assert.equal(
    stack.services.postgres.deploy.update_config.order,
    "stop-first",
  );
  assert.deepEqual(stack.services.postgres.deploy.placement.constraints, [
    "node.labels.daytick.db == true",
  ]);
  assert.equal(stack.services.gateway.ports[0].mode, "ingress");
  assert.ok(!stack.services.postgres.ports);
  assert.ok(Object.values(stack.secrets).every((secret) => secret.external));
});
test("Gateway does not expose internal service endpoints and uses Docker DNS", () => {
  const config = readFileSync("infrastructure/nginx/default.conf", "utf8");
  assert.ok(config.includes("location /internal/ { return 404; }"));
  assert.ok(config.includes("resolver 127.0.0.11"));
  for (const service of ["auth", "task", "timer"])
    assert.ok(config.includes(`${service}:8000`));
});
