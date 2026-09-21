import { ConfigError, requireTelegramCredentials, type AppConfig } from '../config.js';
import { dailyAllowance } from '../notify/daily-limit.js';
import { displayBudget } from '../notify/budget-display.js';
import { deliverManual } from '../notify/manual.js';
import type { Notifier } from '../notify/notifier.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { SOURCE_DATA_MAX_AGE_HOURS } from '../sources/create-sources.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import type { HunterConfig } from './hunter-config.js';
import { HELP_TEXT, MORE_BATCH, REFUSALS, type HuntSource, type Intent, type Parsed } from './intent.js';
import { HUNT_TIMEOUT_MS, type PipelineRequest, type PipelineResult } from './pipeline-runner.js';
import { decideTick, nextRun, pruneSlots } from './schedule.js';
import { acquireLock, readState, writeState, type HunterFiles, type HuntRecord } from './state.js';

/**
 * The Hunter's four actions, one after another: status, hunt, top and more, plus the scheduled tick. It is a thin layer over the
 * existing pipeline and stores: it holds no filter, ranking, queue or quota rule of its own. Every answer is a stable object with a
 * short Portuguese `reply` ready to show. Text that comes from a platform (titles) is data: it is cleaned and only ever shown.
 */
export type ResultCode = 'ok' | 'invalid' | 'unauthorized' | 'disabled' | 'busy' | 'failed' | 'config';

export interface HunterResult {
  ok: boolean;
  code: ResultCode;
  command: string;
  /** The short message for the owner, or null when nothing must be said (a stranger, a disabled Hunter). */
  reply: string | null;
  data: Record<string, unknown>;
}

export interface HunterDeps {
  appConfig: AppConfig;
  hunter: HunterConfig;
  store: OpportunityStore;
  files: HunterFiles;
  now: () => Date;
  runPipeline: (request: PipelineRequest) => Promise<PipelineResult>;
  /** Called only when a real send is authorized (DRY_RUN=false); it validates the Telegram credentials. */
  createNotifier: () => Notifier;
  isAlive?: (pid: number) => boolean;
  /** Receives one JSON-safe record per action, for the operational log. */
  log?: (record: Record<string, unknown>) => void;
}

const result = (code: ResultCode, command: string, reply: string | null, data: Record<string, unknown> = {}): HunterResult => ({ ok: code === 'ok', code, command, reply, data });

// ---------- untrusted text ----------
/** Removes control and invisible format characters (zero-width, direction overrides, BOM), collapses spaces and cuts: a title can only ever be a short line of text. */
export function cleanText(value: string, max: number): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------- authorization ----------
/** Only the one configured Telegram user, writing from a private chat with the bot (a private chat id equals the user id). */
export function authorize(hunter: HunterConfig, sender: string | null, chat: string | null): 'ok' | 'disabled' | 'unauthorized' {
  if (!hunter.enabled) return 'disabled';
  if (hunter.ownerTelegramId === null || sender === null || chat === null) return 'unauthorized';
  return sender === hunter.ownerTelegramId && chat === hunter.ownerTelegramId ? 'ok' : 'unauthorized';
}

// ---------- shared helpers ----------
const localTime = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(',', '');

const nextRunText = (deps: HunterDeps): string => {
  const next = nextRun(deps.now(), deps.hunter);
  return next ? next.local.slice(next.local.indexOf(' ') + 1) : 'agenda desligada';
};

/** "1 novo", "2 novos". */
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const decisionEmoji = (decision: string): string => (decision === 'top_match' ? '🔵' : decision === 'shortlist' ? '🟢' : decision === 'review' ? '🟡' : '⚪');

/** Pipeline failures are reported by kind, never by echoing what the site or the API said. */
export function describeFailure(run: PipelineResult): string {
  const text = run.tail.join('\n');
  if (run.timedOut) return 'a caça passou do tempo limite e foi interrompida';
  const blocked = /\b(401|403|429)\b/.exec(text);
  if (blocked) return `uma fonte respondeu HTTP ${blocked[1]} (não tentei de novo)`;
  if (/captcha/i.test(text)) return 'uma fonte pediu CAPTCHA (parei, sem contornar)';
  if (/Missing [A-Z_]+/.test(text)) return `faltou configuração: ${/Missing ([A-Z_]+(?: and [A-Z_]+)?)/.exec(text)?.[1] ?? 'variável'}`;
  return `o pipeline terminou com código ${run.exitCode ?? 'desconhecido'}`;
}

/** Real sending needs its credentials; the message names the variables and never a value. */
function credentialProblem(deps: HunterDeps, source: HuntSource | null): string | null {
  const { appConfig } = deps;
  if (!appConfig.dryRun) {
    try {
      requireTelegramCredentials(appConfig);
    } catch (error) {
      if (error instanceof ConfigError) return error.message;
      throw error;
    }
  }
  const usesFreelancer = source === 'freelancer' || (source === 'all' && appConfig.sources.includes('freelancer'));
  if (usesFreelancer && appConfig.freelancerToken === null) return 'Missing FREELANCER_OAUTH_TOKEN in .env. Fill it in locally to hunt on Freelancer.com.';
  return null;
}

/** Runs `work` while holding the single hunter lock; a second caller gets `busy`. */
async function withLock<T>(deps: HunterDeps, purpose: string, work: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const lock = acquireLock(deps.files.lock, purpose, deps.now(), deps.isAlive);
  if (!lock.acquired) return { busy: true };
  try {
    return { busy: false, value: await work() };
  } finally {
    lock.release();
  }
}

const BUSY_REPLY = '⏳ Já existe uma caça ou liberação em andamento. Tente de novo em alguns minutos.';

// ---------- status (read only) ----------
export function status(deps: HunterDeps): HunterResult {
  const { store, appConfig, hunter } = deps;
  const now = deps.now();
  const state = readState(deps.files.state);
  const day = dailyAllowance(store, now, appConfig.maxTelegramAlertsPerDay);
  const batchId = store.alertQueue.latestBatchId();
  const entries = batchId === null ? [] : store.alertQueue.listBatch(batchId);
  const byDecision = { top_match: 0, shortlist: 0, review: 0, skip: 0 } as Record<string, number>;
  for (const entry of entries) byDecision[entry.decision] = (byDecision[entry.decision] ?? 0) + 1;
  const round =
    batchId === null
      ? null
      : {
          batchId,
          new: entries.length,
          byDecision,
          selected: entries.filter((entry) => entry.status === 'selected').length,
          overflow: entries.filter((entry) => entry.status === 'overflow').length,
          delivered: entries.filter((entry) => entry.notifiedAt !== null).length,
          pending: entries.filter((entry) => entry.notifiedAt === null && entry.status !== 'expired').length,
        };
  const next = nextRun(now, hunter);
  const data = {
    dryRun: appConfig.dryRun,
    sources: appConfig.sources,
    lastCollectionBySource: Object.fromEntries(appConfig.sources.map((source) => [source, store.lastSeenBySource()[source] ?? null])),
    lastRound: round,
    day: { date: day.day, automaticUsed: day.automaticToday, automaticCap: day.cap, automaticRemaining: day.remaining, manualDeliveries: day.manualDeliveries, manualPreviews: day.manualPreviews },
    schedule: { enabled: hunter.scheduleEnabled, timezone: hunter.timezone, times: hunter.scheduleTimes, next: next?.at ?? null },
    lastHunt: state.lastHunt,
    lastError: state.lastError,
  };
  const labels = appConfig.sources.map((source) => SOURCE_LABELS[source] ?? source).join(', ');
  const lines = [
    '📊 Status',
    `Fontes: ${labels} · ${appConfig.dryRun ? '🧪 simulação (DRY_RUN)' : 'envio real'}`,
    round
      ? `Última rodada (${localTime(round.batchId, hunter.timezone)}): ${plural(round.new, 'novo', 'novos')} · ${plural(byDecision.shortlist! + byDecision.top_match!, 'compatível', 'compatíveis')} · ${byDecision.review} para revisar · ${plural(round.delivered, 'enviado', 'enviados')} · ${round.pending} aguardando`
      : 'Última rodada: nenhuma ainda',
    `Alertas automáticos hoje: ${day.automaticToday} de ${day.cap} (restam ${day.remaining}) · manuais ${day.manualDeliveries} · prévias ${day.manualPreviews}`,
    `Próxima caça: ${nextRunText(deps)}`,
    state.lastError ? `Último erro: ${cleanText(state.lastError.message, 120)}` : 'Último erro: nenhum',
  ];
  return result('ok', 'status', lines.join('\n'), data);
}

// ---------- hunt ----------
async function huntUnderLock(deps: HunterDeps, source: HuntSource, trigger: 'manual' | 'schedule', slot?: string): Promise<HunterResult> {
  const { store, appConfig, hunter } = deps;
  const startedAt = deps.now().toISOString();
  const run = await deps.runPipeline({ source, timeoutMs: HUNT_TIMEOUT_MS });
  const finishedAt = deps.now().toISOString();
  const ok = run.exitCode === 0 && !run.timedOut;
  const failure = ok ? null : describeFailure(run);

  const record: HuntRecord = { startedAt, finishedAt, source, trigger, ok, exitCode: run.exitCode, timedOut: run.timedOut, error: failure };
  const state = readState(deps.files.state);
  state.lastHunt = record;
  if (failure) state.lastError = { at: finishedAt, message: failure };
  if (slot) state.slots[slot] = { startedAt: state.slots[slot]?.startedAt ?? startedAt, status: ok ? 'done' : 'failed' };
  writeState(deps.files.state, state);

  const sourceId = source === 'all' ? undefined : source;
  const activity = store.activitySince(startedAt, sourceId);
  const entries = store.alertQueue.listBatch(store.alertQueue.latestBatchId() ?? '').filter((entry) => entry.selectedAt >= startedAt);
  const selected = entries.filter((entry) => entry.status === 'selected').length;
  const overflow = entries.filter((entry) => entry.status === 'overflow').length;
  const delivered = entries.filter((entry) => entry.notifiedAt !== null && entry.notifiedAt >= startedAt).length;
  const a = activity.added;
  const data = { source, trigger, ok, error: failure, seen: activity.seen, new: a.top_match! + a.shortlist! + a.review! + a.skip!, byDecision: a, selected, delivered, overflow, dryRun: appConfig.dryRun, next: nextRun(deps.now(), hunter)?.at ?? null };

  const lines = [
    ok ? '🎯 Caça concluída' : '⚠️ Caça com problema',
    ...(failure ? [`Motivo: ${failure}`] : []),
    `${plural(data.seen, 'visto', 'vistos')} · ${plural(data.new, 'novo', 'novos')}`,
    `${plural(a.top_match! + a.shortlist!, 'compatível', 'compatíveis')} · ${a.review} para revisar · ${plural(a.skip!, 'descartado', 'descartados')}`,
    `${plural(selected, 'selecionado', 'selecionados')} · ${overflow} aguardando`,
    ...(appConfig.dryRun ? ['🧪 Simulação: nada foi enviado.'] : [`${plural(delivered, 'enviado', 'enviados')} agora`]),
    `Próxima caça: ${nextRunText(deps)}`,
  ];
  return result(ok ? 'ok' : 'failed', 'hunt', lines.join('\n'), data);
}

export async function hunt(deps: HunterDeps, source: HuntSource): Promise<HunterResult> {
  const problem = credentialProblem(deps, source);
  if (problem) return result('config', 'hunt', `⚠️ Não posso caçar: ${problem}`, { error: problem });
  const locked = await withLock(deps, `hunt:${source}`, () => huntUnderLock(deps, source, 'manual'));
  return locked.busy ? result('busy', 'hunt', BUSY_REPLY) : locked.value;
}

// ---------- the schedule ----------
/**
 * Called by a periodic tick (the OpenClaw schedule or the operating system's). Runs the same hunt as the owner's command, but only
 * for a configured slot that was never started, and never while another hunt runs. The slot is written down before the run.
 */
export async function tick(deps: HunterDeps): Promise<HunterResult> {
  const now = deps.now();
  if (!deps.hunter.enabled) return result('disabled', 'tick', null, { reason: 'hunter_disabled' });
  const state = readState(deps.files.state);
  const decision = decideTick(now, deps.hunter, state);
  if (decision.action === 'skip') return result('ok', 'tick', null, { ran: false, reason: decision.reason, ...(decision.slot ? { slot: decision.slot } : {}) });

  const problem = credentialProblem(deps, 'all');
  if (problem) return result('config', 'tick', `⚠️ Caça agendada não rodou: ${problem}`, { ran: false, error: problem });
  const locked = await withLock(deps, `schedule:${decision.slot}`, async () => {
    const fresh = readState(deps.files.state);
    fresh.slots = { ...pruneSlots(fresh.slots, now), [decision.slot]: { startedAt: now.toISOString(), status: 'started' } };
    writeState(deps.files.state, fresh);
    return huntUnderLock(deps, 'all', 'schedule', decision.slot);
  });
  if (locked.busy) return result('busy', 'tick', null, { ran: false, reason: 'busy', slot: decision.slot });
  return { ...locked.value, command: 'tick', data: { ...locked.value.data, ran: true, slot: decision.slot } };
}

// ---------- the ranked round ----------
interface RoundItem {
  key: { sourceId: string; externalId: string };
  rank: number;
  decision: string;
  status: string;
  notifiedAt: string | null;
}

/** The latest collection's entries in their persisted order, fresh and still deliverable in kind (never a skip). */
function latestRound(deps: HunterDeps): { batchId: string | null; items: RoundItem[]; stale: number } {
  const { store, appConfig } = deps;
  const batchId = store.alertQueue.latestBatchId();
  if (batchId === null) return { batchId, items: [], stale: 0 };
  const now = deps.now().getTime();
  let stale = 0;
  const items: RoundItem[] = [];
  for (const entry of store.alertQueue.listBatch(batchId)) {
    if (entry.status === 'expired') continue;
    const stored = store.get(entry.key);
    if (!stored || !appConfig.notifyDecisions.includes(stored.filter.decision)) continue;
    const maxAge = SOURCE_DATA_MAX_AGE_HOURS[stored.opportunity.sourceId];
    if (maxAge !== undefined && !(now - Date.parse(stored.opportunity.fetchedAt) <= maxAge * 3_600_000)) {
      stale += 1;
      continue;
    }
    items.push({ key: entry.key, rank: entry.rank, decision: stored.filter.decision, status: entry.status, notifiedAt: stored.notifiedAt });
  }
  return { batchId, items, stale };
}

const ageText = (publishedAt: string | null | undefined, now: Date): string => {
  const ms = publishedAt ? now.getTime() - Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return 'idade ?';
  const hours = Math.floor(ms / 3_600_000);
  return hours < 1 ? 'há menos de 1 h' : hours < 48 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} dias`;
};

// ---------- top (read only) ----------
export function top(deps: HunterDeps, count: number): HunterResult {
  const { store, appConfig } = deps;
  const now = deps.now();
  const round = latestRound(deps);
  const lines: { rank: number; decision: string; title: string; source: string; budget: string; proposals: number | null; age: string; key: string }[] = [];
  for (const item of round.items.slice(0, count)) {
    const stored = store.get(item.key)!;
    const o = stored.opportunity;
    lines.push({
      rank: item.rank,
      decision: item.decision,
      title: cleanText(o.title, 90),
      source: SOURCE_LABELS[o.sourceId] ?? o.sourceId,
      budget: displayBudget(o, { displayCurrency: appConfig.displayCurrency, rates: store.exchangeRates, now }).value,
      proposals: o.proposalCount,
      age: ageText(o.publishedAt, now),
      key: `${item.key.sourceId}:${item.key.externalId}`,
    });
  }
  const text =
    lines.length === 0
      ? 'Nenhuma oportunidade fresca na rodada mais recente.'
      : [lines.length === 1 ? '🏆 A melhor da última rodada' : `🏆 As ${lines.length} melhores da última rodada`,...lines.map((line, index) => `${index + 1}. ${decisionEmoji(line.decision)} ${line.title} · ${line.source} · ${line.budget} · ${line.proposals === null ? '?' : plural(line.proposals, 'proposta', 'propostas')} · ${line.age} · ${line.key}`)].join('\n');
  return result('ok', 'top', text, { batchId: round.batchId, count: lines.length, items: lines });
}

// ---------- more ----------
const silentSink: Notifier = { send: async () => ({ messageId: null }) };

/**
 * Releases the next batch of at most 5 opportunities of the most recent collection, in its persisted order, by the owner's
 * explicit request. It never collects, ranks or replaces anything, never touches the backlog from before the round, and never
 * sends a skip, a stale, an invalid or an already delivered one (those are passed over without using a place). A failed Telegram
 * delivery stops the release and leaves everything else pending. It does not use the automatic daily quota.
 */
export async function more(deps: HunterDeps): Promise<HunterResult> {
  const { store, appConfig } = deps;
  const problem = credentialProblem(deps, null);
  if (problem) return result('config', 'more', `⚠️ Não posso liberar: ${problem}`, { error: problem });
  const locked = await withLock(deps, 'more', async () => {
    const round = latestRound(deps);
    const waiting = round.items.filter((item) => item.notifiedAt === null);
    const notifier = appConfig.dryRun ? silentSink : deps.createNotifier();
    const sent: string[] = [];
    const wouldSend: string[] = [];
    const passedOver = { stale: round.stale, notDeliverable: 0, invalid: 0, alreadyDelivered: 0 };
    let failure: string | null = null;

    for (const item of waiting) {
      if (sent.length + wouldSend.length >= MORE_BATCH) break;
      const id = `${item.key.sourceId}:${item.key.externalId}`;
      const report = await deliverManual({
        store,
        notifier,
        key: item.key,
        send: !appConfig.dryRun,
        decisions: appConfig.notifyDecisions,
        format: { sourceLabels: SOURCE_LABELS, displayCurrency: appConfig.displayCurrency },
        maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS,
        renderSink: silentSink,
        now: deps.now,
      });
      if (report.outcome === 'sent') sent.push(id);
      else if (report.outcome === 'rendered') wouldSend.push(id);
      else if (report.outcome === 'failed') {
        failure = 'o Telegram não confirmou; o item continua pendente';
        break;
      } else if (/already delivered/.test(report.reason ?? '')) passedOver.alreadyDelivered += 1;
      else if (/not deliverable/.test(report.reason ?? '')) passedOver.notDeliverable += 1;
      else if (/older than/.test(report.reason ?? '')) passedOver.stale += 1;
      else passedOver.invalid += 1;
    }

    const day = dailyAllowance(store, deps.now(), appConfig.maxTelegramAlertsPerDay);
    const stillWaiting = latestRound(deps).items.filter((item) => item.notifiedAt === null).length;
    const data = {
      batchId: round.batchId,
      dryRun: appConfig.dryRun,
      requested: MORE_BATCH,
      sent,
      wouldSend,
      passedOver,
      failure,
      stillWaiting,
      day: { automaticUsed: day.automaticToday, automaticCap: day.cap, manualDeliveries: day.manualDeliveries },
    };
    const count = appConfig.dryRun ? wouldSend.length : sent.length;
    const lines =
      round.batchId === null
        ? ['Não há rodada recente para liberar.']
        : [
            appConfig.dryRun ? `🧪 Simulação: eu liberaria ${count} (nada foi enviado).` : `📬 Liberei ${count} de até ${MORE_BATCH}.`,
            ...(count < MORE_BATCH && failure === null ? [`Só ${count === 1 ? 'havia 1 disponível' : `havia ${count} disponíveis`} na rodada mais recente.`] : []),
            ...(failure ? [`⚠️ ${failure}.`] : []),
            `Ainda aguardando: ${stillWaiting}`,
            `Manuais hoje: ${day.manualDeliveries} (não usam a cota automática: ${day.automaticToday} de ${day.cap})`,
          ];
    return result(failure ? 'failed' : 'ok', 'more', lines.join('\n'), data);
  });
  return locked.busy ? result('busy', 'more', BUSY_REPLY) : locked.value;
}

// ---------- the entry point of a command ----------
export async function runCommand(deps: HunterDeps, input: { sender: string | null; chat: string | null; parsed: Parsed }): Promise<HunterResult> {
  const auth = authorize(deps.hunter, input.sender, input.chat);
  let outcome: HunterResult;
  if (auth === 'unauthorized') outcome = result('unauthorized', 'none', null);
  else if (auth === 'disabled') outcome = result('disabled', 'none', input.sender !== null && input.sender === deps.hunter.ownerTelegramId ? 'O Hunter está desligado (HUNTER_ENABLED).' : null);
  else if (!input.parsed.ok) outcome = result('invalid', 'none', REFUSALS[input.parsed.reason], { reason: input.parsed.reason });
  else outcome = await dispatch(deps, input.parsed.intent);
  deps.log?.({ at: deps.now().toISOString(), command: outcome.command, code: outcome.code, dryRun: deps.appConfig.dryRun });
  return outcome;
}

async function dispatch(deps: HunterDeps, intent: Intent): Promise<HunterResult> {
  switch (intent.kind) {
    case 'status':
      return status(deps);
    case 'hunt':
      return hunt(deps, intent.source);
    case 'top':
      return top(deps, intent.count);
    case 'more':
      return more(deps);
    case 'help':
      return result('ok', 'help', HELP_TEXT);
  }
}
