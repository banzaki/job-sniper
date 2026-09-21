/** Display names by sourceId (unknown ids are shown as they are). Shared by every command that renders messages. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = { '99freelas': '99Freelas', remotive: 'Remotive', freelancer: 'Freelancer.com' };

/**
 * A brief note some source might need next to its opportunities. None does today: the 24 h delay of the Remotive feed is
 * documented in the README and STATUS instead of taking space in every alert.
 */
export const SOURCE_NOTES: Readonly<Record<string, string>> = {};
