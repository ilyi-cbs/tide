import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  COMMANDS,
  ROOT,
  assertPortAvailable,
  configuration,
  ensureEnvironmentFile,
  loadEnvironment,
  parseCommand,
  runCommand,
  setupPlan,
  supervise,
  testPlan,
  validateLiveConfiguration,
} from "./tide.mjs";

test("root commands are explicit and unknown commands fail", () => {
  for (const command of COMMANDS)
    assert.equal(parseCommand([command]).command, command);
  assert.throws(() => parseCommand(["reset"]), /Unknown command/);
});

test("help does not execute a command", () => {
  assert.equal(parseCommand(["start", "--help"]).command, "help");
});

test("root .env uses structured parsing and exported variables take precedence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tide-cli-"));
  try {
    fs.writeFileSync(
      path.join(directory, ".env"),
      'CAP_PORT=4404\nAGENT_MODEL="openai/example"\nAGENT_MODEL_API_KEY="$(not-executed)"\n',
    );
    const env = loadEnvironment(directory, { CAP_PORT: "4504" });
    assert.equal(env.CAP_PORT, "4504");
    assert.equal(env.AGENT_MODEL, "openai/example");
    assert.equal(env.AGENT_MODEL_API_KEY, "$(not-executed)");
    assert.deepEqual(
      loadEnvironment(path.join(directory, "absent"), { CAP_PORT: "4004" }),
      { CAP_PORT: "4004" },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("configuration normalizes paths and endpoints without enabling demo behavior", () => {
  const config = configuration({
    CAP_PORT: "4504",
    CHECKPOINT_DB: "local/checkpoints.sqlite",
    TIDE_DB: "local/source.sqlite",
  });
  assert.equal(config.env.CAP_URL, "http://127.0.0.1:4504");
  assert.equal(config.database, path.join(ROOT, "local", "source.sqlite"));
  assert.equal(
    config.env.CHECKPOINT_DB,
    path.join(ROOT, "local", "checkpoints.sqlite"),
  );
  assert.equal(config.env.TIDE_AUTO_PREPARE, "1");
  assert.equal(config.env.TIDE_DEMO_PRIORITY_HISTORY, "0");
  assert.deepEqual(JSON.parse(config.env.CDS_TIDE_FREETEXT), { demoSeed: 0 });
  const defaults = configuration({});
  assert.equal(
    defaults.database,
    path.join(ROOT, ".data", "retained", "cap.sqlite"),
  );
  assert.equal(
    defaults.env.CHECKPOINT_DB,
    path.join(ROOT, ".data", "retained", "checkpoints.sqlite"),
  );
  assert.throws(() => configuration({ CAP_PORT: "8080" }), /distinct/);
  assert.throws(() => configuration({ AGENT_PORT: "8000invalid" }), /integer/);
});

test("setup creates root .env once and never overwrites existing configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tide-setup-"));
  try {
    fs.writeFileSync(path.join(directory, ".env.example"), "CAP_PORT=4004\n");
    ensureEnvironmentFile(directory);
    assert.equal(
      fs.readFileSync(path.join(directory, ".env"), "utf8"),
      "CAP_PORT=4004\n",
    );
    fs.writeFileSync(path.join(directory, ".env"), "CAP_PORT=4504\n");
    ensureEnvironmentFile(directory);
    assert.equal(
      fs.readFileSync(path.join(directory, ".env"), "utf8"),
      "CAP_PORT=4504\n",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live configuration refuses fake inference and names missing fields without values", () => {
  const env = {
    ...configuration({}).env,
    TABULAR_BACKEND: "priorlabs",
    GATEWAY_UPSTREAM_MODEL: "openai/example",
    GATEWAY_UPSTREAM_API_KEY: "secret-value",
    PRIORLABS_API_KEY: "another-secret",
  };
  validateLiveConfiguration(env);
  assert.throws(
    () => validateLiveConfiguration({ ...env, LLM_FAKE: "1" }),
    /real LLM/,
  );
  assert.throws(
    () => validateLiveConfiguration({ ...env, TABULAR_BACKEND: "fake" }),
    /priorlabs or aicore/,
  );
  assert.throws(
    () => validateLiveConfiguration({ ...env, PRIORLABS_API_KEY: "" }),
    (error) =>
      error.message.includes("PRIORLABS_API_KEY") &&
      !error.message.includes("secret-value"),
  );
  validateLiveConfiguration({
    ...env,
    TABULAR_BACKEND: "aicore",
    AICORE_AUTH_URL: "https://auth.invalid",
    AICORE_CLIENT_ID: "client",
    AICORE_CLIENT_SECRET: "secret",
    AICORE_DEPLOYMENT_URL: "https://deployment.invalid",
  });
});

test("setup and test plans are frozen, scoped, and shell-independent", () => {
  const tasks = setupPlan();
  assert.deepEqual(tasks[0].args, ["ci"]);
  for (const task of tasks.filter((task) => task.executable === "uv"))
    assert.ok(task.args.includes("--frozen"));
  assert.equal(testPlan(["cli"]).length, 1);
  assert.equal(testPlan(["loader"]).length, 5);
  assert.throws(() => testPlan(["unknown"]), /Unknown test target/);
  const cap = testPlan(["cap"]).at(-1);
  assert.ok(cap.args.some((argument) => argument.endsWith(".test.ts")));
  assert.ok(cap.args.every((argument) => !argument.includes("*.test.ts")));
});

test("command execution forwards cwd and env and propagates failures", async () => {
  const task = {
    name: "fixture",
    executable: "fixture",
    args: ["argument with spaces"],
    cwd: ROOT,
  };
  const env = { SAMPLE: "value" };
  const fakeSpawn = (code) => (executable, args, options) => {
    assert.equal(executable, task.executable);
    assert.deepEqual(args, task.args);
    assert.equal(options.cwd, ROOT);
    assert.equal(options.env, env);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", code));
    return child;
  };
  await runCommand(task, env, fakeSpawn(0));
  await assert.rejects(runCommand(task, env, fakeSpawn(2)), /failed \(2\)/);
});

test("reserved data commands fail explicitly without modifying data", () => {
  for (const command of ["data:pack"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "tide.mjs"), command],
      { encoding: "utf8", cwd: os.tmpdir() },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reserved, not implemented/);
    assert.match(result.stderr, /No data was modified/);
  }
});

test("occupied ports are rejected and point to --force", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      assertPortAvailable(server.address().port),
      /--force/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  "supervisor stops a sibling when one service exits",
  { timeout: 10_000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tide-supervisor-"),
    );
    const marker = path.join(directory, "pid");
    try {
      await assert.rejects(
        supervise(
          [
            {
              name: "fixture sibling",
              executable: process.execPath,
              args: [
                "-e",
                "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
                marker,
              ],
              cwd: ROOT,
            },
            {
              name: "fixture failure",
              executable: process.execPath,
              args: ["-e", "setTimeout(()=>process.exit(2),300)"],
              cwd: ROOT,
            },
          ],
          process.env,
          { waitForReady: async () => {} },
        ),
        /exited \(2\)/,
      );
      assert.throws(
        () => process.kill(Number(fs.readFileSync(marker, "utf8")), 0),
        { code: "ESRCH" },
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "supervisor cleans up after a readiness failure",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      supervise(
        [
          {
            name: "fixture not ready",
            executable: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            cwd: ROOT,
          },
        ],
        process.env,
        {
          waitForReady: async () => {
            throw new Error("fixture readiness failed");
          },
        },
      ),
      /fixture readiness failed/,
    );
  },
);

test(
  "foreground supervisor handles SIGINT and exits",
  { timeout: 10_000 },
  async () => {
    const code = `import {supervise} from ${JSON.stringify(new URL("./tide.mjs", import.meta.url).href)}; await supervise([{name:'signal fixture',executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:${JSON.stringify(ROOT)}}],process.env,{waitForReady:async()=>{}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("[tide] ready:")) child.kill("SIGINT");
    });
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) => resolve({ status, signal }));
      });
      assert.equal(exit.status, 0, errors);
      assert.match(output, /ready:/);
    } finally {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }
  },
);
