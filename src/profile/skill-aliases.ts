/**
 * Known equivalent names for a profile skill, so the wording the model or a client uses (Portuguese or
 * English) maps to the same skill. Keyed by the profile skill name.
 *
 * Aliases only help recognize a skill: they never change its level (an unverified skill stays unverified),
 * and they are deliberately kept outside the candidate profile, so adding one does not change the profile
 * fingerprint or invalidate stored analyses.
 */
export const SKILL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'responsive layouts': [
    'design responsivo',
    'layouts responsivos',
    'layout responsivo',
    'responsive design',
    'responsividade',
    'design responsive',
  ],
};
