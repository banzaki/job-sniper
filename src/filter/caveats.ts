/**
 * The caveats a filter result can carry, as the stored (English) reasons say them. Two kinds:
 *  - capping caveats: a real doubt or gap in technical compatibility (they limit the decision to review);
 *  - attractiveness caveats: a low or crossing budget and crowding (they only lower the ranking and warn the reader).
 * Listed from the most to the least relevant one to show. A rate that could not be converted is NOT a caveat: it only
 * withholds "top match" and is kept in the reasons for transparency.
 */
export const CAVEAT_ORDER: readonly RegExp[] = [
  /^location .*(ambiguous|not stated)|^location not stated$|^description mentions/,
  /^employment type (not stated|".*" is not recognized)|^project language/,
  /^title names non-technical work|^technical deliverable is not clear|^essential skill outside the profile/,
  /^very short deadline|^transactional scope/,
  /^seniority in the title/,
  /^strong skills appear only as tags/,
  / is below the US\$ \d+(\/h)? floor$/,
  / budget range of about US\$ .* crosses the US\$ \d+(\/h)? floor$/,
  /^(very )?crowded project/,
  /^conflicting or advanced scope|^only weak signals|^no strong technical signal|^status could not be confirmed|is outside the profile|^broad category/,
];

/** The most relevant caveat among the stored reasons, or null. */
export function mainCaveat(reasons: readonly string[]): string | null {
  for (const pattern of CAVEAT_ORDER) {
    const found = reasons.find((reason) => pattern.test(reason));
    if (found) return found;
  }
  return null;
}

/** How many reasons are caveats: fewer means a cleaner opportunity. */
export function caveatCount(reasons: readonly string[]): number {
  return reasons.filter((reason) => CAVEAT_ORDER.some((pattern) => pattern.test(reason))).length;
}

/** Doubts about the task itself (not its price or competition): a clearly relevant main task has none of them. */
const TASK_DOUBT: readonly RegExp[] = [/^title names non-technical work|^technical deliverable is not clear|^essential skill outside the profile|^strong skills appear only as tags|^no strong technical signal/];

/** Is the main task clearly relevant, judging from the stored reasons? */
export function mainTaskIsClear(reasons: readonly string[]): boolean {
  return !reasons.some((reason) => TASK_DOUBT.some((pattern) => pattern.test(reason)));
}
