// What the home page and the README say about the SYNTHETIC records comes from the checks, not from a typed claim:
// docs/synthetic_check.json (scripts/synthetic_compare.py, re-checked by test/gate.test.ts) and, for the public files,
// docs/scan_identity_result.json (scripts/scan_identity.py on the build machine).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f: string) => (existsSync(path.join(ROOT, f)) ? JSON.parse(readFileSync(path.join(ROOT, f), "utf8")) : undefined);

export function syntheticSentence(): string {
  const s = read("docs/synthetic_check.json"), p = read("docs/scan_identity_result.json");
  if (!s) return "The check of the synthetic records has not been run (python -I scripts/synthetic_compare.py --write).";
  const cs = Object.values(s.companies) as { rows: number; max_shared: number; rows_sharing_2_or_more: number; invented_plants: number; invented_plants_at_a_real_address_or_zip: string[] }[];
  const rows = cs.reduce((a, c) => a + c.rows, 0), plants = cs.reduce((a, c) => a + c.invented_plants, 0);
  const fail = cs.reduce((a, c) => a + c.rows_sharing_2_or_more, 0), pf = cs.reduce((a, c) => a + c.invented_plants_at_a_real_address_or_zip.length, 0);
  const pub = p?.synthetic_max_shared_fields as Record<string, number> | undefined;
  return `Checked, not assumed: ${fail} of ${rows} synthetic rows share two or more fields (house number and state, case number, job title, page, date, a 5-word run of narrative) with a real row of the sample, `
    + `and ${pf} of ${plants} invented plants have a real plant's house number and state or ZIP (scripts/synthetic_compare.py, test/gate.test.ts)`
    + (pub ? `; against the public OSHA file and the ITA cases, with the date shift and state swap undone, the most fields any synthetic row shares with one public record is ${Math.max(...Object.values(pub))} (scripts/scan_identity.py, ${p.synthetic_rows_derived} failing)` : "")
    + ".";
}

/** the same check, run once on the previous version's synthetic rows (edited from real cases): it catches them */
export function previousSentence(): string {
  const o = read("docs/synthetic_check_previous_rows.json");
  if (!o) return "";
  const sum = (x: Record<string, Record<string, number>>, k: string) => Object.values(x).reduce((a, v) => a + (v[k] ?? 0), 0);
  return `Run once on the previous version's synthetic rows, which were edited from real cases, the same check flags ${sum(o.sample, "rows_sharing_2_or_more")} of ${sum(o.sample, "rows")} rows against the sample, `
    + `${sum(o.public, "rows_sharing_2_or_more")} against the public files, and ${sum(o.sample, "invented_plants_at_a_real_address_or_zip")} of ${sum(o.sample, "invented_plants")} invented plants at a real plant's house number and state or ZIP (docs/synthetic_check_previous_rows.json).`;
}
