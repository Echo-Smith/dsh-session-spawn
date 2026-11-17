/**
 * dsh-session-spawn: four tools that let one conversation open, dispatch to,
 * wait on, and inspect sibling conversations in the same project.
 *
 * Peers are siblings by construction: sessionController.create is the only
 * creation path and it is never given parentSession, origin, or
 * delegationDepth. Titles belong to DSH (sessionTitle); this plugin only reads
 * them, because the new session's required first task is the title source.
 *
 * Plain ESM with node: builtins only. The profile cannot resolve
 * @deepseek-ai/* packages, so nothing here imports one.
 */
import { randomUUID } from 'node:crypto'
import {
  createPeer,
  describe,
  lastAssistantText,
  peersIn,
  pendingAction,
  workspaceOf,
} from './src/sessions.js'

const DEFAULT_MAX_OPEN_PER_WORKSPACE = 8
const DEFAULT_WAIT_MS = 60_000
const MIN_WAIT_MS = 1_000
const MAX_WAIT_MS = 3_600_000
const TOOL_TIMEOUT_MS = 120_000
const WAIT_TOOL_TIMEOUT_MS = 900_000
const SAME_PROJECT_REFUSAL = 'Only sessions in the same project can be dispatched from here.'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
}

function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return message.trim() === '' ? 'unknown error' : message.trim()
}

function tool(fn) {
  return async (args, exec) => {
    try {
      return await fn(args ?? {}, exec ?? {})
    } catch (error) {
      return `session-spawn failed: ${messageOf(error)}`
    }
  }
}

function positiveInteger(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return fallback
  return Math.trunc(numeric)
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function sessionIdOf(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id
}

function isDelegated(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null) return false
  return Number(header.delegationDepth ?? 0) > 0 || header.origin === 'subagent'
}

function headingOf(described) {
  return described.pending ? described.label : `${described.label} (${described.shortId})`
}

function capRefusal(count, maxOpen) {
  return `This project already has ${count} open peer sessions (max ${maxOpen}). Dispatch to one of them with session_send instead of opening another.`
}

function pendingInputs(state) {
  return Array.isArray(state?.pendingInput) ? state.pendingInput : []
}

function queueCount(state) {
  const queue = state?.queue
  if (typeof queue === 'number' && Number.isFinite(queue)) return queue
  if (Array.isArray(queue)) return queue.length
  if (queue !== null && typeof queue === 'object') {
    const numeric = Number(queue.length ?? queue.count ?? 0)
    return Number.isFinite(numeric) ? numeric : 0
  }
  return 0
}

function statusLines(described, state) {
  const lines = [
    `Status: ${state?.running === true ? 'running' : 'idle'}`,
    `Session: ${headingOf(described)}`,
    `sessionId: ${described.sessionId}`,
  ]
  const queued = queueCount(state)
  if (queued > 0) lines.push(`Queued turns: ${queued}`)
  const pending = pendingInputs(state).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  if (pending.length > 0) lines.push(`Pending input: ${pending.join(', ')}`)
  const action = pendingAction(state, described)
  if (action !== null) lines.push(action)
  return lines
}

function textBlock(text) {
  return text === '' ? 'Last assistant message: (none yet)' : `Last assistant message:\n${text}`
}

function workingDirectoryOf(ctx, caller) {
  try {
    const directory = ctx?.workingDirectory ?? ctx?.get?.('workingDirectory')
    const cwd = directory?.get?.(caller.session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {}
  const fallback = caller?.session?.header?.cwd
  return typeof fallback === 'string' && fallback !== '' ? fallback : undefined
}

function presetOf(ctx, caller, requested) {
  const explicit = textOf(requested)
  if (explicit !== '') return explicit
  try {
    const preset = ctx?.get?.('agentPresets')?.presetForSession?.(caller.session)
    if (typeof preset === 'string' && preset !== '') return preset
  } catch {}
  return undefined
}

function modelOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (typeof value.provider !== 'string' || value.provider === '') return undefined
  if (typeof value.model !== 'string' || value.model === '') return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  }
}

function requestId() {
  return `spawn-${randomUUID()}`
}

function isWaitTimeout(error) {
  return error?.code === 'session/wait-timeout'
}

async function readState(ctx, sessionId, signal) {
  try {
    return await ctx.sessionController.state({ sessionId }, signal)
  } catch {
    return undefined
  }
}

function createDefinitions(ctx, settings) {
  const openDescription =
    'Open a new conversation in the same project and dispatch task to it as its first message. '
    + 'The new conversation is a sibling session: it has no parent, appears in the user\'s sidebar, '
    + 'and can be continued from here with session_send. '
    + 'Use only when the user asked for a new conversation or for independent long-running work that '
    + 'should stay visible and takeable-over; use subagent for a hidden bounded subtask. '
    + 'task is required because DSH names the session from its first message.'

  const sendDescription =
    'Dispatch another instruction to an existing sibling session in the same project. '
    + 'Peers are siblings, not child agents. '
    + 'mode "queue" (default) adds the instruction as the session\'s next turn; "steer" interrupts its current step. '
    + 'Only sessions in the same project can receive dispatch. '
    + 'Returns the target\'s running/idle status and any approval hint.'

  const waitDescription =
    'Wait for a sibling session in the same project to become idle or to need input, and return its last assistant message. '
    + 'Peers are siblings; this only observes the target and never changes it. '
    + 'On timeout it returns "still running" instead of failing, so it is safe to call again. '
    + 'timeoutMs is clamped to 1000-3600000 and defaults to 60000.'

  const statusDescription =
    'Read the status of a sibling session in this project: whether it is running, how many turns are queued, '
    + 'pending input such as approval, and its last assistant message. '
    + 'Peers are siblings, so this is a non-blocking read-only view with no dispatch. '
    + 'Use it before session_wait when only a quick progress check is needed.'

  const modelParameter = {
    type: 'object',
    description: 'Provider/model/effort for the new session; defaults to the caller\'s current model.',
    properties: {
      provider: { type: 'string', description: 'Provider id.' },
      model: { type: 'string', description: 'Model id.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort id.' },
    },
    required: ['provider', 'model'],
  }

  return [
    {
      name: 'session_open',
      description: openDescription,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'First instruction for the new conversation. Required: DSH names the session from this message.',
          },
          preset: {
            type: 'string',
            description: 'Agent preset id; defaults to the caller\'s preset.',
          },
          model: modelParameter,
        },
        required: ['task'],
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: tool(async (args, exec) => {
        const caller = exec.agent
        if (caller === undefined || caller === null) return 'No calling agent: session_open must run from a conversation.'
        if (isDelegated(caller)) return 'A delegated subagent cannot open a session.'
        const task = typeof args.task === 'string' ? args.task : ''
        if (task.trim() === '') return 'task is required: the new session needs a first message so DSH can name it.'

        const cwd = workingDirectoryOf(ctx, caller)
        const workspace = workspaceOf(ctx, sessionIdOf(caller))
        if (workspace === undefined && cwd === undefined) {
          return 'Could not determine this project: the caller has no workspace and no working directory.'
        }

        const maxOpen = settings.maxOpenPerWorkspace
        const archived = ctx?.workspaceRegistry?.archivedSessionIds
        const peers = workspace === undefined ? [] : peersIn(workspace, archived)
        if (peers.length >= maxOpen) return capRefusal(peers.length, maxOpen)

        let model
        if (args.model !== undefined) {
          model = modelOf(args.model)
          if (model === undefined) return 'model must be an object with string provider and model.'
        }

        const result = await createPeer(ctx, {
          caller,
          workspace,
          cwd,
          preset: presetOf(ctx, caller, args.preset),
          model,
          task,
          signal: exec.signal,
        })

        if (typeof result?.sessionId !== 'string' || result.sessionId === '') {
          return `Could not open a new session: ${result?.error?.message ?? 'unknown error'}`
        }

        const described = describe(ctx, result.sessionId)
        if (result.error !== null && result.error !== undefined) {
          const message = result.error.message ?? 'unknown error'
          if (result.error.kind === 'model-apply') {
            return `Opened ${headingOf(described)}, but could not record the requested model: ${message}. `
              + 'The task was not dispatched. Use session_send with sessionId '
              + `${result.sessionId} to dispatch under the session's current model.`
          }
          if (result.error.kind === 'resolve') {
            return `Opened ${headingOf(described)}, but the new session is not ready: ${message}. `
              + `Use session_send with sessionId ${result.sessionId} to dispatch later.`
          }
          return `Opened ${headingOf(described)}, but the task could not be dispatched: ${message}. `
            + `Use session_send with sessionId ${result.sessionId} to retry.`
        }

        const lines = [`Opened ${headingOf(described)}.`]
        const state = await readState(ctx, result.sessionId, exec.signal)
        if (state === undefined) {
          lines.push('Task dispatched.')
        } else {
          lines.push(state.running === true ? 'Task dispatched; the session is running.' : 'Task dispatched; the session is idle.')
          const action = pendingAction(state, described)
          if (action !== null) lines.push(action)
        }
        lines.push(`sessionId: ${result.sessionId}`)
        return lines.join('\n')
      }),
    },
    {
      name: 'session_send',
      description: sendDescription,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Target peer session id, as returned by session_open or session_status.' },
          task: { type: 'string', description: 'Instruction to dispatch to the peer.' },
          mode: {
            type: 'string',
            enum: ['queue', 'steer'],
            description: '"queue" (default) waits for the current turn to finish; "steer" interrupts the current step.',
          },
        },
        required: ['sessionId', 'task'],
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: tool(async (args, exec) => {
        const caller = exec.agent
        if (caller === undefined || caller === null) return 'No calling agent: session_send must run from a conversation.'
        if (isDelegated(caller)) return 'A delegated subagent cannot dispatch to a session.'

        const targetId = textOf(args.sessionId)
        if (targetId === '') return 'sessionId is required.'
        const task = typeof args.task === 'string' ? args.task : ''
        if (task.trim() === '') return 'task is required.'
        const mode = args.mode ?? 'queue'
        if (mode !== 'queue' && mode !== 'steer') return 'mode must be "queue" or "steer".'

        const callerWorkspace = workspaceOf(ctx, sessionIdOf(caller))
        const targetWorkspace = workspaceOf(ctx, targetId)
        if (callerWorkspace === undefined || targetWorkspace === undefined || callerWorkspace.id !== targetWorkspace.id) {
          return SAME_PROJECT_REFUSAL
        }

        const described = describe(ctx, targetId)
        try {
          await ctx.sessionController.prompt({
            requestId: requestId(),
            sessionId: targetId,
            mode,
            content: [{ type: 'text', text: task }],
          }, exec.signal)
        } catch (error) {
          return `Could not dispatch to ${headingOf(described)}: ${messageOf(error)}`
        }

        const lines = [`Dispatched to ${headingOf(described)} (mode ${mode}).`]
        const state = await readState(ctx, targetId, exec.signal)
        if (state === undefined) {
          lines.push('Status unavailable.')
        } else {
          lines.push(`Status: ${state.running === true ? 'running' : 'idle'}`)
          const queued = queueCount(state)
          if (queued > 0) lines.push(`Queued turns: ${queued}`)
          const pending = pendingInputs(state).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
          if (pending.length > 0) lines.push(`Pending input: ${pending.join(', ')}`)
          const action = pendingAction(state, described)
          if (action !== null) lines.push(action)
          lines.push(`sessionId: ${described.sessionId}`)
        }
        return lines.join('\n')
      }),
    },
    {
      name: 'session_wait',
      description: waitDescription,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Target peer session id.' },
          timeoutMs: {
            type: 'integer',
            description: 'How long to wait, clamped to 1000-3600000; default 60000.',
          },
        },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      timeoutMs: WAIT_TOOL_TIMEOUT_MS,
      execute: tool(async (args, exec) => {
        const targetId = textOf(args.sessionId)
        if (targetId === '') return 'sessionId is required.'
        const timeoutMs = clampInteger(args.timeoutMs, DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS)

        let result
        try {
          result = await ctx.sessionController.wait({ sessionId: targetId, timeoutMs, maxMessages: 50 }, exec.signal)
        } catch (error) {
          if (isWaitTimeout(error)) return `The session is still running after ${timeoutMs}ms.`
          return `Could not wait for the session: ${messageOf(error)}`
        }

        if (result?.reason === 'timeout') return `The session is still running after ${timeoutMs}ms.`

        const described = describe(ctx, targetId)
        const state = result?.state
        const lines = [result?.reason === 'input-required' ? 'Status: input-required' : 'Status: idle']
        lines.push(`Session: ${headingOf(described)}`)
        lines.push(`sessionId: ${described.sessionId}`)
        const pending = pendingInputs(state).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        if (pending.length > 0) lines.push(`Pending input: ${pending.join(', ')}`)
        const action = pendingAction(state, described)
        if (action !== null) lines.push(action)
        lines.push(textBlock(lastAssistantText(result?.output?.records)))
        return lines.join('\n')
      }),
    },
    {
      name: 'session_status',
      description: statusDescription,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Target peer session id.' },
        },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: tool(async (args, exec) => {
        const targetId = textOf(args.sessionId)
        if (targetId === '') return 'sessionId is required.'
        const described = describe(ctx, targetId)

        let state
        try {
          state = await ctx.sessionController.state({ sessionId: targetId }, exec.signal)
        } catch (error) {
          return `Could not read ${headingOf(described)}: ${messageOf(error)}`
        }

        let records = []
        try {
          const page = await ctx.sessionController.events({
            address: { kind: 'session', sessionId: targetId },
            maxMessages: 3,
          }, exec.signal)
          if (Array.isArray(page?.records)) records = page.records
        } catch {}

        const lines = statusLines(described, state)
        lines.push(textBlock(lastAssistantText(records)))
        return lines.join('\n')
      }),
    },
  ]
}

export const name = 'session-spawn'
export const inject = ['tools', 'sessionController', 'workspaceRegistry']

export function apply(ctx, config) {
  const settings = {
    maxOpenPerWorkspace: positiveInteger(config?.maxOpenPerWorkspace, DEFAULT_MAX_OPEN_PER_WORKSPACE),
  }
  const definitions = createDefinitions(ctx, settings)
  ctx.effect(() => {
    const disposers = []
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition))
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }
  }, 'session-spawn: tools')
}