// The one run each part of the README (and the consistency test) refers to. Each has its own trace in docs/trace/.
// demo and unseen: live runs recorded 2026-10-26 through Nightshift and Zetaris (RECORDED = RUNS: no replay in between).
export const RUNS = { demo: "20261027-023325-7fc3", unseen: "20261027-025156-9960", layer1: "exam-20261027T024847-37c6" };
export const RECORDED = { demo: "20261027-023325-7fc3", unseen: "20261027-025156-9960" }; // the live runs (same ids: the published traces are the live ones)
export const traceFile = (name: string, id: string, what: string) => `docs/trace/${name}_${id}_${what}`;
// one case run live in product mode with `meterless-scope: user` (scripts/user_scope_case.sh)
export const USER_SCOPE_RUN = "20261027-032150-5e96";
