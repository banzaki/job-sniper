import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { renderAnalysisMessage } from '../notify/present.js';
import { confirmedCandidate, makeAnalysis, makeFilter, makeOpportunity, NOW, validModelOutput } from '../testing/fixtures.js';
import { analysisVersionFor, profileFingerprint } from './analyzer.js';
import { assembleAnalysis, checkProposal, computeActionability, parseModelOutput } from './analysis-output.js';
import { buildPrompt } from './prompt.js';

const assemble = (over: Record<string, unknown>, candidate: CandidateProfile, opportunity = makeOpportunity('1')) =>
  assembleAnalysis(parseModelOutput(JSON.stringify(validModelOutput(over))), {
    opportunity, candidate, provider: 'fake', model: 'm', modelVersion: null, now: NOW,
  });

// ---------- 1. the profile ----------
test('no skill in the provisional profile is labeled confirmed', () => {
  assert.equal(brunoCandidate.skills.filter((skill) => skill.level === 'confirmed').length, 0);
});

test('the 11 inferred skills are kept as interests with unverified competence, and cite their basis', () => {
  const unverified = brunoCandidate.skills.filter((skill) => skill.level === 'unverified');
  assert.equal(unverified.length, 11);
  for (const skill of unverified) {
    assert.equal(skill.interest, true, skill.name);
    assert.match(skill.evidence ?? '', /Competence not verified by the owner/, skill.name);
  }
  assert.deepEqual(
    unverified.map((skill) => skill.name),
    ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'responsive layouts', 'landing pages', 'front-end bug fixing', 'WordPress', 'simple APIs', 'Telegram bots', 'small automations'],
  );
});

test('"unverified" never became "unavailable": the unavailable list is exactly the original nine', () => {
  const unavailable = brunoCandidate.skills.filter((skill) => skill.level === 'unavailable').map((skill) => skill.name);
  assert.equal(unavailable.length, 9);
  for (const name of ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'WordPress', 'landing pages']) {
    assert.ok(!unavailable.includes(name), name);
  }
  assert.equal(brunoCandidate.skills.find((skill) => skill.name === 'React')?.level, 'learning');
});

// ---------- 2. interest vs confirmed vs unverified in the analyzer ----------
test('the prompt gives the model three separate lists, and confirmed is empty for the real profile', () => {
  const prompt = buildPrompt(makeOpportunity('1'), brunoCandidate);
  const candidate = JSON.parse(prompt.user.split('\n')[1] ?? '{}') as Record<string, unknown[]>;
  assert.deepEqual(candidate.confirmedSkills, []);
  assert.equal(candidate.unverifiedSkills?.length, 11);
  assert.equal(candidate.learningSkills?.length, 1);
  assert.equal(candidate.unavailableSkills?.length, 9);
  assert.match(prompt.system, /unverifiedSkills are only INTERESTS/);
  assert.match(prompt.system, /never state or imply proven competence/);
});

test('a model "apply" on unverified skills becomes "review", with the uncertainty explicit', () => {
  const analysis = assemble({}, brunoCandidate);
  assert.equal(analysis.modelRecommendation, 'apply', 'the model output is kept for calibration');
  assert.equal(analysis.recommendation, 'review');
  assert.equal(analysis.verification.status, 'unverified');
  assert.deepEqual(analysis.verification.unverified, ['HTML', 'CSS', 'landing pages']);
  assert.deepEqual(analysis.matchedSkills, ['HTML', 'CSS', 'landing pages'], 'they still match; they are just not verified');
  assert.deepEqual(analysis.missingSkills, [], 'unverified is not missing');
  assert.deepEqual(analysis.verification.essential, ['HTML', 'CSS', 'landing pages']);
  assert.match(analysis.verification.note ?? '', /Essential skills not fully verified \(competence not verified: HTML, CSS, landing pages\)/);
  assert.match(analysis.risks[0] ?? '', /capped at "review"/);
  assert.equal(analysis.confidence, 'medium', 'a "high" confidence cannot rest on unverified essential skills');
});

test('with every matched skill confirmed by the owner, "apply" stands and the analysis is verified', () => {
  const analysis = assemble({}, confirmedCandidate);
  assert.equal(analysis.recommendation, 'apply');
  assert.equal(analysis.verification.status, 'verified');
  assert.deepEqual(analysis.verification.confirmed, ['HTML', 'CSS', 'landing pages']);
  assert.equal(analysis.verification.note, null);
  assert.ok(!analysis.risks.some((risk) => /not verified/i.test(risk)));
});

test('a mixed match (one confirmed, one unverified) is still capped at review', () => {
  const mixed: CandidateProfile = {
    ...confirmedCandidate,
    skills: confirmedCandidate.skills.map((skill) => (skill.name === 'CSS' ? { ...skill, level: 'unverified' as const } : skill)),
  };
  const analysis = assemble({}, mixed);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.confirmed, ['HTML', 'landing pages']);
  assert.deepEqual(analysis.verification.unverified, ['CSS']);
});

test('a skill only being learned also keeps "apply" from standing', () => {
  const analysis = assemble({ essentialSkills: ['HTML', 'React'] }, confirmedCandidate);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.learning, ['React']);
});

test('with no essential skill listed, nothing can be verified, so "apply" cannot stand', () => {
  const analysis = assemble({ essentialSkills: [] }, confirmedCandidate);
  assert.equal(analysis.recommendation, 'review');
  assert.equal(analysis.verification.status, 'unverified');
  assert.match(analysis.verification.note ?? '', /listed no essential skills/);
});

// One confirmed skill must never release "apply" while another ESSENTIAL skill is not verified.
const onlyHtmlConfirmed: CandidateProfile = {
  ...brunoCandidate,
  skills: brunoCandidate.skills.map((skill) => (skill.name === 'HTML' ? { ...skill, level: 'confirmed' as const } : skill)),
};

test('one confirmed skill does not release "apply" when another essential skill is only an interest', () => {
  const analysis = assemble({ essentialSkills: ['HTML', 'CSS'], matchedSkills: ['HTML'], missingSkills: [] }, onlyHtmlConfirmed);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.confirmed, ['HTML']);
  assert.deepEqual(analysis.verification.unverified, ['CSS']);
});

test('omitting an essential skill from "matched" does not help: the essential list decides', () => {
  const analysis = assemble({ essentialSkills: ['HTML', 'CSS', 'landing pages'], matchedSkills: ['HTML'], missingSkills: [] }, onlyHtmlConfirmed);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.unverified, ['CSS', 'landing pages']);
});

test('an essential skill outside the profile blocks "apply" and is shown as missing', () => {
  const analysis = assemble({ essentialSkills: ['HTML', 'Photoshop'], matchedSkills: ['HTML'], missingSkills: [] }, onlyHtmlConfirmed);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.notCovered, ['Photoshop']);
  assert.ok(analysis.missingSkills.includes('Photoshop'));
  assert.match(analysis.verification.note ?? '', /not covered by the candidate profile: Photoshop/);
});

test('an essential skill the candidate marked unavailable blocks "apply"', () => {
  const analysis = assemble({ essentialSkills: ['HTML', 'React Native'] }, confirmedCandidate);
  assert.equal(analysis.recommendation, 'review');
  assert.deepEqual(analysis.verification.notCovered, ['React Native']);
});

test('"apply" is released only when every essential skill is confirmed, extras notwithstanding', () => {
  const analysis = assemble({ essentialSkills: ['HTML'], matchedSkills: ['HTML', 'CSS'] }, onlyHtmlConfirmed);
  assert.equal(analysis.recommendation, 'apply');
  assert.equal(analysis.verification.status, 'verified');
  assert.equal(analysis.confidence, 'high');
});

test('review and skip from the model are never changed by verification', () => {
  assert.equal(assemble({ recommendation: 'review' }, brunoCandidate).recommendation, 'review');
  assert.equal(assemble({ recommendation: 'skip' }, brunoCandidate).recommendation, 'skip');
});

test('"wait" needs a verified match: restricted + unverified stays "review", restricted + confirmed is "wait"', () => {
  const restricted = makeOpportunity('2', { access: { kind: 'premium_only', publicAt: '2026-05-02T12:00:00.000Z', rawLabel: 'Projeto Exclusivo' } });
  assert.equal(assemble({}, brunoCandidate, restricted).recommendation, 'review');
  assert.equal(assemble({}, confirmedCandidate, restricted).recommendation, 'wait');
});

test('the score is described as a technical-fit rating, never as a probability', () => {
  const prompt = buildPrompt(makeOpportunity('1'), brunoCandidate);
  assert.match(prompt.system, /NOT a probability of winning, being hired or succeeding/);
  const opportunity = makeOpportunity('1');
  const message = renderAnalysisMessage({ opportunity, analysis: makeAnalysis(opportunity), mode: 'enriched', now: NOW });
  assert.ok(!/probabilidade|chance de (ganhar|sucesso|contratação)/i.test(message.text), 'the compact message never presents the score as a probability');
});

test('messages state that unverified competence needs review before applying', () => {
  const opportunity = makeOpportunity('1');
  const unverified = renderAnalysisMessage({ opportunity, analysis: makeAnalysis(opportunity, {}, NOW, brunoCandidate), mode: 'enriched', now: NOW });
  assert.match(unverified.text, /^<b>🟡 VALE REVISAR<\/b>/);
  assert.match(unverified.text, /Competências essenciais ainda não verificadas: HTML, CSS, landing pages/);
  const verified = renderAnalysisMessage({ opportunity, analysis: makeAnalysis(opportunity), mode: 'enriched', now: NOW });
  assert.match(verified.text, /^<b>🟢 VALE CANDIDATAR-SE<\/b>/);
  assert.match(verified.text, /Escopo pouco detalhado/);
  assert.ok(!/não verificadas/.test(verified.text), 'a fully verified analysis shows no competence caveat');
});

// ---------- 3. relevant profile changes re-open analysis ----------
const changed = (mutate: (profile: CandidateProfile) => CandidateProfile) => analysisVersionFor(mutate(brunoCandidate));

test('the analysis version carries the prompt version and a profile fingerprint', () => {
  assert.match(analysisVersionFor(brunoCandidate), /^ai-v3\+p[0-9a-f]{8}$/);
  assert.equal(analysisVersionFor(brunoCandidate), analysisVersionFor({ ...brunoCandidate }));
});

test('a relevant profile change produces a different version, with the same prompt', () => {
  const base = analysisVersionFor(brunoCandidate);
  const promote = changed((p) => ({ ...p, skills: p.skills.map((s) => (s.name === 'HTML' ? { ...s, level: 'confirmed' as const } : s)) }));
  const experience = changed((p) => ({ ...p, recordedExperience: ['Built one landing page for a friend (verified by the owner).'] }));
  const capability = changed((p) => ({ ...p, sourceCapabilities: { '99freelas': { accountTier: 'premium', canApplyToPremiumOnly: true } } }));
  const demote = changed((p) => ({ ...p, skills: p.skills.map((s) => (s.name === 'React' ? { ...s, level: 'unavailable' as const } : s)) }));
  const added = changed((p) => ({ ...p, skills: [...p.skills, { name: 'SEO', level: 'unverified' as const }] }));
  for (const version of [promote, experience, capability, demote, added]) {
    assert.notEqual(version, base);
    assert.ok(version.startsWith('ai-v3+p'));
  }
  const context = changed((p) => ({ ...p, declaredContext: [...p.declaredContext, 'Published a complete landing page.'] }));
  assert.notEqual(context, base, 'the declared context is part of the profile fingerprint');
  assert.equal(new Set([base, promote, experience, capability, demote, added, context]).size, 7);
});

// ---------- declared context ----------
test('the owner\'s declared context is recorded, visible to the model, and not turned into citable experience', () => {
  assert.deepEqual(brunoCandidate.declaredContext, [
    'Beginner in programming, working with guidance and AI assistance.',
    'Took part in the practical configuration and validation of the Job Sniper project.',
    'Has not yet built and published a complete landing page.',
    'Individual technical competences are not confirmed by inference.',
  ]);
  assert.deepEqual(brunoCandidate.recordedExperience, []);
  assert.equal(brunoCandidate.skills.filter((skill) => skill.level === 'confirmed').length, 0, 'levels are unchanged');

  const prompt = buildPrompt(makeOpportunity('1'), brunoCandidate);
  const candidate = JSON.parse(prompt.user.split('\n')[1] ?? '{}') as { declaredContext?: string[]; recordedExperience?: unknown[] };
  assert.equal(candidate.declaredContext?.length, 4);
  assert.deepEqual(candidate.recordedExperience, []);
  assert.match(prompt.system, /declaredContext is what the owner said about himself/);
  assert.match(prompt.system, /never present the Job Sniper project or anything else as client work/);
  assert.match(prompt.system, /essentialSkills lists EVERY skill the delivery essentially depends on/);
});

test('cosmetic changes (evidence text, skill order) keep the version, so nothing is redone needlessly', () => {
  const base = profileFingerprint(brunoCandidate);
  const reworded = { ...brunoCandidate, skills: brunoCandidate.skills.map((s) => ({ ...s, evidence: 'Reworded documentation' })) };
  const reordered = { ...brunoCandidate, skills: [...brunoCandidate.skills].reverse() };
  assert.equal(profileFingerprint(reworded), base);
  assert.equal(profileFingerprint(reordered), base);
});

// ---------- 5. no absolute guarantees or competence assertions in proposals ----------
for (const text of [
  'Garantirei um carregamento rápido aplicando otimização de imagens.',
  'Garanto que a página ficará perfeita e sem erros.',
  'Prometo entregar em dois dias.',
  'A página terá 100% de nota no PageSpeed.',
  'Com certeza vai converter mais.',
  'Entrego o site sem falhas.',
]) {
  test(`an absolute guarantee is rejected: "${text.slice(0, 40)}…"`, () => {
    assert.ok(checkProposal(text, brunoCandidate).some((violation) => /guarantee/.test(violation)));
    assert.throws(() => assemble({ proposalText: text }, brunoCandidate), /guarantee/);
  });
}

for (const text of ['Tenho experiência com HTML e CSS.', 'Eu domino JavaScript.', 'Possuo sólido conhecimento em WordPress.', 'Sou proficiente em CSS.']) {
  test(`an assertion of competence is rejected: "${text}"`, () => {
    assert.ok(checkProposal(text, brunoCandidate).some((violation) => /asserts competence/.test(violation)));
  });
}

test('a tentative proposal that states intentions and what must be defined passes', () => {
  const tentative =
    'Olá! Li o briefing da landing page do PREDPACK. Posso avaliar a estrutura descrita e seguir boas práticas de otimização de imagens e carregamento. ' +
    'Para falar de desempenho preciso saber onde a página será hospedada, como serão os vídeos e qual métrica vocês usam para medir. Pode me passar isso? Bruno';
  assert.deepEqual(checkProposal(tentative, brunoCandidate), []);
});

test('the prompt forbids absolute performance guarantees and asks to name what must be defined', () => {
  const { system } = buildPrompt(makeOpportunity('1'), brunoCandidate);
  assert.match(system, /Never give absolute guarantees or promises about performance or outcomes/);
  assert.match(system, /hosting, media, third-party scripts and how it is measured/);
  assert.match(system, /mention what must be defined \(hosting, media, measurement criteria\)/);
});

// ---------- 4. access is never deduced from a deadline ----------
const restrictedAt = (publicAt: string | null) =>
  makeOpportunity('3', { access: { kind: 'premium_only', publicAt, rawLabel: 'Projeto Exclusivo' } });

test('an estimated opening time that has passed does NOT make the opportunity public or actionable', () => {
  const actionability = computeActionability(restrictedAt('2026-05-01T10:00:00.000Z'), brunoCandidate, NOW);
  assert.equal(actionability.status, 'unknown');
  assert.match(actionability.reason, /verify availability/);
  assert.notEqual(actionability.status, 'actionable');
});

test('before the estimated time the opportunity is restricted; without an estimate it is restricted with unknown time', () => {
  assert.equal(computeActionability(restrictedAt('2026-05-02T12:00:00.000Z'), brunoCandidate, NOW).status, 'restricted');
  assert.match(computeActionability(restrictedAt(null), brunoCandidate, NOW).reason, /opening time is unknown/);
});

test('unknown access reads "verify availability" and never claims applying is possible', () => {
  const unknown = makeOpportunity('4', { access: { kind: 'unknown', publicAt: null, rawLabel: null } });
  const actionability = computeActionability(unknown, brunoCandidate, NOW);
  assert.equal(actionability.status, 'unknown');
  assert.match(actionability.reason, /verify availability/i);
  const summary = renderAnalysisMessage({ opportunity: unknown, analysis: makeAnalysis(unknown), mode: 'enriched', now: NOW }).text;
  assert.match(summary, /Disponibilidade: não verificada\. Confirmar no site\./);
  assert.ok(!/pode se candidatar|aberta a todos/i.test(summary));
});

test('in a rendered message a passed estimate says the time passed and availability was not re-checked', () => {
  const opportunity = restrictedAt('2026-05-01T10:00:00.000Z');
  const summary = renderAnalysisMessage({ opportunity, analysis: makeAnalysis(opportunity), mode: 'enriched', now: NOW }).text;
  const line = summary.split('\n').find((entry) => entry.startsWith('Disponibilidade')) ?? '';
  assert.match(line, /a liberação estimada \(01\/05 às 07h00\) já passou\. Confirmar no site\./);
  assert.ok(!/aberta a todos/i.test(line));
});

test('even a public observation is worded as "at the last check", with a reminder to confirm', () => {
  const opportunity = makeOpportunity('5');
  const summary = renderAnalysisMessage({ opportunity, analysis: makeAnalysis(opportunity), mode: 'enriched', now: NOW }).text;
  assert.match(summary, /Disponibilidade: aberta na última consulta \(01\/05 às 09h00\)\. Confirmar no site\./);
});
