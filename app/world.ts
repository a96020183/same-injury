// Shared state for all agents = the Meterless World Model engine (engine/world-model, conformance 8/8).
// Identity across agencies is never asserted by an agent: it is a merge proposal in the operator queue, and a
// conclusion only uses it after a person approves. Unapproved proposals change nothing that is read.
import { WorldModel, type MergeProposal } from "../engine/world-model/index.ts";
import { L1_RESOLVER } from "../engine/world-model/l1world.ts";
import { streetNumber, zip5 } from "./rules.ts";

export type Site = { code: string; plant_name: string; legal_name: string; street: string; city: string; state: string; zip: string; ein: string; group: string };
export type LogCase = { key: string; group: string; source: string; case_id: string; site: string; date: string; body: string; text: string };
export type SirReport = { id: string; upa: string; date: string; employer: string; street: string; city: string; state: string; zip: string;
  amputation: boolean; hospitalized?: boolean; body: string; text: string; inspection: string };

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const employerKey = (name: string, zip: string, street: string) => `${norm(name)}|${zip5(zip)}|${streetNumber(street)}`;

export class L1World {
  readonly wm = new WorldModel({ namespace: "l1-same-injury", resolver: L1_RESOLVER });

  async addSite(s: Site) {
    return this.wm.upsertEntity({ type: "site", externalKey: { system: "plant", id: s.code }, name: s.plant_name, aliases: [s.legal_name],
      attrs: { street: s.street, city: s.city, state: s.state, zip: zip5(s.zip), ein: s.ein, group: s.group },
      source: { kind: "zetaris", by: "usl.site", at: "2025-03-02T00:00:00.000Z" } });
  }
  async addLogCase(c: LogCase) {
    const src = { kind: "zetaris", by: c.source, at: `${c.date}T00:00:00.000Z` };
    const e = await this.wm.upsertEntity({ type: "log-case", externalKey: { system: "log", id: c.key }, name: `${c.site} case ${c.case_id}`,
      attrs: { date: c.date, site: c.site, group: c.group, ...(c.body && !this.wm.entity(`log-case:log:${c.key}`)?.attrs.form301 ? { body: c.body } : {}) }, source: src }); // the paper form (Reader) wins over the typed body
    await this.wm.relate({ from: e.id, type: "recorded-at", to: `site:plant:${c.site}`, source: src });
    return e;
  }
  async addReport(r: SirReport) {
    const src = { kind: "zetaris", by: "osha_severe_injury_reports", at: `${r.date}T00:00:00.000Z` };
    const emp = await this.wm.upsertEntity({ type: "osha-employer", externalKey: { system: "sir-employer", id: employerKey(r.employer, r.zip, r.street) },
      name: r.employer, attrs: { street: r.street, city: r.city, state: r.state, zip: zip5(r.zip) }, source: src });
    const rep = await this.wm.upsertEntity({ type: "report", externalKey: { system: "sir", id: r.id }, name: `OSHA report ${r.id}`,
      attrs: { date: r.date, upa: r.upa, amputation: r.amputation }, source: src });
    await this.wm.relate({ from: rep.id, type: "filed-by", to: emp.id, source: src });
    return { emp, rep };
  }
  async addInspection(activity: string, estab: string, street: string, zip: string, openDate: string, reportId?: string) {
    const src = { kind: "zetaris", by: "dol.inspection", at: `${openDate || "2024-01-01"}T00:00:00.000Z` };
    const est = await this.wm.upsertEntity({ type: "dol-establishment", externalKey: { system: "dol-estab", id: employerKey(estab, zip, street) },
      name: estab, attrs: { street, zip: zip5(zip) }, source: src });
    const ins = await this.wm.upsertEntity({ type: "inspection", externalKey: { system: "dol", id: activity }, name: `DOL inspection ${activity}`,
      attrs: { open_date: openDate }, source: src });
    await this.wm.relate({ from: ins.id, type: "of", to: est.id, source: src });
    if (reportId) await this.wm.relate({ from: `report:sir:${reportId}`, type: "referred-to", to: ins.id, source: src });
    return { est, ins };
  }
  /** the agents' claim that two records describe one injury (an edge, not an identity merge) */
  async linkSameInjury(reportId: string, logKey: string, by: string, why: string) {
    return this.wm.relate({ from: `report:sir:${reportId}`, type: "same-injury", to: `log-case:log:${logKey}`, attrs: { by, why },
      source: { kind: "agent", by, at: "2026-10-23T00:00:00.000Z" } });
  }
  async proposeAlias(employerId: string, siteCode: string, reason: string, by: string): Promise<{ p?: MergeProposal; isNew: boolean }> {
    if (this.wm.entity(employerId)?.id === this.wm.entity(`site:plant:${siteCode}`)?.id) return { isNew: false }; // already approved
    const n = this.wm.mergeQueue().length;
    const p = await this.wm.proposeMerge(employerId, `site:plant:${siteCode}`, reason, { kind: "agent", by, at: "2026-10-23T00:00:00.000Z" });
    return { p, isNew: this.wm.mergeQueue().length > n };
  }
  employerOf(reportId: string) {
    const n = this.wm.view("graph").neighborsOf(`report:sir:${reportId}`, { via: "filed-by" });
    return n[0];
  }
  /** has a person approved that this OSHA employer string (at this address) is our site? */
  employerIsSite(reportId: string, siteCode: string) {
    const emp = this.employerOf(reportId);
    return !!emp && emp.id === this.wm.entity(`site:plant:${siteCode}`)?.id;
  }
  pendingFor(employerRaw: string) {
    return this.wm.mergeQueue().find((p) => p.status === "pending" && (p.leftId === employerRaw || p.rightId === employerRaw));
  }
  reportsLinkedTo(logKey: string) {
    return this.wm.incoming(`log-case:log:${logKey}`, "same-injury").map((e) => e.from.replace(/^report:sir:/, ""));
  }
  logsLinkedTo(reportId: string) {
    return this.wm.view("graph").neighborsOf(`report:sir:${reportId}`, { via: "same-injury" }).map((e) => e.id.replace(/^log-case:log:/, ""));
  }
}
