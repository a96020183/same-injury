// L1 entities and aliases, built on the World Model in index.ts.
//   site            : ITA establishment, external key site:ita:<establishment_id>; alias = company name; attrs hold EIN, zip, street.
//   employer-name   : how other agencies name the employer (SIR employer string, DOL inspection establishment name); name-derived ID.
//   report          : SIR severe injury report, external key report:sir:<ID>, edge reported-by -> employer-name.
//   inspection      : DOL inspection, external key inspection:dol:<activity_nr>, edge inspected -> employer-name.
// Every merge goes to the operator queue (resolver autoMergeAt=Infinity, reviewLower=0.85); takes effect only after human approval.
import { WorldModel } from "./index.ts";

export const L1_RESOLVER = { autoMergeAt: Number.POSITIVE_INFINITY, reviewLower: 0.85 };
export const newL1World = (clock?: () => Date) => new WorldModel({ namespace: "l1", resolver: L1_RESOLVER, clock });

export type ItaSite = { establishment_id: string; name: string; company?: string; ein: string; zip: string; street: string; streetno?: string };

export async function importIta(w: WorldModel, rows: ItaSite[], year: number) {
  const source = { kind: "file", by: `ita-${year}`, at: `${year + 1}-03-02T00:00:00.000Z` };
  for (const r of rows) {
    await w.upsertEntity({ type: "site", externalKey: { system: "ita", id: r.establishment_id }, name: r.name,
      aliases: r.company ? [r.company] : [], attrs: { ein: r.ein, zip: r.zip, street: r.street, [`filed${year}`]: true }, source });
  }
}

/** Renumbered: same EIN + zip + street number, different establishment_id -> propose merge (not automatic). */
export async function proposeRenumbered(w: WorldModel, rows2025: ItaSite[]) {
  const key = (e: { attrs: Record<string, unknown> }) => {
    const m = String(e.attrs.street ?? "").match(/^\s*(\d+)/);
    return `${e.attrs.ein}|${e.attrs.zip}|${m ? m[1] : ""}`;
  };
  const sites = w.query("site");
  const out = [];
  for (const r of rows2025) {
    const id = `site:ita:${r.establishment_id}`;
    const me = w.entity(id);
    if (!me) continue;
    const k = key(me);
    if (k.split("|").some((x) => !x)) continue;
    const older = sites.find((s) => s.id !== me.id && key(s) === k && s.attrs.filed2024 && !s.attrs.filed2025);
    if (older) out.push(await w.proposeMerge(me.id, older.id, "same EIN + zip + street number; establishment_id changed in 2025",
      { kind: "agent", by: "linker", at: "2026-03-02T00:00:00.000Z" }));
  }
  return out.filter(Boolean);
}

export async function importSirReport(w: WorldModel, r: { sir_id: string; employer: string; zip: string; event_date: string; amputation: boolean }) {
  const source = { kind: "file", by: "sir", at: new Date(r.event_date).toISOString() };
  const emp = await w.upsertEntity({ type: "employer-name", name: r.employer, attrs: { zip: r.zip }, source });
  const rep = await w.upsertEntity({ type: "report", externalKey: { system: "sir", id: r.sir_id }, name: `SIR ${r.sir_id}`,
    attrs: { event_date: r.event_date, amputation: r.amputation }, source });
  await w.relate({ from: rep.id, type: "reported-by", to: emp.id, source });
  return { emp, rep };
}

export async function importDolInspection(w: WorldModel, r: { activity_nr: number; estab_name: string; zip: string; open_date: string }) {
  const source = { kind: "api", by: "dol-v4", at: `${r.open_date}T00:00:00.000Z` };
  const emp = await w.upsertEntity({ type: "employer-name", name: r.estab_name, attrs: { zip: r.zip }, source });
  const ins = await w.upsertEntity({ type: "inspection", externalKey: { system: "dol", id: String(r.activity_nr) }, name: `Inspection ${r.activity_nr}`,
    attrs: { open_date: r.open_date }, source });
  await w.relate({ from: ins.id, type: "inspected", to: emp.id, source });
  return { emp, ins };
}

/** Conclusion: how many SIR amputation reports and DOL inspections a site has (approved aliases only). */
export function siteConclusion(w: WorldModel, siteId: string) {
  const site = w.entity(siteId)!;
  const names = w.query("employer-name").filter((e) => w.entity(e.id)!.id === site.id);
  const reports = w.incoming(site.id, "reported-by").map((e) => e.from).sort();
  const inspections = w.incoming(site.id, "inspected").map((e) => e.from).sort();
  return { site: site.id, aliases: site.aliases, reports, inspections, viaNames: names.length };
}
