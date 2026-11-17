# 同级会话

让一个会话在同一项目里再开一个会话，并继续和它协作。开出来的会话一律是**同级**：没有父子关系、
不嵌套、不设层级。它们和普通对话一样出现在侧栏，用户随时可以接手。

| 工具 | 作用 |
| --- | --- |
| `session_open` | 新建一个同级会话并把第一个任务交给它。`task` 必填，因为 DSH 用这条消息生成标题。 |
| `session_send` | 给已有的同级会话再派任务。`queue`（默认）排到下一轮，`steer` 打断当前一步。 |
| `session_wait` | 等它空闲或需要输入，然后返回最后一条助手消息。超时只报"仍在运行"，可以重复调用。 |
| `session_status` | 非阻塞读取：是否运行、排队轮数、待处理输入、最后一条助手消息。 |

## 安装

在 Plugins → Add plugin 里填入下面任一来源，或执行 `dsh plugin add <来源>`：

- npm：`dsh-session-spawn`
- GitHub：`github:Echo-Smith/dsh-session-spawn`

两者需要 DSH 0.2.x；插件没有运行时依赖。

## 继承什么

- **项目**。新会话加入开启它的会话所在的工作区；只能在同一个项目内派活，跨项目会被拒绝。
- **审批策略**。新会话把开启方的会话级策略（`ask` 或 `never`）复制进自己的日志。审批卡片始终留在
  需要它的那个会话里，开启方只负责提醒用户切过去处理。
- **模型**。默认沿用开启方的当前模型，也可以按次指定；选择记录在新会话上，绝不改动全局默认模型。

## 限制

- 每个项目最多 8 个开启中的同级会话（`maxOpenPerWorkspace`）。归档的会话会释放名额。
- 标题由 DSH 生成，本插件只读。
- 被委托的子代理不能用这些工具；隐藏的、有界的子任务请用子代理工具。

---

# Peer sessions

Lets one conversation open another conversation in the same project and keep working with it. The
opened conversations are siblings: no parent link, no nesting, no depth. They appear in the sidebar
like any other conversation and the user can take them over at any time.

| Tool | Does |
| --- | --- |
| `session_open` | Creates a sibling conversation and sends it a first task. `task` is required because DSH names the session from that first message. |
| `session_send` | Dispatches another task to an existing sibling. `queue` (default) waits for the current turn, `steer` interrupts the current step. |
| `session_wait` | Waits for a sibling to become idle or to need input, then returns its last assistant message. A timeout reports "still running" and is safe to repeat. |
| `session_status` | Non-blocking read: running, queued turns, pending input, last assistant message. |

## Install

Add either source in Plugins → Add plugin, or run `dsh plugin add <source>`:

- npm: `dsh-session-spawn`
- GitHub: `github:Echo-Smith/dsh-session-spawn`

Either needs DSH 0.2.x; the plugin has no runtime dependencies.

## What it inherits

- **Project.** A new session joins the workspace of the conversation that opened it. Dispatch only
  works inside that same project; a target in another project is refused.
- **Approval policy.** The new session copies the opener's session override (`ask` or `never`) into
  its own log. Approval cards stay in the conversation that needs them; the opener only reports that
  the user must switch to that conversation.
- **Model.** The opener's current model by default, overridable per call. The choice is recorded on
  the new session and never changes the deployment default.

## Limits

- At most 8 open peers per project (`maxOpenPerWorkspace`). Archived sessions free their slot.
- Titles belong to DSH; this plugin only reads them.
- Delegated subagents cannot use these tools. Use the subagent tools for hidden bounded work.