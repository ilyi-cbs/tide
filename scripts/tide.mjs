import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const COMMANDS = [
  "setup",
  "doctor",
  "start",
  "test",
  "data:load",
  "data:seed",
  "data:pack",
];
const PREDICTIONS = "predictions";
export const TEST_TARGETS = [
  "cli",
  "cap",
  "assistant",
  "agent",
  "tabular",
  "loader",
];
const CAP = path.join(ROOT, "src", "tide-cap");
const projectDirectory = (root, name) => path.join(root, "src", `tide-${name}`);

export function loadEnvironment(root = ROOT, inherited = process.env) {
  const filename = path.join(root, ".env");
  return {
    ...(fs.existsSync(filename)
      ? parseEnv(fs.readFileSync(filename, "utf8"))
      : {}),
    ...inherited,
  };
}

export function configuration(environment, root = ROOT) {
  const statePath = (name, fallback) =>
    path.resolve(root, environment[name] || fallback);
  const port = (name, fallback) => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error(`${name} must be an integer between 1 and 65535.`);
    return value;
  };
  const ports = {
    cap: port("CAP_PORT", 4004),
    tabular: port("TABULAR_PORT", 8080),
    agent: port("AGENT_PORT", 8081),
    gateway: port("GATEWAY_PORT", 4000),
  };
  if (new Set(Object.values(ports)).size !== 4)
    throw new Error(
      "CAP_PORT, TABULAR_PORT, AGENT_PORT, and GATEWAY_PORT must be distinct.",
    );
  const capUrl = `http://127.0.0.1:${ports.cap}`;
  const database = statePath("TIDE_DB", ".data/retained/cap.sqlite");
  const legacyProvider =
    environment.AGENT_MODEL &&
    environment.AGENT_MODEL !== "openai/agent-reasoning";
  const tabularToken =
    environment.TABULAR_INTERNAL_TOKEN || randomBytes(32).toString("hex");
  const env = {
    ...environment,
    GATEWAY_UPSTREAM_MODEL:
      environment.GATEWAY_UPSTREAM_MODEL ||
      (legacyProvider ? environment.AGENT_MODEL : ""),
    GATEWAY_UPSTREAM_API_KEY:
      environment.GATEWAY_UPSTREAM_API_KEY ||
      (legacyProvider ? environment.AGENT_MODEL_API_KEY : ""),
    GATEWAY_UPSTREAM_API_BASE:
      environment.GATEWAY_UPSTREAM_API_BASE ||
      (legacyProvider ? environment.AGENT_MODEL_API_BASE : "") ||
      "",
    GATEWAY_UPSTREAM_API_VERSION:
      environment.GATEWAY_UPSTREAM_API_VERSION ||
      (legacyProvider ? environment.AGENT_MODEL_API_VERSION : "") ||
      "",
    GATEWAY_AGENT_KEY:
      environment.GATEWAY_AGENT_KEY || `sk-${randomBytes(32).toString("hex")}`,
    GATEWAY_CAP_KEY:
      environment.GATEWAY_CAP_KEY || `sk-${randomBytes(32).toString("hex")}`,
    TABULAR_INTERNAL_TOKEN: tabularToken,
    GATEWAY_PORT: String(ports.gateway),
    CAP_PORT: String(ports.cap),
    PORT: String(ports.cap),
    TABULAR_PORT: String(ports.tabular),
    AGENT_PORT: String(ports.agent),
    CDS_TYPESCRIPT: "true",
    CDS_REQUIRES_DB_CREDENTIALS_URL: database,
    TIDE_LOADER_DIR: projectDirectory(root, "loader"),
    CDS_REQUIRES_TABULAR_CREDENTIALS_URL:
      environment.CDS_REQUIRES_TABULAR_CREDENTIALS_URL ||
      `http://127.0.0.1:${ports.tabular}`,
    CDS_REQUIRES_TABULAR_CREDENTIALS_TOKEN: tabularToken,
    AGENT_URL: environment.AGENT_URL || `http://127.0.0.1:${ports.agent}`,
    CAP_URL: environment.CAP_URL || capUrl,
    CORS_ORIGINS:
      environment.CORS_ORIGINS || `${capUrl},http://localhost:${ports.cap}`,
    CHECKPOINT_DB: statePath(
      "CHECKPOINT_DB",
      ".data/retained/checkpoints.sqlite",
    ),
    TIDE_AUTO_PREPARE: "1",
    TIDE_DEMO_PRIORITY_HISTORY: "0",
    CDS_TIDE_FREETEXT: JSON.stringify({ demoSeed: 0 }),
  };
  return {
    ports,
    capUrl,
    database,
    source: path.resolve(root, environment.TIDE_DATASET || "data/demo"),
    env,
  };
}

export function validateLiveConfiguration(env) {
  if (env.LLM_FAKE && !["0", "false"].includes(env.LLM_FAKE.toLowerCase()))
    throw new Error(
      "npm start requires a real LLM; fake adapters are reserved for tests.",
    );
  if (!["priorlabs", "aicore"].includes(env.TABULAR_BACKEND))
    throw new Error(
      "Set TABULAR_BACKEND to priorlabs or aicore in the root .env.",
    );
  const required = ["GATEWAY_UPSTREAM_MODEL", "GATEWAY_UPSTREAM_API_KEY"];
  if (/^(azure\/|azure_ai\/)/.test(env.GATEWAY_UPSTREAM_MODEL || ""))
    required.push("GATEWAY_UPSTREAM_API_BASE");
  if (/^azure\//.test(env.GATEWAY_UPSTREAM_MODEL || ""))
    required.push("GATEWAY_UPSTREAM_API_VERSION");
  if (env.GATEWAY_AGENT_KEY === env.GATEWAY_CAP_KEY)
    throw new Error("Gateway caller keys must be distinct.");
  for (const [name, port] of [
    ["CAP_URL", env.CAP_PORT],
    ["AGENT_URL", env.AGENT_PORT],
  ]) {
    const url = new URL(env[name]);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.port !== String(port) ||
      url.username ||
      url.password
    )
      throw new Error(
        `${name} must target the corresponding supervised local service.`,
      );
  }
  if (env.TABULAR_BACKEND === "priorlabs") required.push("PRIORLABS_API_KEY");
  else {
    required.push(
      "AICORE_AUTH_URL",
      "AICORE_CLIENT_ID",
      "AICORE_CLIENT_SECRET",
    );
    if (!env.AICORE_DEPLOYMENT_URL)
      required.push("AICORE_API_URL", "AICORE_DEPLOYMENT_ID");
  }
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Missing configuration: ${missing.join(", ")}. Edit the root .env; do not commit credentials.`,
    );
}

function localTool(packageName, executable) {
  const requireCap = createRequire(path.join(CAP, "package.json"));
  const metadataPath = requireCap.resolve(`${packageName}/package.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  return path.resolve(path.dirname(metadataPath), metadata.bin[executable]);
}

export function setupPlan(root = ROOT) {
  const cap = path.join(root, "src", "tide-cap");
  return [
    { name: "CAP dependencies", cwd: cap, executable: "npm", args: ["ci"] },
    {
      name: "assistant bundle",
      cwd: cap,
      executable: "npm",
      args: ["run", "build:assistant:purchasing-desk"],
    },
    ...["agent", "tabular", "loader"].map((name) => ({
      name: `${name} dependencies`,
      cwd: root,
      executable: "uv",
      args: ["sync", "--project", projectDirectory(root, name), "--frozen"],
    })),
    {
      name: "gateway dependencies",
      cwd: root,
      executable: "uv",
      args: [
        "sync",
        "--project",
        path.join(projectDirectory(root, "agent"), "gateway"),
        "--frozen",
      ],
    },
  ];
}

export function ensureEnvironmentFile(root = ROOT) {
  const filename = path.join(root, ".env");
  if (!fs.existsSync(filename))
    fs.copyFileSync(
      path.join(root, ".env.example"),
      filename,
      fs.constants.COPYFILE_EXCL,
    );
}

export function testPlan(targets) {
  const selected = targets.length ? targets : TEST_TARGETS;
  for (const target of selected)
    if (!TEST_TARGETS.includes(target))
      throw new Error(
        `Unknown test target: ${target}. Choose ${TEST_TARGETS.join(", ")}.`,
      );
  return selected.flatMap((target) => {
    if (target === "cli")
      return [
        {
          name: "CLI tests",
          cwd: ROOT,
          executable: process.execPath,
          args: ["--test", "scripts/tide.test.mjs"],
        },
      ];
    if (target === "cap")
      return [
        {
          name: "CAP lint",
          cwd: CAP,
          executable: process.execPath,
          args: [localTool("eslint", "eslint"), "."],
        },
        {
          name: "CAP typecheck",
          cwd: CAP,
          executable: process.execPath,
          args: [localTool("typescript", "tsc"), "--noEmit"],
        },
        {
          name: "CAP tests",
          cwd: CAP,
          executable: process.execPath,
          args: [
            "--import",
            "tsx",
            "--test",
            "--test-force-exit",
            "--test-concurrency=1",
            ...fs
              .readdirSync(path.join(CAP, "test"))
              .filter((name) => name.endsWith(".test.ts"))
              .sort()
              .map((name) => path.join("test", name)),
          ],
        },
      ];
    if (target === "assistant")
      return ["typecheck", "test"].map((script) => ({
        name: `assistant ${script}`,
        cwd: CAP,
        executable: "npm",
        args: ["run", script, "-w", "@tide/assistant"],
      }));
    const cwd = projectDirectory(ROOT, target);
    return [
      {
        name: `${target} lint`,
        cwd,
        executable: "uv",
        args: ["run", "--frozen", "ruff", "check", "."],
      },
      {
        name: `${target} formatting`,
        cwd,
        executable: "uv",
        args: ["run", "--frozen", "ruff", "format", "--check", "."],
      },
      ...(target === "tabular"
        ? [
            {
              name: "tabular typecheck",
              cwd,
              executable: "uv",
              args: [
                "run",
                "--frozen",
                "mypy",
                "--config-file",
                "pyproject.toml",
                "src/tabular",
              ],
            },
          ]
        : []),
      ...(target === "agent"
        ? [
            {
              name: "agent typecheck",
              cwd,
              executable: "uv",
              args: ["run", "--frozen", "pyright"],
            },
          ]
        : []),
      ...(target === "loader"
        ? ["tide-load", "tide-load-delta"].map((command) => ({
            name: `${command} entry point`,
            cwd,
            executable: "uv",
            args: ["run", "--frozen", command, "--help"],
          }))
        : []),
      {
        name: `${target} tests`,
        cwd,
        executable: "uv",
        args: ["run", "--frozen", "python", "-m", "pytest", "-q"],
      },
    ];
  });
}

async function dependencies() {
  try {
    const [{ default: spawn }, { default: kill }] = await Promise.all([
      import("cross-spawn"),
      import("tree-kill"),
    ]);
    return { spawn, kill };
  } catch {
    throw new Error(
      "Root command dependencies are missing. Run npm ci from the repository root.",
    );
  }
}

export async function runCommand(task, env, spawnProcess) {
  const spawn = spawnProcess || (await dependencies()).spawn;
  console.log(`[tide] ${task.name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(task.executable, task.args, {
      cwd: task.cwd,
      env,
      stdio: "inherit",
    });
    child.once("error", () =>
      reject(
        new Error(
          `${task.name}: could not launch ${path.basename(task.executable)}. Check that it is installed and on PATH.`,
        ),
      ),
    );
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${task.name} failed (${signal || code}).`)),
    );
  });
}

export async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is unavailable. Choose another port in .env, or run npm start -- --force to stop the processes holding it.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function listeningPids(port) {
  try {
    return execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "--force needs lsof to find the processes holding the ports.",
      );
    // lsof exits 1 when no process matches.
    return [];
  }
}

export async function freePort(port) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const pids = listeningPids(port);
    if (!pids.length) return;
    for (const pid of pids) {
      console.log(`[tide] --force: ${signal} to PID ${pid} on port ${port}`);
      try {
        process.kill(pid, signal);
      } catch {}
    }
    for (let i = 0; i < 25 && listeningPids(port).length; i++) await delay(200);
  }
}

export function sourceLoadTask(config, root = ROOT) {
  return {
    name: "verified source-only intake (no prepared demo results)",
    executable: "uv",
    cwd: root,
    args: [
      "run",
      "--project",
      projectDirectory(root, "loader"),
      "--frozen",
      "tide-load",
      config.source,
      "--db",
      config.database,
      "--source-system",
      config.env.TIDE_SOURCE_SYSTEM || "local-demo",
      ...(config.env.TIDE_AS_OF ? ["--as-of", config.env.TIDE_AS_OF] : []),
    ],
  };
}

function predictionsTask(config, command) {
  return {
    name: `${command} stored predictions`,
    executable: "uv",
    cwd: ROOT,
    args: [
      "run",
      "--project",
      projectDirectory(ROOT, "loader"),
      "--frozen",
      "python",
      path.join(ROOT, "scripts", "predictions.py"),
      command,
      config.database,
      path.join(config.source, PREDICTIONS),
    ],
  };
}

async function loadSource(config) {
  if (!fs.existsSync(path.join(config.source, "manifest.json")))
    throw new Error("The configured source directory has no manifest.json.");
  if (!fs.existsSync(config.database)) {
    fs.mkdirSync(path.dirname(config.database), { recursive: true });
    await runCommand(
      {
        name: "deploy fresh src CAP database",
        executable: process.execPath,
        args: [
          localTool("@sap/cds-dk", "cds"),
          "deploy",
          "--to",
          `sqlite:${config.database}`,
        ],
        cwd: CAP,
      },
      config.env,
    );
  }
  await runCommand(sourceLoadTask(config), config.env);
  if (/^(1|true)$/i.test(config.env.TIDE_RECOMPUTE || ""))
    console.log(
      "[tide] TIDE_RECOMPUTE set: stored predictions are ignored; startup calls the live prediction provider.",
    );
  else if (
    fs.existsSync(path.join(config.source, PREDICTIONS, "manifest.json"))
  )
    await runCommand(predictionsTask(config, "import"), config.env);
}

async function exportSeed(config) {
  if (!fs.existsSync(config.database))
    throw new Error("No loaded database at TIDE_DB. Run npm start first.");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(config.database, { readOnly: true });
  try {
    const published = database
      .prepare(
        "SELECT s.ID FROM tide_cockpit_PublishedCockpit p " +
          "JOIN tide_cockpit_Snapshot s ON s.ID = p.snapshot_ID AND s.status = 'done' " +
          "JOIN tide_s4_DatasetInfo d ON d.ID = 'current' AND d.loadId = s.loadId " +
          "WHERE p.ID = 'current'",
      )
      .get();
    if (!published)
      throw new Error(
        "No published preparation for the loaded source. Let npm start finish preparing first.",
      );
  } finally {
    database.close();
  }
  await runCommand(predictionsTask(config, "export"), config.env);
}

// "stored-predictions" is the createdBy marker set by scripts/predictions.py import.
export function predictionSources(database, snapshot) {
  const { stored, total } = database
    .prepare(
      "SELECT count(*) total, coalesce(sum(createdBy = 'stored-predictions'), 0) stored " +
        "FROM tide_core_PredictionRun WHERE ID IN (SELECT value FROM json_each(?))",
    )
    .get(snapshot.runs || "[]");
  return { stored, live: total - stored };
}

export async function waitForPreparation(config, stopping = () => false) {
  const timeout = Number(config.env.TIDE_PREPARE_TIMEOUT_MS || 3_600_000);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("TIDE_PREPARE_TIMEOUT_MS must be a positive number.");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(config.database, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const source = database
      .prepare("SELECT loadId FROM tide_s4_DatasetInfo WHERE ID='current'")
      .get();
    if (!source?.loadId)
      throw new Error("No loaded source is available for preparation.");
    console.log(
      "[tide] preparing source data; missing estimates use the configured live prediction provider.",
    );
    const deadline = Date.now() + timeout;
    while (!stopping() && Date.now() < deadline) {
      const current = database
        .prepare("SELECT loadId FROM tide_s4_DatasetInfo WHERE ID='current'")
        .get();
      if (current?.loadId !== source.loadId)
        throw new Error(
          "Source changed while waiting for preparation; restart with a stable source.",
        );
      const columns =
        "s.status, s.startedAt, s.publishedAt, s.completeness, s.modelCalls, s.runs, s.message";
      const real =
        "s.loadId = ? AND (s.message IS NULL OR s.message NOT LIKE 'dry run%')";
      const running = database
        .prepare(
          `SELECT 1 FROM tide_cockpit_Snapshot s WHERE ${real} AND s.status = 'running'`,
        )
        .get(source.loadId);
      const snapshot = running
        ? null
        : database
            .prepare(
              `SELECT ${columns} FROM tide_cockpit_PublishedCockpit p ` +
                `JOIN tide_cockpit_Snapshot s ON s.ID = p.snapshot_ID AND s.status = 'done' AND ${real} ` +
                "WHERE p.ID = 'current'",
            )
            .get(source.loadId);
      if (snapshot) {
        const { stored, live } = predictionSources(database, snapshot);
        console.log(
          `[tide] source prepared (published ${snapshot.publishedAt}): ${snapshot.completeness}. ` +
            `Predictions: ${stored} from stored, ${live} computed live.`,
        );
        if (snapshot.completeness !== "complete")
          console.warn(
            `[tide] preparation has unavailable or failed estimates: ${snapshot.message || "inspect preparation phases and evidence"}`,
          );
        return;
      }
      const failed = running
        ? null
        : database
            .prepare(
              `SELECT s.message FROM tide_cockpit_Snapshot s WHERE ${real} AND s.status = 'failed' ` +
                "ORDER BY s.startedAt DESC LIMIT 1",
            )
            .get(source.loadId);
      if (failed)
        throw new Error(
          `Source preparation failed: ${failed.message || "unknown error"}`,
        );
      await delay(500);
    }
    if (!stopping())
      throw new Error(
        "Source preparation timed out; inspect the snapshot and prediction runs before retrying.",
      );
  } finally {
    database.close();
  }
}

async function waitForReady(service, stopping) {
  const deadline = Date.now() + 90_000;
  while (!stopping() && Date.now() < deadline) {
    try {
      const response = await fetch(service.url, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  if (!stopping())
    throw new Error(`${service.name} was not ready within 90 seconds.`);
}

export async function supervise(services, env, options = {}) {
  const { spawn, kill } = await dependencies();
  const children = [];
  let stopping = false;
  let finish, fail;
  const completed = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const stopChild = async (child) => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    const closed = new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => kill(child.pid, "SIGTERM", resolve));
    const exited = await Promise.race([
      closed.then(() => true),
      delay(5000, false, { ref: false }),
    ]);
    if (!exited)
      await new Promise((resolve) => kill(child.pid, "SIGKILL", resolve));
  };
  const stop = async (error) => {
    if (stopping) return;
    stopping = true;
    await Promise.all(children.map(stopChild));
    if (error) fail(error);
    else finish();
  };
  const interrupt = () => {
    void stop();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (const service of services) {
      console.log(`[tide] starting ${service.name}`);
      const child = spawn(service.executable, service.args, {
        cwd: service.cwd,
        env: service.env || env,
        stdio: "inherit",
      });
      children.push(child);
      child.once("error", () => {
        void stop(new Error(`Could not start ${service.name}.`));
      });
      child.once("exit", (code, signal) => {
        if (!stopping)
          void stop(
            new Error(
              `${service.name} exited (${signal || code}); stopping the application.`,
            ),
          );
      });
      await Promise.race([
        (options.waitForReady || waitForReady)(service, () => stopping),
        completed,
      ]);
      if (stopping) break;
    }
    await Promise.race([
      !stopping && options.afterReady
        ? options.afterReady(() => stopping)
        : Promise.resolve(),
      completed,
    ]);
    if (!stopping)
      console.log(
        `[tide] ready: ${options.applicationUrl || "services running"}. Press Ctrl+C to stop.`,
      );
    await completed;
  } catch (error) {
    await stop(error);
    await completed;
  } finally {
    await Promise.all(children.map(stopChild));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export function parseCommand(args) {
  const [command, ...options] = args;
  if (options.includes("--help") || command === "--help")
    return { command: "help", options: [] };
  if (!COMMANDS.includes(command))
    throw new Error(`Unknown command: ${command ?? "(missing)"}. Use --help.`);
  return { command, options };
}

export function printHelp() {
  console.log(
    "cbs TIDE root commands: setup, doctor, start, test, data:load, data:seed, data:pack",
  );
  console.log("setup: frozen installs and assistant build; preserves .env.");
  console.log(
    "doctor: local prerequisites/configuration checks; no provider calls.",
  );
  console.log(
    "start: verified source intake, automatic prediction preparation, and foreground services; Ctrl+C stops children.",
  );
  console.log(
    "start --force: first stop the processes listening on the configured service ports.",
  );
  console.log(
    `test [targets]: ${TEST_TARGETS.join(", ")}; defaults to all targets.`,
  );
  console.log(
    "data:load: source-only intake into the src model; no model calls. data:pack remains reserved.",
  );
  console.log(
    `data:seed: export the TabPFN predictions of TIDE_DB to <dataset>/${PREDICTIONS}/*.parquet; start reuses them.`,
  );
  console.log(
    "TIDE_RECOMPUTE=1 npm start: ignore stored predictions and recompute them with the live provider.",
  );
}

async function main() {
  const { command, options } = parseCommand(process.argv.slice(2));
  if (command === "help") return printHelp();
  if (command === "data:pack")
    throw new Error(
      `${command} is reserved, not implemented. Strict manifest validation and source-only archive handling must be completed first. No data was modified.`,
    );
  const allowed = command === "start" ? ["--force"] : [];
  if (command !== "test" && options.some((option) => !allowed.includes(option)))
    throw new Error(`${command} does not accept these options. Use --help.`);
  // `npm start --force` is consumed by npm itself and arrives as npm_config_force.
  const force =
    command === "start" &&
    (options.includes("--force") || process.env.npm_config_force === "true");
  const env = loadEnvironment();
  if (command === "setup") {
    for (const task of setupPlan()) await runCommand(task, env);
    ensureEnvironmentFile();
    const seed = path.join(
      path.resolve(ROOT, env.TIDE_DATASET || "data/demo"),
      PREDICTIONS,
      "manifest.json",
    );
    console.log(
      fs.existsSync(seed)
        ? `[tide] stored predictions found (${path.relative(ROOT, seed)}); npm start reuses them. Set TIDE_RECOMPUTE=1 to recompute.`
        : `[tide] no stored predictions at ${path.relative(ROOT, seed)}; npm start computes them with the live provider.`,
    );
    console.log(
      "[tide] setup complete; .env preserved or created. Configure credentials, then npm run doctor.",
    );
    return;
  }
  if (command === "test") {
    // Offline tests never see .env or provider credentials.
    const testEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/(API_KEY|CLIENT_SECRET)$/.test(name),
        ),
      ),
      CDS_ENV: "test",
      CDS_TYPESCRIPT: "true",
      LLM_FAKE: "1",
      TABULAR_BACKEND: "fake",
      TIDE_AUTO_PREPARE: "0",
      TIDE_DEMO_PRIORITY_HISTORY: "0",
    };
    for (const task of testPlan(options)) await runCommand(task, testEnv);
    return;
  }
  const config = configuration(env);
  if (command === "data:load") {
    await loadSource(config);
    return;
  }
  if (command === "data:seed") {
    await exportSeed(config);
    return;
  }
  validateLiveConfiguration(config.env);
  if (command === "start" && /(^|,)test($|,)/.test(config.env.CDS_ENV || ""))
    throw new Error(
      "npm start cannot use CDS_ENV=test because that profile disables automatic preparation.",
    );
  await runCommand(
    {
      name: "uv prerequisite",
      executable: "uv",
      args: ["--version"],
      cwd: ROOT,
    },
    config.env,
  );
  if (command === "start")
    await runCommand(
      setupPlan().find((task) => task.name === "assistant bundle"),
      config.env,
    );
  const serve = localTool("@sap/cds-dk", "cds-tsx");
  if (!fs.existsSync(path.join(config.source, "manifest.json")))
    throw new Error(
      "The configured source directory has no manifest.json. Source data must be supplied separately.",
    );
  if (command === "doctor" && !fs.existsSync(config.database))
    throw new Error(
      "No loaded database at TIDE_DB. Run npm run data:load first.",
    );
  if (command === "doctor")
    await runCommand(
      {
        name: "loaded dataset marker",
        executable: "uv",
        cwd: ROOT,
        args: [
          "run",
          "--project",
          projectDirectory(ROOT, "loader"),
          "--frozen",
          "--no-sync",
          "python",
          "-c",
          "import sqlite3,sys; from pathlib import Path; db=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); row=db.execute(\"SELECT 1 FROM tide_s4_DatasetInfo WHERE ID='current' AND asOf IS NOT NULL\").fetchone(); db.close(); sys.exit(0 if row else 1)",
          config.database,
        ],
      },
      config.env,
    );
  if (command === "doctor") {
    console.log(
      `[tide] local checks passed. Ports: CAP ${config.ports.cap}, tabular ${config.ports.tabular}, agent ${config.ports.agent}, gateway ${config.ports.gateway}.`,
    );
    console.log(
      "[tide] DatasetInfo exists; this does not certify complete source ingestion or live-provider connectivity.",
    );
    return;
  }
  for (const port of Object.values(config.ports)) {
    if (force) await freePort(port);
    await assertPortAvailable(port);
  }
  await loadSource(config);
  fs.mkdirSync(path.dirname(config.env.CHECKPOINT_DB), { recursive: true });
  const python = (name) =>
    name === "agent/gateway"
      ? path.join(projectDirectory(ROOT, "agent"), "gateway")
      : projectDirectory(ROOT, name);
  const callerEnv = Object.fromEntries(
    Object.entries(config.env).filter(
      ([key]) => !key.startsWith("GATEWAY_") && !key.startsWith("AGENT_MODEL"),
    ),
  );
  const gatewayEnv = Object.fromEntries(
    Object.entries(config.env).filter(
      ([key]) =>
        !key.startsWith("AGENT_MODEL") &&
        !key.startsWith("PRIORLABS_") &&
        !key.startsWith("AICORE_"),
    ),
  );
  const agentEnv = {
    ...Object.fromEntries(
      Object.entries(callerEnv).filter(
        ([key]) =>
          !key.startsWith("PRIORLABS_") &&
          !key.startsWith("AICORE_") &&
          key !== "TABULAR_INTERNAL_TOKEN" &&
          key !== "CDS_REQUIRES_TABULAR_CREDENTIALS_TOKEN",
      ),
    ),
    LLM_FAKE: "0",
    AGENT_MODEL: "openai/agent-reasoning",
    AGENT_MODEL_API_BASE: `http://127.0.0.1:${config.ports.gateway}/v1`,
    AGENT_MODEL_API_KEY: config.env.GATEWAY_AGENT_KEY,
    AGENT_MODEL_API_VERSION: "",
  };
  await supervise(
    [
      {
        name: "gateway",
        executable: "uv",
        args: [
          "run",
          "--frozen",
          "litellm",
          "--config",
          "config.yaml",
          "--host",
          "127.0.0.1",
          "--port",
          String(config.ports.gateway),
        ],
        cwd: python("agent/gateway"),
        env: gatewayEnv,
        url: `http://127.0.0.1:${config.ports.gateway}/health/liveliness`,
      },
      {
        name: "tabular",
        executable: "uv",
        args: ["run", "--project", python("tabular"), "--frozen", "tabular"],
        cwd: ROOT,
        url: `http://127.0.0.1:${config.ports.tabular}/health`,
        env: callerEnv,
      },
      {
        name: "CAP",
        executable: process.execPath,
        args: ["--import", "tsx", serve, "serve", "all"],
        cwd: CAP,
        url: `${config.capUrl}/tide.cockpit/index.html`,
        env: { ...callerEnv, CAP_LLM_API_KEY: config.env.GATEWAY_CAP_KEY },
      },
      {
        name: "agent",
        executable: "uv",
        args: [
          "run",
          "--project",
          python("agent"),
          "--frozen",
          "python",
          "-m",
          "agent.api.app",
        ],
        cwd: ROOT,
        url: `http://127.0.0.1:${config.ports.agent}/healthz`,
        env: agentEnv,
      },
    ],
    config.env,
    {
      applicationUrl: `${config.capUrl}/tide.cockpit/index.html`,
      afterReady: (stopping) => waitForPreparation(config, stopping),
    },
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[tide] ${error.message}`);
    process.exitCode = 1;
  });
}
