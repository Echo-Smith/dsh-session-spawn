/**
 * Peer-session primitives for dsh-session-spawn.
 *
 * A peer is a plain sibling conversation: it is created only through
 * sessionController.create, which never receives parentSession, origin, or
 * delegationDepth. There is no local registry and no storage file; the
 * session-id prefix `session-spawn-` is the only marker, so the cap is
 * recomputed from workspaceRegistry on every call and survives restarts.
 *
 * Only node: builtins are allowed here: the profile cannot resolve
 * @deepseek-ai/* packages.
 */
import { randomUUID } from 'node:crypto'

/** Marker shared by every session this plugin creates. */
export const PREFIX = 'session-spawn-'

const TITLE_PENDING = 'title pending'
const MAX_ASSISTANT_TEXT = 4000

function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return message.trim() === '' ? 'unknown error' : message.trim()
}

function shortIdOf(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return `${PREFIX}…`
  if (sessionId.startsWith(PREFIX)) return `${PREFIX}${sessionId.slice(PREFIX.length, PREFIX.length + 4)}…`
  return `${sessionId.slice(0, 4)}…`
}

function currentModelOf(caller) {
  try {
    const current = caller?.model?.current?.()
    if (current !== null && typeof current === 'object' && typeof current.provider === 'string' && typeof current.model === 'string') {
      return current
    }
  } catch {}
  return undefined
}

/**
 * The workspace a session is attached to, if any. Callers can be unattached
 * right after creation, so every use here tolerates undefined.
 */
export function workspaceOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  let workspaces
  try {
    workspaces = ctx?.workspaceRegistry?.list?.()
  } catch {
    return undefined
  }
  if (!Array.isArray(workspaces)) return undefined
  return workspaces.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
}

/** Live session ids this plugin created inside one workspace; archived peers free their slot. */
export function peersIn(workspace, archivedIds = []) {
  const archived = new Set(Array.isArray(archivedIds) ? archivedIds : [])
  const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
  return ids.filter((sessionId) =>
    typeof sessionId === 'string' && sessionId.startsWith(PREFIX) && !archived.has(sessionId))
}

/**
 * Read-only description used in every tool result. DSH owns the title; this
 * only reads it and falls back to a short id with a pending marker.
 */
export function describe(ctx, sessionId) {
  const requested = typeof sessionId === 'string' ? sessionId : ''
  // `ctx.get` first: reading an uncontributed service property can throw, and a
  // throw in the first operand would skip the fallback that does work.
  let session
  try {
    session = ctx?.get?.('sessions')?.get?.(requested)
  } catch {}
  if (session === undefined) {
    try {
      session = ctx?.sessions?.get?.(requested)
    } catch {}
  }

  let title = ''
  try {
    const titleService = ctx?.get?.('sessionTitle')
    const record = session === undefined ? undefined : titleService?.get?.(session)
    if (typeof record?.title === 'string') title = record.title.trim()
  } catch {}

  // DSH may not have generated a title yet. Name the peer from its first user
  // message so a "switch to that conversation" reminder still points somewhere
  // the user can find in the sidebar.
  let firstMessage = ''
  if (title === '' && typeof session?.snapshotEvents === 'function') {
    try {
      for (const event of session.snapshotEvents()) {
        if (event?.type !== 'user/message' || !Array.isArray(event?.data?.content)) continue
        const text = event.data.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (text !== '') {
          firstMessage = text.length > 48 ? `${text.slice(0, 48)}…` : text
          break
        }
      }
    } catch {}
  }

  const resolvedId = typeof session?.header?.id === 'string' && session.header.id !== '' ? session.header.id : requested
  const pending = title === ''
  return {
    sessionId: resolvedId,
    shortId: shortIdOf(resolvedId),
    title: pending ? null : title,
    firstMessage,
    pending,
    label: pending
      ? (firstMessage === '' ? `${shortIdOf(resolvedId)} (${TITLE_PENDING})` : `${shortIdOf(resolvedId)} · ${firstMessage}`)
      : JSON.stringify(title),
  }
}

/**
 * The single sentence a model can relay to the user when a peer is blocked on
 * an approval card that lives in that peer's own conversation.
 */
export function pendingAction(state, described) {
  const pending = Array.isArray(state?.pendingInput) ? state.pendingInput : []
  if (!pending.includes('approval')) return null
  const label = typeof described?.label === 'string' && described.label !== '' ? described.label : 'That session'
  return `ACTION REQUIRED: ${label} is waiting for your approval. Tell the user to open that conversation in the sidebar.`
}

/** Last assistant text in a bounded page of session records. */
export function lastAssistantText(records) {
  if (!Array.isArray(records)) return ''
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    return text.length > MAX_ASSISTANT_TEXT ? `${text.slice(0, MAX_ASSISTANT_TEXT)}…` : text
  }
  return ''
}

/**
 * Create one sibling session, inherit the caller's approval override and model
 * choice, then dispatch its first task. Every failure is returned as a typed
 * error object so the tool can print a line instead of throwing.
 */
export async function createPeer(ctx, options = {}) {
  const { caller, workspace, cwd, preset, model, task, signal } = options
  const controller = ctx?.sessionController
  if (controller === undefined || typeof controller.create !== 'function') {
    return { sessionId: null, agent: null, error: { kind: 'unavailable', message: 'this build does not expose session creation' } }
  }

  const mintedId = `${PREFIX}${randomUUID()}`

  // Validate the route BEFORE creating: an unreachable model must not leave an
  // untitled, undispatchable peer sitting in the user's sidebar.
  const selection = model === undefined ? currentModelOf(caller) : model
  if (selection !== undefined) {
    // Reach the router through `ctx.get` only: this plugin does not inject
    // `llm`, and a property read of an uncontributed service throws before the
    // fallback runs. When the router is not reachable from this context the
    // pre-flight is skipped; `agent.model.select` below still validates the
    // route after creation and reports `model-apply` instead.
    let llm
    try {
      llm = ctx?.get?.('llm')
    } catch {}
    if (llm !== undefined && llm !== null && typeof llm.resolveCallConfig === 'function') {
      try {
        await llm.resolveCallConfig(selection)
      } catch (error) {
        return { sessionId: null, agent: null, error: { kind: 'model', message: messageOf(error) } }
      }
    }
  }

  const request = workspace === undefined ? { cwd } : { workspaceId: workspace.id }
  request.sessionId = mintedId
  if (typeof preset === 'string' && preset !== '') request.agentPreset = preset

  let created
  try {
    created = await controller.create(request)
  } catch (error) {
    return { sessionId: null, agent: null, error: { kind: 'create', message: messageOf(error) } }
  }

  const sessionId = typeof created?.sessionId === 'string' && created.sessionId !== '' ? created.sessionId : mintedId
  let attached = false
  if (workspace === undefined) {
    // The caller has no workspace: file the peer under the project owning the
    // caller's cwd so it still appears in the sidebar next to that project.
    try {
      const resolved = ctx?.workspaceRegistry?.resolveByPath?.(cwd)
      if (resolved !== undefined && resolved !== null) {
        await resolved.attachSession(sessionId)
        attached = true
      }
    } catch {}
  }

  let resolved
  try {
    resolved = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { sessionId, agent: null, attached, error: { kind: 'resolve', message: messageOf(error) } }
  }
  if (resolved === undefined || resolved === null || resolved.agent === undefined) {
    const message = resolved?.error === undefined ? 'the new session did not report an agent' : messageOf(resolved.error)
    return { sessionId, agent: null, attached, error: { kind: 'resolve', message } }
  }
  const agent = resolved.agent

  let policyInherited = false
  try {
    const policy = ctx?.get?.('approval')?.overrideOf?.(caller?.session)
    if (policy !== undefined) {
      // Append the log event directly. ctx.approval.setPolicy would inject a
      // fake "the user changed the policy" user message into the transcript.
      agent?.session?.append?.('approval/policy', { policy })
      policyInherited = true
    }
  } catch {}

  if (selection !== undefined) {
    try {
      if (typeof agent?.model?.select !== 'function') {
        throw new Error('the new session cannot record a model choice')
      }
      agent.model.select(selection)
    } catch (error) {
      return { sessionId, agent, attached, policyInherited, error: { kind: 'model-apply', message: messageOf(error) } }
    }
  }

  try {
    await controller.prompt({
      requestId: `spawn-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task }],
    }, signal)
  } catch (error) {
    return { sessionId, agent, attached, policyInherited, error: { kind: 'dispatch', message: messageOf(error) } }
  }

  return { sessionId, agent, attached, policyInherited, error: null }
}