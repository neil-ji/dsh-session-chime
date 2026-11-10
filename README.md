# 会话提示音 (`@local/session-chime`)

给这台桌面加五种声音，让你可以离开屏幕去玩游戏或忙别的，回来时知道该做什么：

五种声音，一套规则：**方向编码好坏，事件数量编码"要你做多少事"。**

| 声音 | 什么时候响 | 形状 | 事件数 |
|---|---|---|---|
| `chime` | 会话干完了 | C6→G6 纯五度上行，钟声，1.15 秒 | 2 |
| `ping` | 要你**决定**：回答问题、评审计划 | 三声干脆短音，末音小三度上行 | 3 |
| `nudge` | 要你**点一下**：工具授权 | 两声干脆短音，**同音高** | 2 |
| `error` | 出事了：失败 / 被拒 / 输出被截断 | 小三度**下行**，带 4 Hz 拍频的毛边 | 2 |
| `info` | 子代理干完了，**不用你管** | 一声低音，安静，0.3 秒 | 1 |

`nudge` 是平的而不是上行，因为它是"点一下"不是"做个决定"——和 `ping` 同一族，小一号。`error` 是整套里**唯一的下行**，所以向下的两声只可能表示出问题。`info` 是唯一的单事件，也是最轻最低的，所以工作流内部的进度永远不会盖过真正叫你的那两声。

## 安装

```bash
git clone https://github.com/neil-ji/dsh-session-chime.git
```

然后在 Harness 里把这个目录作为本地 bundle 装进你的 profile（Plugin Manager 的本地安装，或者让 Agent 用 `install_bundle` 指向该目录的绝对路径）。装好后输入 `/chime test` 应听到一声完成铃声，`/chime test waiting` 是"等你确认"的两声短音。

- 平台：Windows（`System.Media.SoundPlayer`）、macOS（`afplay`，`mode: speak` 走 `say`）、Linux（`pw-play` / `paplay` / `ffplay` / `aplay` 按顺序取第一个可用的，`mode: speak` 走 `spd-say`），DSH 0.2.x。
- 依赖：无。不需要 pnpm 安装任何东西，也没有构建步骤。
- 自测：`node test/selftest.mjs`（用静音 WAV 跑完整链路，不会打扰你；79 项检查包括五种声音的事件数、走向、结尾静音、响度关系，`turn/end` 各原因到声音的映射，子代理聚合，后台 job 延后，以及缓存失效逻辑）。

## 覆盖了哪些情况

| 触发 | 声音 | 依据（都是结构化字段，不是猜） |
|---|---|---|
| 会话把活干完 | `chime` | `turn/end` 的 `reason.kind = completed` |
| 失败 / 被策略拒绝 / 输出被截断 | `error` | `reason.kind = error \| blocked \| max-tokens` |
| 你按了停止取消 | 静音（可开） | `reason.kind = aborted` |
| 子代理完成 | `info`（可关或改成 `chime`） | `header.origin = 'subagent'` |
| 等你回答问题 / 评审计划 | `ping` | `tool/call` 的 `ask_user_question` / `exit_plan_mode` |
| 等你批准工具调用 | `nudge` | `approval/asked` 审计事件 |
| 会话 idle 了，但后台 job 还在跑 | **延后**，等 job 结束再响 | `jobs.list(agent)` 里还有 `running`/`stopping` |

最后一行是这次补上的一个真问题：会话在 `turn/end` 之后就回 idle，但这不等于"活干完了"——它可能刚启动了一个 `bash` 长任务或一次渲染。那时候响"完成"，人跑回来发现机器还在忙。

## 五种声音为什么这样做

提示音要在三种糟糕的条件下还能分辨：隔着房间、音量很低、叠着游戏声音。而且相当一部分人 8 kHz 以上听不清。这种情况下**音高是弱线索**——两段"上行双音"只有音不同，听者要记住上一次是什么样才能区分。

这个插件的上一版正是这样：两个音都是"两个上行音，间隔 150 ms"，实测响度 -12.5 与 -12.7 LUFS，几乎一样。分不清"完成"和"叫你"，插件就退化成了"有动静"。

所以现在四个维度同时拉开：

| | 完成（`chime`） | 等待确认（`ping`） |
|---|---|---|
| 走向 | C6 → G6，**纯五度上行**：落定 | D6 → D6 → F6，**小三度**，悬着 | 
| 节奏 | 2 个事件，间隔 200 ms | 3 个事件，间隔 100 ms |
| 衰减 | 320 ms，钟声，会余韵 | 55–110 ms，干脆，说停就停 |
| 音区 | 基频 1.0–1.6 kHz，加一个低八度做厚度 | 1.2–1.4 kHz 带八度泛音，不加低音：更薄更亮 |

纯五度听起来"结束"，小三度听起来"没说完"，和插件想表达的意思是同一件事。而节奏差是最抗损耗的那条线索：三个短事件 vs 两个长事件，就算 4 kHz 以上全没了也分得出来。

几个音的**响度刻意做得差不多**（`chime` -12.1、`ping` -13.0、`nudge` -13.3、`error` -13.6 LUFS）：让它更抓人的是节奏、方向和音色，不是更响。提醒音比铃声还响，就变成了惊吓。`info` 明显更轻（峰值比 `ping` 低 2.7 dB），因为它只是通知进度，不要求任何动作。

三处细节：每个音起头都有一个 2–4 ms 的高频"槌子"瞬态，为了压过背景噪声；`error` 的基频上叠了一个 1.006 倍的分音，产生约 4 Hz 的拍频——那种"毛边"是让人抬头而不是觉得好听的来源；每段音频结尾都有 20 ms 余弦淡出，最后一个采样精确为 0。

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
| `enabled` | `true` | 总开关；`false` 时所有声音都不响 |
| `mode` | `chime` | `chime` 播放合成的声音；`speak` 用系统语音播报 |
| `volume` | `0.8` | 音量，`0.05` ~ `1`（对 `wavPath` 指定的文件无效） |
| `speakText` | `任务完成` | `mode: speak` 时"完成"念的文本 |
| `waitingSpeakText` | `需要你确认` | `mode: speak` 时"等你确认"念的文本 |
| `approvalSpeakText` | `需要你批准` | `mode: speak` 时工具授权念的文本 |
| `failureSpeakText` | `出错了` | `mode: speak` 时失败念的文本 |
| `infoSpeakText` | `子任务完成` | `mode: speak` 时子代理完成念的文本 |
| `wavPath` | 空 | 改成播放你自己的 `.wav`；留空使用内置的五种声音（指定后五种都用同一个文件） |
| `notifyOnFailure` | `true` | 失败 / 被拒 / 输出截断时是否响 `error` |
| `notifyOnAbort` | `false` | 你主动取消时是否响（默认静音：是你自己按的） |
| `splitWaiting` | `true` | 工具授权用 `nudge`（两声），提问和计划评审用 `ping`（三声）；`false` 时统一用 `ping` |
| `subagentSound` | `info` | 子代理完成时的声音：`info` / `chime` / `silent` |
| `subagentAggregateMs` | `3000` | 子代理连续完成时合并成一次 `info` 的窗口 |
| `deferWhileBusy` | `true` | 会话 idle 但后台 job 还在跑时，把"完成"延后到 job 结束（最长等 10 分钟） |
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
| `/chime test error` | 立刻响一次失败声 |
| `/chime test both` | 先响完成声，1.4 秒后响等待声，方便对比 |
| `/chime test all` | 依次响完五种，间隔 1.4 秒 |
| `/chime failure on\|off` | 临时开关失败提示 |
| `/chime volume 0.4` | 临时改音量 |
| `/chime mode chime` / `/chime mode speak` | 切换声音 / 语音播报 |
| `/chime waiting on` / `/chime waiting off` | 要不要"等你确认"的提示 |
| `/chime subagents on` / `/chime subagents off` | 是否包含子代理 |

## 实现

- `index.js`：Host 插件本体。监听 `agent/status`（并旁听 `api-session/status`）、`session/event`、`user-questions/request`、`approval/request`；从 `turn/end` 读 `reason.kind` 决定响哪个音（这是唯一能区分"干完"和"失败"的地方，`agent/status` 把两者都压成 `idle`）；用 `ctx.get('sessions').get(id).header.origin` 判断子代理；用 `ctx.get('agents').get(id)` + `ctx.get('jobs').list(agent)` 判断后台任务；用 `jobs.onJobDone` 释放被延后的完成提示；用 `ctx.get('commands').register()` 注册 `/chime`。
- 每种声音有**独立的冷却**（`chime` 走 `cooldownMs`，`error` 只有 1 秒），所以一次失败不会被两秒前的完成声吞掉。
- `audio.js`：合成五种声音（44.1 kHz / 16-bit / 单声道 WAV）并播放。缓存文件名带**合成版本号 + 规格哈希**（`chime-v3-06fc775d-44100-80.wav`），所以改过声音定义之后不会继续播上一次的旧文件——这是上一版的一个真 bug：只按音量和采样率命名，升级后旧 WAV 会一直命中缓存。每段音频尾部有 20 ms 余弦淡出，最后一个采样精确为 0，不会以一个台阶结束。
- Windows 上用一个常驻的 `powershell.exe` 助手进程：只在第一次出声时启动，之后每声只写一行 ASCII 命令（路径和中文文本以 base64 传递，避免 5.1 的管道编码问题），助手退出后自动重建；插件卸载时关闭它的 stdin。macOS / Linux 用一个短命的 detached 子进程播放，不值得养一个常驻进程。

不依赖任何 npm 包，也不使用 `ctx.subprocess` 之类的工具沙箱服务：它需要的是这台机器的音频设备，而不是一个被沙箱约束的子进程。

## 许可

[MIT](LICENSE) © 2026 Neil Ji
