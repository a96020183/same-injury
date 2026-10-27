// Deterministic domain rules. Each rule cites where it comes from; the agents call these, the model never replaces them.
export const REG = {
  road: "29 CFR 1904.39(b)(3): motor-vehicle accident on a public street or highway (outside a construction work zone)",
  delayed: "29 CFR 1904.39(b)(6): amputation more than 24 hours after the incident",
  avulsion: "29 CFR 1904.39(b)(11): an avulsion is not an amputation for reporting",
  statePlan: "State Plan states set their own reporting rules (29 CFR 1904.37(b)(2) lets them be more stringent) and may keep the report in their own system, so OSHA's federal Severe Injury file may not show it",
};

const AMP = /amputat/i;
const NEG = /\b(no|not|near|almost|avoid\w*|prevent\w*|without)\b[^.]{0,25}amputat/i;
const ROAD = /\b(motor vehicle|vehicle accident|car accident|auto accident|mva|traffic|highway|interstate|rear[- ]ended|collision|semi[- ]truck|tractor[- ]trailer)\b/i;
const DELAY = /\b(days? later|weeks? later|later (had|required|underwent)|subsequent(ly)?|infect\w*|revision)\b/i;
const AVUL = /avuls/i;
const TEMP = /\b(temp(orary)?\b|staffing|agency worker|contract(or|ed) (worker|employee))/i;

export const mentionsAmputation = (t: string) => AMP.test(t) && !NEG.test(t);
export const negatedAmputation = (t: string) => AMP.test(t) && NEG.test(t);

export function exclusions(t: string): { rule: keyof typeof REG; cite: string; why: string }[] {
  const out: { rule: keyof typeof REG; cite: string; why: string }[] = [];
  if (ROAD.test(t) && !/forklift|pallet jack/i.test(t)) out.push({ rule: "road", cite: REG.road, why: "narrative mentions a road vehicle" });
  if (DELAY.test(t)) out.push({ rule: "delayed", cite: REG.delayed, why: "narrative suggests the amputation came later" });
  if (AVUL.test(t)) out.push({ rule: "avulsion", cite: REG.avulsion, why: "narrative says avulsion" });
  return out;
}
export const tempWorker = (t: string) => TEMP.test(t);

// ---------------------------------------------------------------- body part and side
const FINGERS = ["thumb", "index", "middle", "ring", "little", "pinky"];
export function bodyFacts(t: string) {
  // OSHA's category names are not body parts of this case: "Finger or thumb tip(s), nail(s)" names no thumb
  const s = (t || "").toLowerCase().replace(/finger or thumb tip\(s\),?\s*(nail\(s\))?/g, "fingertip ").replace(/(fingers?|thumbs?|hands?|toes?|feet|foot)\(s\)/g, " ");
  const sides = new Set<string>();
  if (/\bleft\b/.test(s)) sides.add("left");
  if (/\bright\b/.test(s)) sides.add("right");
  const fingers = FINGERS.filter((f) => new RegExp(`\\b${f}\\b`).test(s)).map((f) => (f === "pinky" ? "little" : f));
  const region = /finger|thumb|fingertip|digit/.test(s) ? "finger" : /hand|wrist/.test(s) ? "hand" : /toe|foot/.test(s) ? "foot" : /arm|elbow/.test(s) ? "arm" : "";
  return { sides: [...sides], fingers: [...new Set(fingers)], region };
}
export function compareBody(a: string, b: string) {
  const x = bodyFacts(a), y = bodyFacts(b);
  const diffs: string[] = [];
  if (x.sides.length === 1 && y.sides.length === 1 && x.sides[0] !== y.sides[0]) diffs.push(`${x.sides[0]} vs ${y.sides[0]} side`);
  if (x.fingers.length && y.fingers.length && !x.fingers.some((f) => y.fingers.includes(f))) diffs.push(`${x.fingers.join("/")} vs ${y.fingers.join("/")}`);
  if (x.region && y.region && x.region !== y.region && !(["finger", "hand"].includes(x.region) && ["finger", "hand"].includes(y.region))) diffs.push(`${x.region} vs ${y.region}`);
  return { compatible: diffs.length === 0, diffs, a: x, b: y };
}

// ---------------------------------------------------------------- names and addresses
const STOP = new Set(["inc", "llc", "co", "corp", "corporation", "company", "the", "of", "and", "ltd", "lp", "l", "p", "dba", "us", "usa", "group",
  "services", "service", "holdings", "america", "american", "international", "industries", "enterprises", "plant", "facility", "foods", "food",
  "solutions", "partners", "culinary", "meat", "meats", "factory"]);
export const nameTokens = (s: string) => new Set((s || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => !STOP.has(t) && t.length > 1) ?? []);
export function nameOverlap(a: string, b: string) {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const t of x) if (y.has(t)) n++;
  return n / Math.min(x.size, y.size);
}
export const streetNumber = (s: string) => (s || "").trim().match(/^(\d+)/)?.[1] ?? "";
export const zip5 = (z: string) => { const d = (z || "").replace(/\D/g, "").slice(0, 5); return d ? d.padStart(5, "0") : ""; };

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
export function usDate(s: string): string | null { // SIR EventDate m/d/yyyy
  const m = (s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// ---------------------------------------------------------------- wording the Risk agent will not let through
export const BANNED: [RegExp, string][] = [
  [/\b(failed|failure) to report\b/i, "not found in OSHA's federal file"],
  [/\bdid not report\b|\bdidn't report\b|\bnever reported\b/i, "not found in OSHA's federal file"],
  [/\bunder-?report\w*/i, "not found"],
  [/\bconceal\w*|\bhid(e|ing)\b|\bcover(ed)?[- ]up\b/i, "not found"],
  [/\bviolat\w*|\billegal\w*|\bnon-?complian\w*/i, "for counsel to review"],
  [/\bwillful\w*|\bnegligen\w*/i, "for counsel to review"],
  [/\bunreported\b/i, "not found in OSHA's federal file"],
  [/\b(was|were|is|are)( not)? required to report\b/i, "is for counsel to assess"],
  [/\b(is|was|are|were|be)( (federally|not))? reportable\b/i, "is for counsel to assess"],
  [/\breportable\b/i, "for counsel to assess"],
];
export function riskCheck(text: string): { ok: boolean; hits: string[]; rewritten: string } {
  let out = text; const hits: string[] = [];
  for (const [re, rep] of BANNED) if (re.test(out)) { hits.push(out.match(re)![0]); out = out.replace(new RegExp(re.source, "gi"), rep); }
  return { ok: hits.length === 0, hits, rewritten: out };
}
