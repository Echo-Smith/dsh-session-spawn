#!/usr/bin/env node
/**
 * Runnable harness for dsh-session-spawn.
 *
 * No DSH packages, no network, no real session controller: every Host service
 * the plugin touches is stubbed in memory with the minimum behaviour the
 * contract promises. Run from the bundle directory:
 *
 *   node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

const CONFIG = { maxOpenPerWorkspace: 8 }
const SAME_PROJECT_REFUSAL = 'Only sessions in the same project can be dispatched from here.'

function assistantRecord(text) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    },
  }
}

function createWorld(options = {}) {
  const world = {
    definitions: new Map(),
    disposers: [],
    sessions: new Map(),
    agents: new Map(),
    workspaces: [],
    workspaceById: new Map(),
    workspaceByPath: new Map(),
    calls: [],
    creates: [],
    prompts: [],
    resolveCalls: [],
    attachCalls: [],
    createCount: 0,
    defaultSelection: options.defaultSelection ?? { provider: 'default-provider', model: 'default-model' },
    saveSelectionCalls: [],
    approvalOverrides: new Map(),
    archivedSessionIds: [],
    approvalIds: new Set(),
    approvalNext: false,
    waitResults: new Map(),
    waitThrows: new Set(),
    waitArgs: [],
    stateOverrides: new Map(),
    eventsOverrides: new Map(),
    titles: new Map(),
    presetBySession: new Map(),
    failRoute: undefined,
  }

  function addSession(id, details = {}) {
    const {
      cwd = '/tmp/project',
      origin,
      delegationDepth,
      parentSession,
      agentPreset,
    } = details
    const session = {
      id,
      header: { id, cwd },
      log: [],
      append(type, data) {
        this.log.push({ type, data })
      },
      agentPreset,
      currentModel: undefined,
      selectedModel: undefined,
      selectCalls: 0,
    }
    if (origin !== undefined) session.header.origin = origin
    if (delegationDepth !== undefined) session.header.delegationDepth = delegationDepth
    if (parentSession !== undefined) session.header.parentSession = parentSession
    world.sessions.set(id, session)
    return session
  }

  function agentFor(session) {
    const existing = world.agents.get(session.id)
    if (existing !== undefined) return existing
    const agent = {
      session,
      model: {
        current() {
          world.calls.push({ method: 'model.current', sessionId: session.id })
          return session.currentModel
        },
        select(selection) {
          session.selectCalls += 1
          session.selectedModel = selection
          world.calls.push({ method: 'model.select', sessionId: session.id, selection })
        },
      },
    }
    world.agents.set(session.id, agent)
    return agent
  }

  function addWorkspace(id, path, sessionIds = []) {
    const workspace = {
      id,
      path,
      sessionIds: [...sessionIds],
      async attachSession(sessionId) {
        world.attachCalls.push({ workspaceId: id, sessionId })
        if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
        return true
      },
    }
    world.workspaces.push(workspace)
    world.workspaceById.set(id, workspace)
    world.workspaceByPath.set(path, workspace)
    return workspace
  }

  function addCaller(details = {}) {
    const session = addSession(details.id ?? 'session-caller', details)
    session.currentModel = details.currentModel ?? { provider: 'caller-provider', model: 'caller-model' }
    return agentFor(session)
  }

  const llmService = {
    async resolveCallConfig(selection) {
      world.resolveCalls.push(selection)
      if (world.failRoute?.(selection)) throw new Error(`route ${selection.provider}/${selection.model} is unreachable`)
      return { ...selection }
    },
  }

  const controller = {
    async create(request) {
      world.calls.push({ method: 'create', request })
      const forbidden = ['parentSession', 'origin', 'delegationDepth', 'level', 'depth'].filter((key) => key in request)
      if (forbidden.length > 0) throw new Error(`create received forbidden keys: ${forbidden.join(', ')}`)
      if (request.workspaceId !== undefined && request.cwd !== undefined) {
        throw new Error('create received both workspaceId and cwd')
      }
      if (request.workspaceId === undefined && request.cwd === undefined) {
        throw new Error('create needs workspaceId or cwd')
      }
      if (typeof request.sessionId !== 'string' || request.sessionId === '') {
        throw new Error('create needs a caller-minted sessionId')
      }
      if (world.sessions.has(request.sessionId)) throw new Error(`session ${request.sessionId} already exists`)
      const workspace = request.workspaceId === undefined ? undefined : world.workspaceById.get(request.workspaceId)
      if (request.workspaceId !== undefined && workspace === undefined) {
        throw new Error(`unknown workspace ${request.workspaceId}`)
      }
      const session = addSession(request.sessionId, {
        cwd: request.cwd ?? workspace?.path ?? '/tmp/project',
        agentPreset: request.agentPreset,
      })
      session.currentModel = world.defaultSelection
      world.createCount += 1
      world.creates.push(request)
      if (workspace !== undefined) await workspace.attachSession(session.id)
      if (world.approvalNext) {
        world.approvalIds.add(session.id)
        world.approvalNext = false
      }
      return {
        sessionId: session.id,
        ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
      }
    },
    async resolveAgent(sessionId) {
      world.calls.push({ method: 'resolveAgent', sessionId })
      const session = world.sessions.get(sessionId)
      if (session === undefined) return { error: { code: 'session/not-found', message: `no session ${sessionId}` } }
      return { agent: agentFor(session) }
    },
    async prompt(request, signal) {
      world.calls.push({ method: 'prompt', request })
      world.prompts.push(request)
      if (signal?.aborted) throw new Error('prompt aborted')
      if (!world.sessions.has(request.sessionId)) throw new Error(`no session ${request.sessionId}`)
      return { accepted: true }
    },
    async state(request, signal) {
      world.calls.push({ method: 'state', request })
      const override = world.stateOverrides.get(request.sessionId)
      if (override !== undefined) return typeof override === 'function' ? override() : override
      const session = world.sessions.get(request.sessionId)
      if (session === undefined) throw new Error(`no session ${request.sessionId}`)
      return {
        running: session.idle !== true,
        active: true,
        queue: session.queued ?? 0,
        pendingInput: world.approvalIds.has(request.sessionId) ? ['approval'] : [],
        cursor: session.cursor ?? 0,
      }
    },
    async wait(request, signal) {
      world.calls.push({ method: 'wait', request })
      world.waitArgs.push(request)
      if (!(Number(request.timeoutMs) > 0)) throw new Error('wait timeoutMs must be > 0')
      if (world.waitThrows.has(request.sessionId)) {
        const error = new Error(`wait timed out for ${request.sessionId}`)
        error.code = 'session/wait-timeout'
        throw error
      }
      const result = world.waitResults.get(request.sessionId)
      if (result !== undefined) return typeof result === 'function' ? result() : result
      return {
        reason: 'idle',
        state: { running: false, active: false, queue: 0, pendingInput: [], cursor: 0 },
        output: { records: [], truncated: false },
      }
    },
    async events(request, signal) {
      world.calls.push({ method: 'events', request })
      const records = world.eventsOverrides.get(request.address?.sessionId) ?? []
      return { records, hasMore: false, cursor: records.length }
    },
  }

  function service(serviceName) {
    switch (serviceName) {
      case 'approval':
        return {
          overrideOf(session) {
            return world.approvalOverrides.get(session?.id)
          },
        }
      case 'agentPresets':
        return {
          presetForSession(session) {
            return session?.agentPreset ?? world.presetBySession.get(session?.id) ?? null
          },
        }
      case 'sessionTitle':
        return {
          get(session) {
            const title = world.titles.get(session?.id)
            return title === undefined ? undefined : { title, eventSeq: 1, updatedAt: 1 }
          },
        }
      case 'workingDirectory':
        return { get: (session) => session?.header?.cwd }
      case 'sessions':
        return { get: (id) => world.sessions.get(id) }
      case 'agents':
        return { get: (id) => world.agents.get(id) }
      case 'llm':
        return llmService
      default:
        return undefined
    }
  }

  const ctx = {
    tools: {
      register(definition) {
        if (typeof definition?.execute !== 'function') throw new Error(`tool ${definition?.name} has no execute`)
        world.definitions.set(definition.name, definition)
        return () => world.definitions.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') world.disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    sessionController: controller,
    workspaceRegistry: {
      list: () => world.workspaces,
      resolveByPath: (path) => world.workspaceByPath.get(path),
      get archivedSessionIds() { return world.archivedSessionIds },
    },
    sessions: { get: (id) => world.sessions.get(id) },
    agents: { get: (id) => world.agents.get(id) },
    workingDirectory: { get: (session) => session?.header?.cwd },
    llm: llmService,
    get: service,
  }

  world.ctx = ctx
  world.addSession = addSession
  world.agentFor = agentFor
  world.addWorkspace = addWorkspace
  world.addCaller = addCaller
  return world
}

function boot(world) {
  apply(world.ctx, CONFIG)
  return world
}

function toolOf(world, toolName) {
  const definition = world.definitions.get(toolName)
  assert.ok(definition !== undefined, `tool ${toolName} was registered`)
  return definition
}

function call(world, toolName, args, caller) {
  return toolOf(world, toolName).execute(args, { agent: caller, signal: undefined })
}

const results = []

async function check(label, fn) {
  try {
    await fn()
    results.push({ ok: true, label })
    process.stdout.write(`ok ${results.length} - ${label}\n`)
  } catch (error) {
    results.push({ ok: false, label, error })
    process.stdout.write(`not ok ${results.length} - ${label}: ${error?.message ?? error}\n`)
  }
}

await check('exports name and inject and registers four sibling-session tools', async () => {
  assert.equal(name, 'session-spawn')
  assert.deepEqual(inject, ['tools', 'sessionController', 'workspaceRegistry'])

  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  assert.deepEqual([...world.definitions.keys()].sort(), [
    'session_open',
    'session_send',
    'session_status',
    'session_wait',
  ])
  for (const [toolName, definition] of world.definitions) {
    assert.equal(definition.parameters.type, 'object', `${toolName} parameters are raw JSON Schema`)
    assert.equal(definition.output.schema.type, 'string', `${toolName} output is a string`)
    assert.equal(typeof definition.output.render, 'function', `${toolName} output renders text`)
    assert.equal(definition.isConcurrencySafe, undefined, `${toolName} has no concurrency-safe claim`)
    assert.ok(definition.description.length > 80, `${toolName} description is model-facing`)
    assert.ok(definition.description.includes('sibling'), `${toolName} description says peers are siblings`)
  }
})

await check('session_open refuses a delegated subagent (origin and depth)', async () => {
  const world = createWorld()
  const byOrigin = world.addCaller({ id: 'session-sub-origin', origin: 'subagent' })
  const byDepth = world.addCaller({ id: 'session-sub-depth', delegationDepth: 2 })
  boot(world)

  const before = world.createCount
  const originOut = await call(world, 'session_open', { task: 'do hidden work' }, byOrigin)
  const depthOut = await call(world, 'session_open', { task: 'do hidden work' }, byDepth)
  assert.match(originOut, /delegated subagent/i)
  assert.match(depthOut, /delegated subagent/i)
  assert.equal(world.createCount, before, 'no session was created')
  assert.equal(world.prompts.length, 0, 'nothing was dispatched')
})

await check('session_open creates a session-spawn- peer, attaches it, and copies approval', async () => {
  const world = createWorld()
  const caller = world.addCaller({ agentPreset: 'caller-preset' })
  const workspace = world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  world.approvalOverrides.set(caller.session.id, 'ask')
  boot(world)

  const out = await call(world, 'session_open', { task: 'Fix the parser' }, caller)
  const childId = [...world.sessions.keys()].find((id) => id !== caller.session.id)
  assert.ok(childId.startsWith('session-spawn-'), 'session id uses the spawn prefix')
  assert.ok(workspace.sessionIds.includes(childId), 'child attached to the caller workspace')

  const child = world.sessions.get(childId)
  const policies = child.log
    .filter((entry) => entry.type === 'approval/policy')
    .map((entry) => entry.data?.policy)
  assert.deepEqual(policies, ['ask'], 'caller approval override copied into the child log')
  assert.equal(child.agentPreset, 'caller-preset', 'caller preset inherited')
  assert.equal(child.header.parentSession, undefined, 'peer has no parentSession')
  assert.equal(child.header.origin, undefined, 'peer has no subagent origin')
  assert.equal(child.header.delegationDepth, undefined, 'peer has no delegation depth')

  assert.equal(world.prompts.length, 1)
  assert.equal(world.prompts[0].sessionId, childId)
  assert.equal(world.prompts[0].mode, 'queue')
  assert.deepEqual(world.prompts[0].content, [{ type: 'text', text: 'Fix the parser' }])

  assert.match(out, /^Opened /)
  assert.match(out, /Opened session-spawn-[0-9a-f]{4}… \(title pending\)\./)
  assert.match(out, /Task dispatched; the session is running\./)
  assert.ok(out.includes(`sessionId: ${childId}`), 'the full id is available for session_send')
  assert.equal(world.creates[0].cwd, undefined, 'workspaceId path does not also send cwd')
})

await check('session_open lets an explicit preset override the caller preset', async () => {
  const world = createWorld()
  const caller = world.addCaller({ agentPreset: 'caller-preset' })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  await call(world, 'session_open', { task: 'Use another preset', preset: 'explicit-preset' }, caller)
  assert.equal(world.creates.at(-1).agentPreset, 'explicit-preset')
  const childId = world.creates.at(-1).sessionId
  assert.equal(world.sessions.get(childId).agentPreset, 'explicit-preset')
})

await check('session_open selects args.model, then caller model, and never touches the default', async () => {
  const world = createWorld()
  const caller = world.addCaller({
    currentModel: { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'low' },
  })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  const requested = { provider: 'arg-provider', model: 'arg-model', reasoningEffort: 'high' }
  await call(world, 'session_open', { task: 'Model check', model: requested }, caller)
  const firstChildId = world.creates.at(-1).sessionId
  const firstChild = world.sessions.get(firstChildId)
  assert.deepEqual(firstChild.selectedModel, requested, 'args.model recorded on the child')
  assert.deepEqual(world.resolveCalls, [requested], 'route was validated before selecting')
  assert.deepEqual(world.defaultSelection, { provider: 'default-provider', model: 'default-model' }, 'global default untouched')
  assert.equal(world.saveSelectionCalls.length, 0, 'no global default save')
  assert.equal(world.calls.filter((entry) => entry.method === 'model.select').length, 1)

  await call(world, 'session_open', { task: 'Default model check' }, caller)
  const secondChildId = world.creates.at(-1).sessionId
  assert.notEqual(secondChildId, firstChildId)
  assert.deepEqual(
    world.sessions.get(secondChildId).selectedModel,
    { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'low' },
    'caller current model inherited when args.model is absent',
  )
  assert.deepEqual(world.resolveCalls.at(-1), {
    provider: 'caller-provider',
    model: 'caller-model',
    reasoningEffort: 'low',
  })
  assert.equal(world.calls.filter((entry) => entry.method === 'model.current').length, 1)
})

await check('session_open refuses the ninth peer while session_send still works at the cap', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  const opened = []
  for (let index = 0; index < 8; index += 1) {
    const beforeIds = new Set(world.sessions.keys())
    const out = await call(world, 'session_open', { task: `peer task ${index}` }, caller)
    assert.match(out, /^Opened /)
    const created = [...world.sessions.keys()].filter((id) => !beforeIds.has(id))
    assert.equal(created.length, 1)
    opened.push(created[0])
  }
  assert.equal(world.createCount, 8)

  const beforeNinth = world.createCount
  const ninth = await call(world, 'session_open', { task: 'peer task 9' }, caller)
  assert.match(ninth, /already has 8 open peer sessions/)
  assert.match(ninth, /max 8/)
  assert.equal(world.createCount, beforeNinth, 'ninth open did not create a session')

  const promptsBefore = world.prompts.length
  const send = await call(world, 'session_send', { sessionId: opened[0], task: 'one more task' }, caller)
  assert.match(send, /Dispatched to /)
  assert.equal(world.prompts.length, promptsBefore + 1, 'dispatch to an existing peer is not capped')
  assert.equal(world.prompts.at(-1).sessionId, opened[0])
  assert.equal(world.prompts.at(-1).mode, 'queue')
})

await check('session_send refuses a target in another workspace', async () => {
  const world = createWorld()
  const caller = world.addCaller({ cwd: '/tmp/a' })
  world.addWorkspace('ws-a', '/tmp/a', [caller.session.id])
  const foreign = world.addSession('session-spawn-foreign', { cwd: '/tmp/b' })
  world.addWorkspace('ws-b', '/tmp/b', [foreign.id])
  boot(world)

  const promptsBefore = world.prompts.length
  const out = await call(world, 'session_send', { sessionId: foreign.id, task: 'remote work' }, caller)
  assert.equal(out, SAME_PROJECT_REFUSAL)
  assert.equal(world.prompts.length, promptsBefore, 'cross-project dispatch did not happen')
})

await check('session_wait turns a session/wait-timeout error into still-running and clamps the timeout', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  const peer = world.addSession('session-spawn-peer', { cwd: '/tmp/project' })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id, peer.id])
  world.waitThrows.add(peer.id)
  boot(world)

  const timedOut = await call(world, 'session_wait', { sessionId: peer.id, timeoutMs: 1500 }, caller)
  assert.match(timedOut, /still running after 1500ms/)
  assert.equal(world.waitArgs.at(-1).timeoutMs, 1500)

  const clampedLow = await call(world, 'session_wait', { sessionId: peer.id, timeoutMs: 5 }, caller)
  assert.match(clampedLow, /still running after 1000ms/)
  assert.equal(world.waitArgs.at(-1).timeoutMs, 1000)

  const clampedHigh = await call(world, 'session_wait', { sessionId: peer.id, timeoutMs: 99_999_999 }, caller)
  assert.match(clampedHigh, /still running after 3600000ms/)
  assert.equal(world.waitArgs.at(-1).timeoutMs, 3600000)

  const defaulted = await call(world, 'session_wait', { sessionId: peer.id }, caller)
  assert.match(defaulted, /still running after 60000ms/)
  assert.equal(world.waitArgs.at(-1).timeoutMs, 60000)
  assert.equal(toolOf(world, 'session_wait').timeoutMs, 900_000)
})

await check('session_wait reports idle and the last assistant message', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  const peer = world.addSession('session-spawn-idle', { cwd: '/tmp/project' })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id, peer.id])
  world.waitResults.set(peer.id, {
    reason: 'idle',
    state: { running: false, active: false, queue: 0, pendingInput: [], cursor: 4 },
    output: {
      records: [assistantRecord('older draft'), assistantRecord('final answer')],
      truncated: false,
    },
  })
  boot(world)

  const out = await call(world, 'session_wait', { sessionId: peer.id, timeoutMs: 2000 }, caller)
  assert.match(out, /Status: idle/)
  assert.match(out, /Last assistant message:\nfinal answer/)
  assert.doesNotMatch(out, /older draft/, 'only the last assistant message is returned')
  assert.equal(world.waitArgs.at(-1).maxMessages, 50)
})

await check('session_wait reports input-required with the approval hint', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  const peer = world.addSession('session-spawn-blocked', { cwd: '/tmp/project' })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id, peer.id])
  world.approvalIds.add(peer.id)
  world.waitResults.set(peer.id, {
    reason: 'input-required',
    state: { running: false, active: false, queue: 0, pendingInput: ['approval'], cursor: 5 },
    output: { records: [], truncated: false },
  })
  boot(world)

  const out = await call(world, 'session_wait', { sessionId: peer.id }, caller)
  assert.match(out, /Status: input-required/)
  assert.match(out, /Pending input: approval/)
  assert.match(out, /ACTION REQUIRED: .*waiting for your approval/)
})

await check('session_status is read-only, works across projects, and reports the last message', async () => {
  const world = createWorld()
  const caller = world.addCaller({ cwd: '/tmp/a' })
  world.addWorkspace('ws-a', '/tmp/a', [caller.session.id])
  const target = world.addSession('session-spawn-target', { cwd: '/tmp/b' })
  world.addWorkspace('ws-b', '/tmp/b', [target.id])
  world.approvalIds.add(target.id)
  world.eventsOverrides.set(target.id, [assistantRecord('parser fixed')])
  boot(world)

  const promptsBefore = world.prompts.length
  const out = await call(world, 'session_status', { sessionId: target.id }, caller)
  assert.match(out, /Status: running/)
  assert.ok(out.includes(`sessionId: ${target.id}`))
  assert.match(out, /Pending input: approval/)
  assert.match(out, /ACTION REQUIRED/)
  assert.match(out, /parser fixed/)
  assert.equal(world.prompts.length, promptsBefore, 'status dispatched nothing')

  const eventsCall = world.calls.filter((entry) => entry.method === 'events').at(-1)
  assert.equal(eventsCall.request.maxMessages, 3)
  assert.deepEqual(eventsCall.request.address, { kind: 'session', sessionId: target.id })
})

await check('session_open reports an approval that is already pending', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  world.approvalNext = true
  boot(world)

  const out = await call(world, 'session_open', { task: 'Needs approval' }, caller)
  assert.match(out, /Task dispatched; the session is running\./)
  assert.match(out, /ACTION REQUIRED: .*waiting for your approval/)
  assert.match(out, /open that conversation in the sidebar/)
})

await check('session_open refuses without a caller or without task', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  const open = toolOf(world, 'session_open')
  const withoutAgent = await open.execute({ task: 'x' }, {})
  assert.match(withoutAgent, /No calling agent/)
  assert.equal(world.createCount, 0)

  const withoutTask = await open.execute({}, { agent: caller })
  assert.match(withoutTask, /task is required/)
  assert.equal(world.createCount, 0)
})

await check('session_open falls back to cwd and attaches the peer to that project', async () => {
  const world = createWorld()
  const caller = world.addCaller({ cwd: '/tmp/lone' })
  const workspace = world.addWorkspace('ws-lone', '/tmp/lone', [])
  boot(world)

  const out = await call(world, 'session_open', { task: 'independent work' }, caller)
  assert.match(out, /^Opened /)
  const request = world.creates.at(-1)
  assert.equal(request.cwd, '/tmp/lone')
  assert.equal('workspaceId' in request, false, 'workspaceId and cwd were not both sent')
  assert.ok(workspace.sessionIds.includes(request.sessionId), 'peer attached after cwd creation')
  assert.ok(
    world.attachCalls.some((entry) => entry.workspaceId === 'ws-lone' && entry.sessionId === request.sessionId),
    'best-effort attachSession used the workspace resolved by cwd',
  )
})

await check('session_send queues by default, steers on request, and reports approval', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  const peer = world.addSession('session-spawn-send', { cwd: '/tmp/project' })
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id, peer.id])
  boot(world)

  const queued = await call(world, 'session_send', { sessionId: peer.id, task: 'queued work' }, caller)
  assert.match(queued, /\(mode queue\)/)
  assert.equal(world.prompts.at(-1).mode, 'queue')

  const steered = await call(world, 'session_send', { sessionId: peer.id, task: 'urgent work', mode: 'steer' }, caller)
  assert.match(steered, /\(mode steer\)/)
  assert.equal(world.prompts.at(-1).mode, 'steer')

  world.approvalIds.add(peer.id)
  const blocked = await call(world, 'session_send', { sessionId: peer.id, task: 'after approval' }, caller)
  assert.match(blocked, /ACTION REQUIRED/)
  assert.match(blocked, /Pending input: approval/)
})

await check('session_open refuses an unreachable model route before creating a peer', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  world.failRoute = (selection) => selection?.model === 'missing-model'
  boot(world)

  const out = await call(
    world,
    'session_open',
    { task: 'Use a broken route', model: { provider: 'p', model: 'missing-model' } },
    caller,
  )
  assert.equal(world.creates.length, 0, 'no peer was created for an unreachable route')
  assert.match(out, /Could not open a new session/)
  assert.match(out, /route p\/missing-model is unreachable/)
  assert.equal(world.prompts.length, 0, 'task was not dispatched under an unvalidated model')
})

await check('an archived peer frees its cap slot', async () => {
  const world = createWorld()
  const caller = world.addCaller()
  world.addWorkspace('ws-a', '/tmp/project', [caller.session.id])
  boot(world)

  for (let index = 0; index < 8; index += 1) {
    await call(world, 'session_open', { task: `peer task ${index}` }, caller)
  }
  assert.match(await call(world, 'session_open', { task: 'peer task 9' }, caller), /max 8/)

  world.archivedSessionIds.push(world.creates[0].sessionId)
  const reopened = await call(world, 'session_open', { task: 'replacement peer' }, caller)
  assert.match(reopened, /^Opened /)
  assert.equal(world.createCount, 9)
})

const passed = results.filter((entry) => entry.ok).length
const failed = results.length - passed
process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)