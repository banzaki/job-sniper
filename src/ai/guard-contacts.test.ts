import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { checkProposal } from './analysis-output.js';

const wrap = (text: string) => `Olá! Analisei o briefing. ${text} Posso confirmar o escopo com você? Bruno`;
const blocked = (text: string) => checkProposal(wrap(text), brunoCandidate).some((violation) => /link, e-mail, phone/.test(violation));

// Ordinary proposal content that used to be mistaken for a phone number (reproduced before the fix).
const HARMLESS: [string, string][] = [
  ['price range with a hyphen', 'A estimativa seria de R$ 800 - 1.500 para o escopo descrito.'],
  ['price range with an en dash', 'A estimativa seria de R$ 800 – 1.500 para o escopo descrito.'],
  ['price range with two currency signs', 'Fica entre R$ 1.500,00 - R$ 2.500,00 conforme o escopo.'],
  ['price range without spaces', 'Algo como R$ 1500-2500 no total.'],
  ['price range in reais', 'Algo como 1500-2500 reais no total.'],
  ['single price', 'O valor ficaria em R$ 1.500,00 no total.'],
  ['ISO date', 'Posso entregar a primeira versão até 2026-09-21.'],
  ['slash date', 'Posso entregar até 21/09/2026.'],
  ['hours range', 'Estimo de 12 a 25 horas de trabalho.'],
  ['quantity range', 'Pensando em 200 - 300 visitas por dia.'],
  ['large number', 'Pensando em cerca de 10.000 visitas por mês.'],
  ['resolutions', 'Considerando telas de 1920 x 1080 e 390 x 844.'],
];
for (const [name, text] of HARMLESS) {
  test(`harmless content is not mistaken for a phone number: ${name}`, () => {
    assert.equal(blocked(text), false, text);
  });
}

// Real contacts must stay blocked.
const CONTACTS: [string, string][] = [
  ['area code in parentheses', 'Me chame no (11) 91234-5678.'],
  ['area code and number', 'Me chame no 11 91234-5678.'],
  ['country code', 'Meu número é +55 11 91234-5678.'],
  ['country code with parentheses', 'Contato: +55 (21) 98765-4321.'],
  ['eleven digits in a row', 'Meu número é 11912345678.'],
  ['thirteen digits in a row', 'Fale comigo em 5511912345678.'],
  ['landline', 'Ligue para (11) 1234-5678.'],
  ['toll-free', 'Ligue 0800 123 4567.'],
  ['local number', 'Me chame no 91234-5678.'],
  ['link', 'Veja https://exemplo.com/portfolio.'],
  ['www link', 'Veja www.exemplo.com.'],
  ['e-mail', 'Escreva para bruno@exemplo.com.'],
  ['messaging app', 'Me chama no WhatsApp.'],
  ['off-platform payment', 'Pagamento por Pix fora da plataforma.'],
];
for (const [name, text] of CONTACTS) {
  test(`a real contact stays blocked: ${name}`, () => {
    assert.equal(blocked(text), true, text);
  });
}

// The amount/date exemption must not become a way to smuggle a phone number in.
const DISGUISED: [string, string][] = [
  ['phone typed after R$', 'O valor é R$ 11912345678.'],
  ['phone after R$ with a space', 'O valor é R$ 11 91234-5678.'],
  ['phone next to a price', 'Fica R$ 800 - 1.500, ligue (11) 91234-5678.'],
  ['phone next to a date', 'Até 2026-09-21, ligue 11 91234-5678.'],
  ['phone before "reais"', 'São 11912345678 reais.'],
];
for (const [name, text] of DISGUISED) {
  test(`a phone number cannot hide inside an amount or date: ${name}`, () => {
    assert.equal(blocked(text), true, text);
  });
}
