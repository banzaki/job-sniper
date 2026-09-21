import { brunoCandidate } from '../profile/bruno-candidate.js';
import { analysisVersionFor } from './analyzer.js';

/** The analysis version in force for the configured candidate. Changes when the prompt or the profile does. */
export const ANALYSIS_VERSION = analysisVersionFor(brunoCandidate);
