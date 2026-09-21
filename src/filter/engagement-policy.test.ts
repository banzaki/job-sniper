import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { mainCaveat } from './engagement-policy.js';
import { classifyLocation, descriptionRestrictsLocation } from './location.js';
import { evaluateOpportunity, FILTER_RULE_VERSION } from './opportunity-filter.js';

/** A job with strong skill signals, so only the engagement rules can change the outcome. */
const job = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('1', {
    sourceId: 'remotive',
    title: 'Front-end developer (React)',
    description: 'We need a React and JavaScript developer for a landing page.',
    category: 'Software Development',
    subcategory: null,
    employmentType: 'freelance',
    locationRequirement: 'Worldwide',
    compensation: '$50k - $70k',
    ...over,
  });
const evaluate = (opportunity: Opportunity) => evaluateOpportunity(opportunity, donBrunoProfile, NOW);

test('the rule version identifies the engagement policy', () => {
  assert.equal(FILTER_RULE_VERSION, 'basic-v10');
});

test('freelance with a compatible location and strong skills is shortlisted, and the type is kept visible', () => {
  const result = evaluate(job());
  assert.equal(result.decision, 'shortlist');
  assert.ok(result.reasons.includes('employment type: freelance'));
  assert.ok(result.reasons.includes('location "Worldwide" is compatible with residence in Brazil'));
});

test('version 1 alerts only freelance projects: full time, part time, internship and contract are stored but skipped', () => {
  for (const [employmentType, label] of [['full_time', 'full time'], ['part_time', 'part time'], ['internship', 'internship'], ['contract', 'contract']] as const) {
    const result = evaluate(job({ employmentType }));
    assert.equal(result.decision, 'skip', employmentType);
    assert.equal(result.reasons[0], `employment type: ${label} (not sent automatically)`);
  }
  // A senior contract role to join a team: stored, never alerted.
  const team = evaluate(job({ title: 'Senior Shopify Developer', employmentType: 'contract', description: 'Join our team as a contract Shopify developer. React and JavaScript.' }));
  assert.equal(team.decision, 'skip');
});

test('a missing or unrecognized type needs review and is never presented as freelance', () => {
  const missing = evaluate(job({ employmentType: 'unknown' }));
  assert.equal(missing.decision, 'review');
  assert.ok(missing.reasons.includes('employment type not stated'));
  assert.ok(!missing.reasons.some((reason) => /freelance/.test(reason)));

  const other = evaluate(job({ employmentType: 'other', sourceMetadata: { jobTypeRaw: 'temporary' } }));
  assert.equal(other.decision, 'review');
  assert.ok(other.reasons.includes('employment type "temporary" is not recognized'));
});

test('a location that excludes residents of Brazil is never shortlisted, and an ambiguous or missing one needs review', () => {
  assert.equal(evaluate(job({ locationRequirement: 'USA Only' })).decision, 'skip');
  assert.equal(evaluate(job({ locationRequirement: 'Europe' })).decision, 'skip');
  assert.match(evaluate(job({ locationRequirement: 'Canada' })).reasons[0]!, /excludes residents of Brazil/);

  const remote = evaluate(job({ locationRequirement: 'Remote' }));
  assert.equal(remote.decision, 'review');
  assert.ok(remote.reasons.includes('location "Remote" is ambiguous for a resident of Brazil'), '"Remote" is not worldwide');
  assert.equal(evaluate(job({ locationRequirement: null })).decision, 'review');
  assert.ok(evaluate(job({ locationRequirement: null })).reasons.includes('location not stated'));
  assert.equal(evaluate(job({ locationRequirement: 'Brazil' })).decision, 'shortlist');
  assert.equal(evaluate(job({ locationRequirement: 'LATAM' })).decision, 'shortlist');
});

test('a restriction hidden in the description lowers a compatible location to review', () => {
  const result = evaluate(job({ description: 'React developer. You must be located in the United States and have work authorization.' }));
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('description mentions a location or work-authorization requirement'));
  assert.equal(descriptionRestrictsLocation('Fully remote, any country.'), false);
});

test('a senior title needs review even when everything else fits', () => {
  for (const title of ['Senior React Developer', 'Staff Front-end Engineer', 'Lead JavaScript developer']) {
    const result = evaluate(job({ title }));
    assert.equal(result.decision, 'review', title);
    assert.ok(result.reasons.some((reason) => reason.startsWith('seniority in the title:')), title);
  }
  assert.equal(evaluate(job({ title: 'Junior React developer' })).decision, 'shortlist');
});

test('the policy can only lower a result: skill rules that already skip or review are not raised', () => {
  const noSkills = job({ title: 'Go backend developer', description: 'Build services in Go.', category: 'Software Development' });
  assert.equal(evaluate(noSkills).decision, 'skip', 'no interest signals in an unlisted category');
  const weak = evaluate(job({ title: 'Backend developer', description: 'Work with an API and a bot.' }));
  assert.equal(weak.decision, 'review');
  const cancelled = evaluate(job({ status: 'cancelled' }));
  assert.equal(cancelled.decision, 'skip');
});

test('explicitly incompatible beats everything else, and the order of caveats puts location first', () => {
  const both = evaluate(job({ employmentType: 'unknown', locationRequirement: 'Germany' }));
  assert.equal(both.decision, 'skip');
  const caveats = evaluate(job({ employmentType: 'unknown', locationRequirement: 'Remote', title: 'Senior React developer' }));
  assert.equal(caveats.decision, 'review');
  assert.equal(mainCaveat(caveats.reasons), 'location "Remote" is ambiguous for a resident of Brazil');
  assert.equal(mainCaveat(['employment type not stated', 'seniority in the title: senior']), 'employment type not stated');
  assert.equal(mainCaveat(['strong signals: React', 'employment type: contract']), null);
});

test('a category that is clearly not technology is skipped, even when the text mentions a skill word', () => {
  const copywriter = evaluate(job({ title: 'Freelance Copywriter', description: 'Write copy for our landing page.', category: 'Writing' }));
  assert.equal(copywriter.decision, 'skip', 'not review');
  assert.equal(copywriter.reasons[0], 'category "Writing" is not technology');
  assert.equal(evaluate(job({ title: 'Sales Development Rep', description: 'Call leads every day.', category: 'Sales' })).decision, 'skip');
  assert.equal(evaluate(job({ category: 'Software Development' })).decision, 'shortlist', 'technology categories are not excluded');
  // A category alone never beats an explicit technical deliverable: a React title in a non-technology category is a doubt, not a skip.
  const designReact = evaluate(job({ category: 'Design' }));
  assert.equal(designReact.decision, 'review');
  assert.ok(designReact.reasons.includes('category "Design" is not technology, but a specific technical skill is named up front'));
});

test('freelance that reads like a continuing team role is skipped; a defined project is not', () => {
  for (const description of [
    'We want you to join our team for the long term. React and JavaScript.',
    'Ongoing work as a team member. React and JavaScript.',
    'Vaga para integrar a equipe. React e JavaScript.',
  ]) {
    const result = evaluate(job({ description }));
    assert.equal(result.decision, 'skip', description);
    assert.equal(result.reasons[0], 'reads like an ongoing team position, not a defined project');
  }
  assert.equal(evaluate(job({ description: 'A one-off landing page in React and JavaScript, delivered in two weeks.' })).decision, 'shortlist');
});

test('a strong skill that only appears in the skill tags, never in the text, is at most a review', () => {
  const tagsOnly = evaluate(job({ title: 'Update our website copy', description: 'Rewrite the text on our website.', skills: ['HTML', 'Translation'] }));
  assert.equal(tagsOnly.decision, 'review');
  assert.ok(tagsOnly.reasons.includes('strong skills appear only as tags, not in the title or description'));
  assert.equal(mainCaveat(tagsOnly.reasons), 'strong skills appear only as tags, not in the title or description');
  assert.equal(evaluate(job({ skills: ['HTML'] })).decision, 'shortlist', 'named in the description: fine');
});

test('a source with no engagement type is a freelance projects source: it takes part in the ladder, with no type or location invented', () => {
  const project = makeOpportunity('9', {
    title: 'Landing page em HTML e CSS',
    description: 'Preciso de uma landing page responsiva.',
    category: 'Web, Mobile & Software',
    subcategory: 'Desenvolvimento Web',
  });
  assert.equal(project.employmentType, undefined);
  const result = evaluate(project);
  assert.equal(result.decision, 'shortlist');
  assert.notEqual(result.decision, 'top_match', 'its budget is open: never an excellent match');
  assert.ok(!result.reasons.some((reason) => /employment|location|seniority/.test(reason)));
});

test('location wording: brazil and regions that include it, worldwide, other places, and doubtful texts', () => {
  const verdict = (text: string | null | undefined) => classifyLocation(text).verdict;
  for (const text of ['Worldwide', 'Anywhere', 'Brazil', 'Brasil', 'LATAM', 'Latin America', 'South America', 'Americas', 'USA, Brazil', 'Europe, LATAM', 'Global']) {
    assert.equal(verdict(text), 'compatible', text);
  }
  for (const text of ['USA Only', 'US', 'United States', 'Canada', 'North America', 'UK', 'Europe', 'EMEA', 'Germany', 'India', 'Australia', 'Portugal', 'Mexico']) {
    assert.equal(verdict(text), 'incompatible', text);
  }
  for (const text of ['Remote', 'Remote - Flexible', 'Worldwide except USA', 'Worldwide (EST hours overlap)', 'Anywhere in the US', 'Somewhere nice', 'Timezone: UTC-3']) {
    assert.equal(verdict(text), 'ambiguous', text);
  }
  assert.equal(verdict(null), 'unknown');
  assert.equal(verdict('   '), 'unknown');
  assert.equal(verdict(undefined), 'unknown');
});
