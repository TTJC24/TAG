import { spawnSync } from "node:child_process";

const composeArgs = [
  "compose",
  "-f",
  "compose.test.yaml",
  "-p",
  "operating-layer-feature-test",
];
const pnpmCommand = process.platform === "win32" ? "pnpm.exe" : "pnpm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

try {
  run(pnpmCommand, ["--filter", "@operating-layer/issue-intake...", "build"]);
  run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
  run("docker", [...composeArgs, "up", "--detach", "--wait", "postgres"]);
  run(pnpmCommand, ["--filter", "@operating-layer/api", "test:integration"], {
    env: {
      ...process.env,
      DATABASE_URL_TEST:
        "postgresql://operating_layer:feature-test-only@localhost:55432/operating_layer_test",
      DATABASE_URL_RUNTIME_TEST:
        "postgresql://operating_layer_runtime:local-runtime-only@localhost:55432/operating_layer_test",
    },
  });
} finally {
  spawnSync(
    "docker",
    [...composeArgs, "down", "--volumes", "--remove-orphans"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "inherit",
    },
  );
}
