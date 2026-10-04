// Threshold calibration of the free-text codes (P-14), run against a running
// cockpit: one model call per calibrated field and segment on a holdout
// (youngest 30 %, at most 1,000, at least 50 rows; train sample 250). The
// threshold is the lowest certainty at which the accepted holdout rows reach
// the target (0.95) on the one-sided Wilson lower bound (z 1.645), with at
// least 50 accepted rows. CAP stores it with the holdout scores (entity
// FreetextThreshold) and restatuses the stored proposals.
//
//   npx tsx srv/cockpit/freetext/calibrate.ts [--dry|--dry-run] [--url http://localhost:4664] --user <user:password>  (or TIDE_AUTH)
//
// --dry counts the planned calls and their cost (tabular dry run, kernel
// estimate) and writes nothing. scripts/calibrate wraps this against a DB.
import { cockpitCliTarget } from "../../core/config";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cliTarget = cockpitCliTarget();
const url = opt("--url", cliTarget.url).replace(/\/$/, "");
const user = opt("--user", cliTarget.auth);
const dryRun = args.includes("--dry") || args.includes("--dry-run");

async function main() {
  if (!user.includes(":"))
    throw new Error(
      "Credentials required: pass --user <user:password> or set TIDE_AUTH",
    );
  const res = await fetch(`${url}/odata/v4/desk/calibrateFreetext`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(user).toString("base64")}`,
    },
    body: JSON.stringify({ dryRun }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      `calibrateFreetext: HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`,
    );
  for (const t of body.value ?? [])
    console.log(
      `${t.field}|${t.segment}: threshold ${t.threshold ?? "none"}, accuracy at threshold ${t.accuracyAtThreshold ?? "–"}, ` +
        `holdout ${t.holdoutRows}, train ${t.trainRows}, coverage ${t.coverage ?? "–"}${t.reason ? ` (${t.reason})` : ""}`,
    );
  if (!body.value?.length)
    console.log("no segment to calibrate (no coded free-text requests)");
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
