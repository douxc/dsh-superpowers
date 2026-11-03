/**
 * Per-session bootstrap injection through the `agent/pre-step` waterfall.
 *
 * The listener delegates first (`await next()`), then decides whether this
 * step's model request should carry the Superpowers bootstrap message. The
 * decision covers the four situations the upstream hooks bridge solved with
 * separate mechanisms:
 *
 * 1. **First step of a root session** — prepend one bootstrap message.
 * 2. **Later steps / resume / fork** — the message is already visible in the
 *    derived history, so nothing is sent.
 * 3. **After compaction** — the compaction `replace` removes the shadowed
 *    bootstrap node from `session.deriveMessages()`, so the next pre-step sees
 *    no visible bootstrap and republishes it (there is no compaction hook to
 *    maintain).
 * 4. **Subagent sessions** — delegation depth is non-zero, so the listener
 *    never injects (`using-superpowers` itself also carries an upstream
 *    `<SUBAGENT-STOP>` guard as defence in depth).
 *
 * Deduplication has two layers: a batch check (messages already admitted into
 * this step by other listeners or a co-installed hooks bridge) and a durable
 * history check over `session.deriveMessages()` keyed by the source digest.
 * The bootstrap's {@link SuperpowersBootstrapSource} is merge-extensible
 * message-source metadata, so the digest/version are durable, observable, and
 * available to later steps without re-parsing message text.
 *
 * @module dsh-superpowers/injection
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { BOOTSTRAP_TEXT_MARKER, BOOTSTRAP_OPEN_TAG } from './bootstrap.js'

/** Durable source kind identifying the Superpowers bootstrap message. */
export const BOOTSTRAP_SOURCE_KIND = 'superpowers-bootstrap' as const

/**
 * Producer-declared metadata carried by the injected bootstrap user message.
 *
 * `source.kind` answers "who produced this", `form` answers "what kind of
 * thing it is". `digest` is the deduplication baseline and `upstreamVersion`
 * makes the injected content self-describing in the durable log.
 */
export interface SuperpowersBootstrapSource {
  /** Producer identity for every bootstrap message this plugin injects. */
  readonly kind: typeof BOOTSTRAP_SOURCE_KIND
  /** Injected bootstrap content is instructions for the model to follow. */
  readonly form: 'instructions'
  /** Hex-encoded SHA-256 of the model-facing bootstrap text. */
  readonly digest: string
  /** Vendored upstream Superpowers version (for example `7.0.1`). */
  readonly upstreamVersion: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'superpowers-bootstrap': SuperpowersBootstrapSource
  }
}

/** Options for {@link createBootstrapListener}. */
export interface BootstrapListenerOptions {
  /** The assembled model-facing bootstrap text. */
  readonly bootstrapText: string
  /** Digest of {@link bootstrapText}; stored in the message source. */
  readonly digest: string
  /** Upstream Superpowers version; stored in the message source. */
  readonly version: string
  /** Return early (after delegating) without injecting anything. */
  readonly disable?: boolean
}

/**
 * The part of the `agent/pre-step` payload this listener reads. Narrowed so the
 * listener can be unit-tested with plain fakes.
 */
export interface BootstrapPreStepPayload {
  /** The agent proposing the step. */
  readonly agent: Agent
  /** The current turn's cancellation signal. */
  readonly signal: AbortSignal
}

/** Continuation handing the step to the next waterfall listener. */
export type BootstrapPreStepNext = () => Promise<PreStepDecision>

/** Shape of the listener registered on `agent/pre-step`. */
export type BootstrapPreStepListener = (
  payload: BootstrapPreStepPayload,
  next: BootstrapPreStepNext,
) => Promise<PreStepDecision>

/**
 * Sessions already scanned for a foreign (hooks-bridge) bootstrap marker.
 *
 * The text scan walks visible message text, so it runs at most once per
 * session; {@link foreignSeenSessions} remembers positive findings so later
 * steps keep honouring the coexisting producer instead of re-scanning or
 * double-injecting.
 *
 * Probe-once is safe because the hooks bridge's only model-context injection
 * point is SessionStart: on a fresh session its message is either still in the
 * first step's batch (caught by the batch marker check before this probe runs)
 * or already committed to visible history. A foreign bootstrap appearing only
 * after an empty first probe would require a producer injecting mid-session,
 * which the bridge does not do; in that unlikely coexistence case one duplicate
 * bootstrap may be published once. The migration guide still asks users to
 * uninstall the bridge before enabling this plugin.
 */
const foreignProbedSessions = new WeakSet<Session>()

/**
 * Sessions where a foreign bootstrap marker has already been observed.
 *
 * Once seen, the bridge is treated as the session's bootstrap owner for the
 * rest of the session (including after a later compaction hides its message):
 * this is the documented coexistence trade-off, and the migration path is to
 * remove the bridge, not to keep both producers fighting over re-injection.
 */
const foreignSeenSessions = new WeakSet<Session>()

/**
 * Source kinds whose model-facing text may legitimately be a foreign
 * (hooks-bridge) bootstrap.
 *
 * The DSH hooks bridge's `CONTEXT_SOURCE` is `{ kind: 'hooks-claude-code' }`;
 * plain `user` is accepted for older bridge builds and hand-created context.
 * Framework-produced messages are deliberately excluded — in particular a
 * compaction summary (`source.kind === 'compact-checkpoint'`) can quote the
 * upstream marker while being the very message that *replaced* the shadowed
 * history. Counting it as a foreign bootstrap would skip the post-compaction
 * republish forever (the positive finding is cached per session), defeating
 * compaction recovery.
 */
const FOREIGN_BOOTSTRAP_SOURCE_KINDS: readonly string[] = ['hooks-claude-code', 'user']

/**
 * Return whether an agent is a root agent (not a subagent).
 *
 * Delegation depth is durable session metadata (`session.header`) and is the
 * authoritative test; the runtime `subagentDepth` option is folded in
 * defensively because it can only deepen. `origin` and `parentSession` are
 * deliberately not used: `origin` is presentation metadata and a forked root
 * session also has a `parentSession`.
 *
 * @param agent - the agent proposing a step.
 * @returns whether the agent is a top-level session.
 */
export function isRootAgent(agent: Agent): boolean {
  const durableDepth = agent.session.header.delegationDepth ?? 0
  const runtimeDepth = (agent.options as { readonly subagentDepth?: unknown }).subagentDepth
  const runtime = typeof runtimeDepth === 'number' && Number.isFinite(runtimeDepth) ? runtimeDepth : 0
  return Math.max(durableDepth, runtime) === 0
}

/**
 * Return the digest of the newest visible bootstrap message this plugin
 * produced, or `null` when no such message is visible.
 *
 * Visibility comes from `session.deriveMessages()`, the cached derived-history
 * projection: a compaction `replace` removes shadowed nodes automatically, so
 * this one function also implements "the bootstrap vanished, republish it".
 * Unreadable (for example externally seeded) source objects are treated as not
 * ours rather than throwing inside the step listener.
 *
 * @param session - the live session whose derived history is inspected.
 * @returns newest visible own digest, or `null`.
 */
export function visibleBootstrapDigest(session: Session): string | null {
  let digest: string | null = null
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || !isOwnBootstrapSource(message.source)) continue
    const candidate = (message.source as { readonly digest?: unknown }).digest
    digest = typeof candidate === 'string' ? candidate : null
  }
  return digest
}

/**
 * Build the `agent/pre-step` listener that keeps exactly one current bootstrap
 * message visible per root session.
 *
 * @param options - bootstrap text, digest, version, and the disabled flag.
 * @returns the waterfall listener; register it with `ctx.on('agent/pre-step', …)`.
 */
export function createBootstrapListener(options: BootstrapListenerOptions): BootstrapPreStepListener {
  const { bootstrapText, digest, version } = options
  const disable = options.disable ?? false
  const source: SuperpowersBootstrapSource = {
    kind: BOOTSTRAP_SOURCE_KIND,
    form: 'instructions',
    digest,
    upstreamVersion: version,
  }

  return async ({ agent, signal }, next) => {
    // Delegate first: compaction and other injections have completed by the
    // time the inner decision arrives, and a rejection owns the step.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    if (disable) return decision
    if (!isRootAgent(agent)) return decision

    // Batch baseline: messages already admitted into this step (another
    // listener, a second plugin instance, or the coexisting hooks bridge whose
    // message enters pre-step before it is committed to history).
    const pending = findBatchBootstrap(decision.messages)
    const ownPending = pending !== undefined && isOwnBootstrapSource(pending.source) ? pending : undefined
    if (pending !== undefined && ownPending === undefined) return decision
    if (ownPending !== undefined && readOwnDigest(ownPending) === digest) return decision

    const visible = visibleBootstrapDigest(agent.session)
    if (visible === digest) {
      // History already carries the current text. A stale same-producer message
      // also sitting in this batch would be a duplicate, so drop it.
      return ownPending === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== ownPending.id) }
    }
    // Upgrade policy: a session that already saw a different version is not
    // re-injected until compaction clears the visible baseline (then the
    // current version is published).
    if (visible !== null) return decision
    // Cross-producer fallback: a hooks-bridge bootstrap may be visible without
    // our source kind. Scan its text markers once per session.
    if (foreignBootstrapVisible(agent.session)) return decision

    const fresh = createUserMessage({ content: [{ type: 'text', text: bootstrapText }], source })
    return {
      ...decision,
      messages: ownPending === undefined
        ? [fresh, ...decision.messages]
        : decision.messages.map(message => message.id === ownPending.id ? fresh : message),
    }
  }
}

/** Whether a value is one of this plugin's bootstrap sources. */
function isOwnBootstrapSource(source: unknown): source is SuperpowersBootstrapSource {
  return typeof source === 'object' && source !== null
    && (source as { readonly kind?: unknown }).kind === BOOTSTRAP_SOURCE_KIND
}

/** Digest recorded in one of our messages, or `null` when unreadable. */
function readOwnDigest(message: UserMessage): string | null {
  const digest = (message.source as { readonly digest?: unknown }).digest
  return typeof digest === 'string' ? digest : null
}

/** The first message in the batch that already carries a bootstrap, if any. */
function findBatchBootstrap(messages: readonly UserMessage[]): UserMessage | undefined {
  return messages.find(message => isOwnBootstrapSource(message.source) || containsBootstrapText(message))
}

/** Whether any text block of a user message carries the upstream bootstrap marker. */
function containsBootstrapText(message: Message | UserMessage): boolean {
  return message.content.some(block => block.type === 'text' && block.text.includes(BOOTSTRAP_TEXT_MARKER))
}

/**
 * Whether a foreign bootstrap is visible in the session's derived history.
 *
 * Only messages from trusted foreign producers are considered (see
 * {@link FOREIGN_BOOTSTRAP_SOURCE_KINDS}): the hooks bridge marks itself with
 * `source.kind === 'hooks-claude-code'`, and plain `user` text is accepted for
 * older bridge builds. A framework-produced message that merely contains the
 * marker text — most importantly a `compact-checkpoint` summary quoting the
 * replaced history — must not count as a foreign bootstrap, otherwise the
 * post-compaction republish would be suppressed permanently.
 *
 * The scan is done at most once per session (the text is large); a positive
 * finding is remembered so later steps keep skipping our injection while the
 * bridge is still installed.
 */
function foreignBootstrapVisible(session: Session): boolean {
  if (foreignSeenSessions.has(session)) return true
  if (foreignProbedSessions.has(session)) return false
  foreignProbedSessions.add(session)
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || !isTrustedForeignBootstrapSource(message.source)) continue
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    if (text.includes(BOOTSTRAP_OPEN_TAG) && text.includes(BOOTSTRAP_TEXT_MARKER)) {
      foreignSeenSessions.add(session)
      return true
    }
  }
  return false
}

/** Whether a message source is a producer trusted to carry a foreign bootstrap. */
function isTrustedForeignBootstrapSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const kind = (source as { readonly kind?: unknown }).kind
  return typeof kind === 'string' && FOREIGN_BOOTSTRAP_SOURCE_KINDS.includes(kind)
}
