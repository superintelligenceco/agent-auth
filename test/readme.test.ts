// Replays the "See it work" session from README.md against a real server and compares the output,
// so the README cannot drift from what the CLI prints.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, runServer } from "../src/run.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const ADMIN = "readme-admin-token-0123456789";
const SEP = "@@readme-step@@";
// Absolute, because the session runs in a temporary directory outside the project.
const TSX = import.meta.resolve("tsx");

interface Step {
  command: string;
  expected: string;
}

/** Splits the console blocks of a README section into commands and their expected output. */
function consoleSteps(section: string): Step[][] {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const start = readme.indexOf(`## ${section}`);
  const body = readme.slice(start, readme.indexOf("\n## ", start + 3));
  return [...body.matchAll(/```console\n([\s\S]*?)```/g)].map(([, block]) => {
    const steps: Step[] = [];
    let current: Step | undefined;
    let continuing = false;
    for (const line of (block ?? "").trimEnd().split("\n")) {
      if (line.startsWith("$ ")) {
        current = { command: line.slice(2), expected: "" };
        steps.push(current);
      } else if (current && continuing) {
        current.command += `\n${line}`;
      } else if (current) {
        current.expected += `${line}\n`;
      }
      continuing = line.endsWith("\\") || (current?.command.split('"').length ?? 1) % 2 === 0;
    }
    return steps;
  });
}

function normalize(text: string): string {
  return text
    .replace(/\b(tk|gr)_[A-Za-z0-9_-]{16}/g, "$1_<id>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
    .replace(/\b\d\d:\d\d:\d\d\b/g, "<hh:mm:ss>")
    .replace(/\b[0-9a-f]{64}\b/g, "<hash>")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

const execFileAsync = promisify(execFile);

// The server runs in this process, so the session must run asynchronously: a synchronous spawn
// blocks the event loop and the server never answers the CLI.
async function replay(steps: Step[], cwd: string, url: string): Promise<string[]> {
  const script = [
    `agent-auth() { "${process.execPath}" --import "${TSX}" "${CLI}" "$@"; }`,
    ...steps.map((s) => `${s.command} 2>&1\necho "${SEP}"`),
  ].join("\n");
  const { stdout: out } = await execFileAsync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AGENT_AUTH_URL: url,
      AGENT_AUTH_ADMIN_TOKEN: ADMIN,
      NODE_OPTIONS: "",
    },
  });
  return out.split(`${SEP}\n`).slice(0, steps.length);
}

const hasBash = process.platform !== "win32";
const hasSqlite = hasBash && spawnSync("sqlite3", ["-version"]).status === 0;

describe.skipIf(!hasBash)("README 'See it work' session", () => {
  let dir: string;
  let srv: RunningServer;
  const [session = [], tamper = []] = consoleSteps("See it work");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-auth-readme-"));
    mkdirSync(join(dir, "data"));
    srv = await runServer({
      dbPath: join(dir, "data", "agent-auth.db"),
      keyPath: join(dir, "data", "signing-key.pem"),
      adminToken: ADMIN,
      port: 0,
    });
  });

  afterAll(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the session in the README", () => {
    expect(session.length).toBeGreaterThan(10);
    expect(tamper.length).toBe(2);
  });

  it("prints what the README shows", async () => {
    const outputs = await replay(session, dir, srv.url);
    session.forEach((step, i) => {
      expect(normalize(outputs[i] ?? ""), step.command).toBe(normalize(step.expected));
    });
  });

  it.skipIf(!hasSqlite)("detects the tampering the README shows", async () => {
    const outputs = await replay(tamper, dir, srv.url);
    tamper.forEach((step, i) => {
      expect(normalize(outputs[i] ?? ""), step.command).toBe(normalize(step.expected));
    });
  });
});
