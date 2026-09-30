// Benchmarks the scope engine, which runs on every /v1/check and every attenuation.
//
//   npm run bench            compare with bench/baseline.json, fail on a >2x slowdown
//   npm run bench -- --update  rewrite bench/baseline.json
//
// Throughput is reported relative to a fixed calibration loop, so a baseline recorded on one
// machine stays meaningful on a faster or slower one.
import { readFileSync, writeFileSync } from "node:fs";
import { checkAttenuation, evaluate, globMatch, parseScope } from "../src/scope/index.js";

const BASELINE = new URL("./baseline.json", import.meta.url);
const MAX_SLOWDOWN = 2;
const SAMPLES = 7;
const SAMPLE_MS = 150;

const scopes = [
  "gmail:send to:*@acme.com",
  "github:repo:read acme/*",
  "payments:charge max=50USD",
  "calendar:* primary",
].map(parseScope);
const parent = ["gmail:* to:*@acme.com", "github:repo:* acme/*", "payments:charge max=100USD"];
const child = ["gmail:send to:*@acme.com", "github:repo:read acme/widgets"];

let sink = 0;
const cases: Record<string, () => void> = {
  calibration: () => {
    let h = 0;
    for (let i = 0; i < 200; i++) h = (h * 31 + i) | 0;
    sink ^= h;
  },
  parseScope: () => {
    sink ^= parseScope("payments:charge max=50USD merchant:stripe-*").params ? 1 : 0;
  },
  "evaluate allow": () => {
    sink ^= evaluate(scopes, { action: "github:repo:read", resource: "acme/widgets" }).reason
      .length;
  },
  "evaluate deny": () => {
    sink ^= evaluate(scopes, { action: "gmail:send", params: { to: "eve@evil.example" } }).reason
      .length;
  },
  checkAttenuation: () => {
    sink ^= checkAttenuation(child, parent).ok ? 1 : 0;
  },
  globMatch: () => {
    sink ^= globMatch("*@acme.*.com", "someone.long.name@acme.mail.example.com") ? 1 : 0;
  },
};

function measure(fn: () => void): number {
  let n = 0;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < SAMPLE_MS) {
    for (let i = 0; i < 100; i++) fn();
    n += 100;
    elapsed = performance.now() - start;
  }
  return (n / elapsed) * 1000;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const { calibration: calibrate, ...benchmarks } = cases;
if (!calibrate) throw new Error("missing calibration case");
for (const fn of Object.values(cases)) measure(fn); // warm up the JIT

// Each sample times the calibration loop right before the case, so both see the same machine load.
const raw: Record<string, number> = {};
const relative: Record<string, number> = {};
for (const [name, fn] of Object.entries(benchmarks)) {
  const ops: number[] = [];
  const ratios: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const c = measure(calibrate);
    const o = measure(fn);
    ops.push(o);
    ratios.push(o / c);
  }
  raw[name] = median(ops);
  relative[name] = median(ratios);
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(relative, null, 2)}\n`);
  console.log(`wrote ${BASELINE.pathname}`);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
let failed = false;
const lines = ["| Benchmark | ops/s | vs baseline |", "| --- | ---: | ---: |"];
for (const [name, rel] of Object.entries(relative)) {
  const base = baseline[name];
  const ratio = base ? rel / base : 1;
  const slow = ratio < 1 / MAX_SLOWDOWN;
  failed ||= slow;
  lines.push(
    `| ${name} | ${Math.round(raw[name] ?? 0).toLocaleString("en-US")} | ${ratio.toFixed(2)}x${slow ? " (regression)" : ""} |`,
  );
}
console.log(lines.join("\n"));
if (sink === 0.5) console.log(sink);
if (failed) {
  console.error(`\nA benchmark is more than ${MAX_SLOWDOWN}x slower than bench/baseline.json.`);
  process.exit(1);
}
