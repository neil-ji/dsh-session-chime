# 会话提示音 (`@local/session-chime`)

给这台桌面加两种声音，让你可以离开屏幕去玩游戏或忙别的：

| 时机 | 声音 | 含义 |
|---|---|---|
| 会话把一段活儿干完（`running → idle`） | 1 秒的双音铃声 | "干完了，来下一条指令" |
| 会话停下来等你回答 / 等你批准时 | 两声短促高音（约 0.5 秒） | "我在等你，回来确认一下" |

两种声音明显不同，闭着眼也能听出是"完成"还是"要你确认"。

## 安装

```bash
git clone https://github.com/neil-ji/dsh-session-chime.git
```

然后在 Harness 里把这个目录作为本地 bundle 装进你的 profile（Plugin Manager 的本地安装，或者让 Agent 用 `install_bundle` 指向该目录的绝对路径）。装好后输入 `/chime test` 应听到一声完成铃声，`/chime test waiting` 是"等你确认"的两声短音。

- 平台：Windows（声音经 `System.Media.SoundPlayer` 播放），DSH 0.2.x。
- 依赖：无。不需要 pnpm 安装任何东西，也没有构建步骤。
- 自测：`node test/selftest.mjs`（用静音 WAV 跑完整链路，不会打扰你）。

## 它解决的问题

在网页里放一个 `<audio>`，人一走开就不可靠：标签页被切到后台会被节流、浏览器还有自动播放限制，页面关掉更是什么都没有。所以这个插件放在 **Host 进程**里：它监听 Agent 状态与 Session 事件，直接从操作系统音频设备出声，网页在后台、窗口最小化、甚至浏览器页面关掉都不受影响。

### 怎么判断"完成"

依据 `agent/status` 的 `running → idle`。Agent 在干活期间一直是 `running`，把这一批输入全部处理完才回到 `idle`，所以这是"一段工作结束"，而不是"一次模型调用结束"。两道保护：

- **settleMs**：回到 idle 后再等一下。如果马上又变成 running（比如排队的后续消息），这次就不响，避免半截提示。
- **cooldownMs**：多次完成挤在一起时只响一次，避免变成机关枪。

### 怎么判断"在等我"

只依赖 Session 里已经落盘的事实，因此与哪个应答器抢到请求无关：

- `tool/call` 里出现 `ask_user_question` / `exit_plan_mode`，且对应的 `tool/result` 还没出现 —— Agent 正卡在"等人回答"上（计划评审也是这个通道）。
- `approval/asked` / `approval/decided` 审计事件 —— 工具要人批准（只有 approval 策略是 `ask` 的会话才会出现；本机默认 `danger-full-access` 是 `never`，所以一般不会响）。
- 另外还旁听 `user-questions/request` 与 `approval/request` 两个 waterfall 事件作为第二条通道，只观察、不抢答。

**waitingDelayMs**（默认 400ms）用于过滤"立刻就被解决"的请求：自动批准的、马上被取消的提问，不会响。

## 配置

在 `cordis.patch.yml` 的 `session-chime` 行里改，改完重启 Harness 生效：

```yaml
- insert:
    - id: session-chime
      name: '@local/session-chime'
      config:
        enabled: true
        mode: chime
        volume: 0.8
        cooldownMs: 2500
        settleMs: 1200
        minRunMs: 500
        notifyWaiting: true
        waitingDelayMs: 400
        waitingDedupeMs: 3000
        includeSubagents: false
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时两种声音都不响 |
| `mode` | `chime` | `chime` 播放合成的声音；`speak` 用系统语音播报 |
| `volume` | `0.8` | 音量，`0.05` ~ `1`（对 `wavPath` 指定的文件无效） |
| `speakText` | `任务完成` | `mode: speak` 时"完成"念的文本 |
| `waitingSpeakText` | `需要你确认` | `mode: speak` 时"等你确认"念的文本 |
| `wavPath` | 空 | 改成播放你自己的 `.wav`；留空使用内置声音（两种声音会用同一个文件） |
| `cooldownMs` | `2500` | 两次"完成"提示之间的最小间隔，`0` 表示不限制 |
| `settleMs` | `1200` | 回到 idle 后等待多久确认真的结束 |
| `minRunMs` | `500` | 短于这个时长的运行不提示（过滤一闪而过的状态变化） |
| `notifyWaiting` | `true` | 是否在"等你回答 / 等你批准"时响 |
| `waitingDelayMs` | `400` | 请求出现后等多久才响（过滤立即被解决的请求） |
| `waitingDedupeMs` | `3000` | 同一段时间内重复的等待请求只响一次 |
| `includeSubagents` | `false` | 是否也为子代理（subagent / workflow 子会话）的完成而响；子代理本来就不能开人工交互，所以不会有"等待"提示 |
| `logFile` | 空 | 填一个路径可记录每次响/跳过的原因，排查用（超过 256 KB 自动清空） |

## 命令

在输入框里直接输入，不用发消息给模型：

| 命令 | 作用 |
|---|---|
| `/chime` 或 `/chime status` | 看当前设置和上一次响的时间 |
| `/chime on` / `/chime off` | 临时开关（只影响当前 Host 进程，重启后回到配置值） |
| `/chime test` | 立刻响一次"完成"声 |
| `/chime test waiting` | 立刻响一次"等你确认"声 |
| `/chime volume 0.4` | 临时改音量 |
| `/chime mode chime` / `/chime mode speak` | 切换声音 / 语音播报 |
| `/chime waiting on` / `/chime waiting off` | 要不要"等你确认"的提示 |
| `/chime subagents on` / `/chime subagents off` | 是否包含子代理 |

## 实现

- `index.js`：Host 插件本体。监听 `agent/status`（并旁听 `api-session/status`）、`session/event`、`user-questions/request`、`approval/request`；用 `ctx.get('sessions').get(id).header.origin` 判断子代理；用 `ctx.get('commands').register()` 注册 `/chime`。
- `audio.js`：合成两种声音（44.1 kHz / 16-bit / 单声道 WAV，写到系统临时目录并按音量缓存）并驱动一个常驻的 `powershell.exe` 助手进程。助手只在第一次出声时启动，之后每声只写一行 ASCII 命令（路径和中文文本以 base64 传递，避免 5.1 的管道编码问题），助手退出后自动重建；插件卸载时关闭它的 stdin。

不依赖任何 npm 包，也不使用 `ctx.subprocess` 之类的工具沙箱服务：它需要的是这台机器的音频设备，而不是一个被沙箱约束的子进程。

## 许可

[MIT](LICENSE) © 2026 Neil Ji
