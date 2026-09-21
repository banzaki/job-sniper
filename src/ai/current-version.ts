import { brunoCandidate } from '../profile/bruno-candidate.js';
import { analysisVersionFor } from './analyzer.js';

/** The analysis version in force for the configured candidate. Changes when the prompt or the profile does. */
export const ANALYSIS_VERSION = analysisVersionFor(brunoCandidate);

/**
 * Sources whose opportunities are analyzed automatically. The prompt, the price suggestion (BRL) and the proposal
 * draft are written for freelance PROJECTS on 99Freelas; they do not fit a job feed such as Remotive (salary jobs,
 * other markets), so those are kept out until an analysis for them exists. An explicit --only still works.
 */
export const AI_SOURCE_IDS: readonly string[] = ['99freelas'];
