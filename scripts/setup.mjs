import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".secrets", { recursive: true, mode: 0o700 });
const write = (name, value) => {
  if (!existsSync(`.secrets/${name}`))
    writeFileSync(`.secrets/${name}`, value, { mode: 0o600 });
};
if (existsSync(".secrets/jwt_private") !== existsSync(".secrets/jwt_public")) {
  throw new Error(
    "Incomplete JWT key pair; restore the matching missing key before continuing.",
  );
}
if (!existsSync(".secrets/jwt_private")) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  write("jwt_private", privateKey);
  write("jwt_public", publicKey);
}
for (const name of [
  "postgres_password",
  "auth_db_password",
  "task_db_password",
  "timer_db_password",
  "internal_token",
])
  write(name, randomBytes(32).toString("hex"));
if (!existsSync(".env"))
  writeFileSync(
    ".env",
    "APP_TIMEZONE=Australia/Brisbane\nHTTP_PORT=8080\nPOSTGRES_DB=daytick\n",
    { mode: 0o600 },
  );
console.log("Local configuration ready. Existing secrets were preserved.");
