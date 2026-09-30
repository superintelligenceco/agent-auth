#!/usr/bin/env node
// Prints coverage/coverage-summary.json as a Markdown table for the GitHub job summary.
// With --badge <file>, also writes a shields.io endpoint JSON for the line coverage.
import { readFileSync, writeFileSync } from "node:fs";

const { total } = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const rows = ["lines", "statements", "functions", "branches"].map(
  (k) => `| ${k} | ${total[k].pct.toFixed(1)}% | ${total[k].covered}/${total[k].total} |`,
);
console.log(
  ["### Coverage", "", "| Metric | Covered | Count |", "| --- | --- | --- |", ...rows].join("\n"),
);

const i = process.argv.indexOf("--badge");
if (i !== -1) {
  const pct = total.lines.pct;
  const color = pct >= 90 ? "brightgreen" : pct >= 80 ? "green" : pct >= 70 ? "yellow" : "red";
  const badge = { schemaVersion: 1, label: "coverage", message: `${pct.toFixed(0)}%`, color };
  writeFileSync(process.argv[i + 1], `${JSON.stringify(badge)}\n`);
}
