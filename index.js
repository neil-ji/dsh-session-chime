/**
 * session-chime — a desktop completion chime for every session in this profile.
 *
 * Why a Host plugin: the sound has to reach the person while the Web UI is in
 * the background (a game in the foreground), so playback happens in the Host
 * process through the OS audio device instead of an audio element in the page,
 * where background-tab throttling and autoplay policy would both interfere.
 *
 * The signal is `agent/status`: an Agent reports `running` while it works
 * through an admitted input and `idle` when that work has drained, so one
 * running → idle transition is "one piece of work just finished", not one model
 * call. A short settle delay collapses idle/running flapping (a queued follow-up
 * arriving right after the last turn), and a cooldown keeps a burst of finishing
 * sessions from turning into a machine gun of chimes.
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs';

import { DesktopChime } from './audio.js';

const DEFAULTS = {
  enabled: true,
  mode: 'chime',
  volume: 0.8,
  speakText: '任务完成',
  waitingSpeakText: '需要你确认',
  wavPath: '',
  cooldownMs: 2500,
  settleMs: 1200,
  minRunMs: 500,
  waitingDelayMs: 400,
  waitingDedupeMs: 3000,
  includeSubagents: false,
  notifyWaiting: true,
  logFile: '',
};

/** Tool names that park the agent until a person answers or approves. */
const ASK_TOOL_NAMES = new Set(['ask_user_question', 'exit_plan_mode']);

const LOG_LIMIT_BYTES = 256 * 1024;

/** Coerce one raw config value into the shape the plugin runs with. */
function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const int = (input, fallback, min, max) => {
    const parsed = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  const text = (input, fallback) => (typeof input === 'string' && input.trim() ? input.trim() : fallback);

  return {
    enabled: value.enabled !== false,
    mode: value.mode === 'speak' ? 'speak' : 'chime',
    volume: int(Number(value.volume ?? DEFAULTS.volume) * 100, 80, 5, 100) / 100,
    speakText: text(value.speakText, DEFAULTS.speakText),
    waitingSpeakText: text(value.waitingSpeakText, DEFAULTS.waitingSpeakText),
    wavPath: text(value.wavPath, ''),
    cooldownMs: int(value.cooldownMs, DEFAULTS.cooldownMs, 0, 60000),
    settleMs: int(value.settleMs, DEFAULTS.settleMs, 0, 30000),
    minRunMs: int(value.minRunMs, DEFAULTS.minRunMs, 0, 600000),
    waitingDelayMs: int(value.waitingDelayMs, DEFAULTS.waitingDelayMs, 0, 10000),
    waitingDedupeMs: int(value.waitingDedupeMs, DEFAULTS.waitingDedupeMs, 0, 120000),
    includeSubagents: value.includeSubagents === true,
    notifyWaiting: value.notifyWaiting !== false,
    logFile: text(value.logFile, ''),
  };
}

/** Host plugin entry: one audio output and one status listener for the profile. */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);

  /** Debug trace: only written when `logFile` names a file. */
  function trace(message) {
    if (!settings.logFile) return;
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      let size = 0;
      try {
        size = statSync(settings.logFile).size;
      } catch {
        size = 0;
      }
      if (size > LOG_LIMIT_BYTES) writeFileSync(settings.logFile, '', 'utf8');
      appendFileSync(settings.logFile, line, 'utf8');
    } catch {
      /* a trace failure must never disturb playback */
    }
  }

  /** Operator-visible line: the log file when configured, otherwise stdout. */
  function note(message) {
    trace(message);
    if (!settings.logFile) console.log(`[session-chime] ${message}`);
  }

  const audio = new DesktopChime({
    mode: settings.mode,
    volume: settings.volume,
    speakText: settings.speakText,
    wavPath: settings.wavPath,
    log: trace,
  });

  /** sessionId → { startedAt, subagent } for runs currently in flight. */
  const inFlight = new Map();
  /** sessionId → settle timer. */
  const settling = new Map();
  let lastPlayedAt = 0;
  let lastPlayed = null;
  /** sessionId → { keys: Map<requestKey, kind>, timer } for requests only a person can settle. */
  const waiting = new Map();
  let lastWaitingAt = 0;

  /** Whether a Session belongs to a delegated child agent. */
  function isSubagent(sessionId) {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      return session?.header?.origin === 'subagent';
    } catch {
      return false;
    }
  }

  /** Produce the sound for one finished run, honoring the global cooldown. */
  function play(sessionId, reason) {
    if (!settings.enabled) {
      trace(`skip ${sessionId}: disabled`);
      return false;
    }
    const now = Date.now();
    const waited = now - lastPlayedAt;
    if (lastPlayedAt && waited < settings.cooldownMs) {
      trace(`skip ${sessionId}: cooldown (${waited} ms < ${settings.cooldownMs} ms)`);
      return false;
    }
    audio.mode = settings.mode;
    audio.volume = settings.volume;
    audio.speakText = settings.speakText;
    audio.wavPath = settings.wavPath;
    const played = audio.play();
    if (played) {
      lastPlayedAt = now;
      lastPlayed = { sessionId, reason, at: now };
      note(`played ${settings.mode} for ${sessionId} (${reason})`);
    }
    return played;
  }

  /** Arm the settle delay for one idle transition. */
  function settle(sessionId, reason) {
    const existing = settling.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      settling.delete(sessionId);
      if (inFlight.has(sessionId)) {
        trace(`skip ${sessionId}: running again`);
        return;
      }
      play(sessionId, reason);
    }, settings.settleMs);
    timer.unref?.();
    settling.set(sessionId, timer);
  }

  /** Produce the attention ping for one open request. */
  function playWaiting(sessionId, kind) {
    if (!settings.enabled || !settings.notifyWaiting) {
      trace(`skip waiting ${sessionId}: disabled`);
      return false;
    }
    if (isSubagent(sessionId) && !settings.includeSubagents) {
      trace(`skip waiting ${sessionId}: subagent`);
      return false;
    }
    const now = Date.now();
    if (lastWaitingAt && now - lastWaitingAt < settings.waitingDedupeMs) {
      trace(`skip waiting ${sessionId}: dedupe`);
      return false;
    }
    audio.mode = settings.mode;
    audio.sound = 'ping';
    audio.volume = settings.volume;
    audio.speakText = settings.waitingSpeakText;
    audio.wavPath = settings.wavPath;
    const played = audio.play();
    if (played) {
      lastWaitingAt = now;
      note(`played ping for ${sessionId} (${kind})`);
    }
    return played;
  }

  /**
   * A request that parks the agent until a person answers appeared.
   *
   * The ping is armed after `waitingDelayMs` so a request that settles instantly
   * (an auto-answered approval, an aborted question) never reaches the speaker.
   */
  function markWaiting(sessionId, key, kind) {
    if (!settings.notifyWaiting) return;
    let entry = waiting.get(sessionId);
    if (!entry) {
      entry = { keys: new Map(), timer: null, kind };
      waiting.set(sessionId, entry);
    }
    entry.keys.set(key, kind);
    entry.kind = kind;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.keys.size === 0) return;
      const pendingKind = entry.kind;
      entry.keys.clear();
      playWaiting(sessionId, pendingKind);
    }, settings.waitingDelayMs);
    entry.timer.unref?.();
  }

  /** One open request closed; the last one closing cancels the pending ping. */
  function clearWaiting(sessionId, key) {
    const entry = waiting.get(sessionId);
    if (!entry) return;
    entry.keys.delete(key);
    if (entry.keys.size === 0 && entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /**
   * `session/event` handler: the durable view of requests that need a person.
   *
   * A blocking `ask_user_question` (and the plan-review question it carries) is
   * visible as an open `tool/call` whose result has not been logged yet, and an
   * approval leaves `approval/asked` / `approval/decided` audit events. Reading
   * the commit feed keeps the notification independent of which answerer claims
   * the request waterfall.
   */
  function onSessionEvent(session, event) {
    if (!settings.notifyWaiting) return;
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const type = event?.type;
    const data = event?.data ?? {};

    if (type === 'tool/call') {
      if (ASK_TOOL_NAMES.has(data.name)) markWaiting(sessionId, `call:${data.callId ?? data.name}`, 'question');
      return;
    }
    if (type === 'tool/result') {
      const callId = data.callId ?? data.message?.toolCallId;
      if (callId) clearWaiting(sessionId, `call:${callId}`);
      return;
    }
    if (type === 'approval/asked') {
      markWaiting(sessionId, `approved:${data.callId ?? data.requestId ?? 'request'}`, 'approval');
      return;
    }
    if (type === 'approval/decided') {
      clearWaiting(sessionId, `approved:${data.callId ?? data.requestId ?? 'request'}`);
    }
  }

  /** `user-questions/request` observer: a second carrier, before any answerer claims it. */
  function onAskRequest(request, next) {
    const sessionId = request?.agent?.id;
    if (typeof sessionId === 'string' && sessionId) {
      markWaiting(sessionId, `ask:${request?.wait?.callId ?? 'request'}`, 'question');
    }
    return next();
  }

  /** `approval/request` observer. */
  function onApprovalRequest(request, next) {
    const sessionId = request?.agent?.id;
    if (typeof sessionId === 'string' && sessionId) {
      markWaiting(sessionId, `approved:${request?.callId ?? 'request'}`, 'approval');
    }
    return next();
  }

  /**
   * One status transition, from whichever event source reported it first.
   *
   * `agent/status` is the authoritative source; `api-session/status` is the
   * Host API's mirror of the same fact and stays as a second carrier so a
   * change on either side cannot silently turn the chime off. The in-flight map
   * makes that redundancy free: the second report of the same edge finds no
   * entry and does nothing.
   */
  function handleTransition(sessionId, running) {
    if (running === true) {
      if (!inFlight.has(sessionId)) {
        inFlight.set(sessionId, { startedAt: Date.now(), subagent: isSubagent(sessionId) });
        trace(`running ${sessionId}${inFlight.get(sessionId).subagent ? ' (subagent)' : ''}`);
      }
      const timer = settling.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        settling.delete(sessionId);
      }
      return;
    }

    const run = inFlight.get(sessionId);
    inFlight.delete(sessionId);
    if (!run) return;

    const elapsed = Date.now() - run.startedAt;
    if (elapsed < settings.minRunMs) {
      trace(`skip ${sessionId}: ran ${elapsed} ms (< ${settings.minRunMs} ms)`);
      return;
    }
    if (run.subagent && !settings.includeSubagents) {
      trace(`skip ${sessionId}: subagent`);
      return;
    }
    settle(sessionId, run.subagent ? 'subagent' : 'session');
  }

  /** `agent/status` handler. */
  function onAgentStatus(payload) {
    const sessionId = payload?.agent?.id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const status = payload?.status;
    if (status === 'running') handleTransition(sessionId, true);
    else if (status === 'idle') handleTransition(sessionId, false);
  }

  /** `api-session/status` handler: the same edge from the Host API mirror. */
  function onApiSessionStatus(sessionId, running) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (typeof running === 'boolean') handleTransition(sessionId, running);
  }

  /** `/chime …` — the quick control that works without leaving the keyboard. */
  function handleCommand(invocation) {
    const raw = String(invocation?.rawInput ?? '').trim();
    const [verb = 'status', ...rest] = raw.split(/\s+/);
    const argument = rest.join(' ').trim();
    const success = (text) => ({ kind: 'success', text });

    switch (verb.toLowerCase()) {
      case 'on':
        settings.enabled = true;
        return success(`提示音已开启（${describe()}）`);
      case 'off':
        settings.enabled = false;
        return success('提示音已关闭，输入 /chime on 恢复');
      case 'test': {
        const waitingTest = argument === 'waiting' || argument === 'ping';
        audio.mode = settings.mode;
        audio.sound = waitingTest ? 'ping' : 'chime';
        audio.volume = settings.volume;
        audio.speakText = waitingTest ? settings.waitingSpeakText : settings.speakText;
        audio.wavPath = settings.wavPath;
        const played = audio.play();
        if (played) lastPlayedAt = Date.now();
        return played
          ? success(`已播放${waitingTest ? '等待确认' : '完成'}测试音（${describe()}）`)
          : success('测试音播放失败，请查看 Host 日志');
      }
      case 'volume': {
        const parsed = Number(argument);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
          return { kind: 'error', text: '用法：/chime volume 0.05 ~ 1' };
        }
        settings.volume = Math.min(1, Math.max(0.05, parsed));
        audio.volume = settings.volume;
        return success(`音量已设为 ${settings.volume}`);
      }
      case 'mode': {
        if (argument !== 'chime' && argument !== 'speak') {
          return { kind: 'error', text: '用法：/chime mode chime|speak' };
        }
        settings.mode = argument;
        audio.mode = argument;
        return success(`提示方式已设为 ${argument}`);
      }
      case 'subagents': {
        if (argument !== 'on' && argument !== 'off') {
          return { kind: 'error', text: '用法：/chime subagents on|off' };
        }
        settings.includeSubagents = argument === 'on';
        return success(`子代理完成提示：${settings.includeSubagents ? '开' : '关'}`);
      }
      case 'waiting': {
        if (argument !== 'on' && argument !== 'off') {
          return { kind: 'error', text: '用法：/chime waiting on|off' };
        }
        settings.notifyWaiting = argument === 'on';
        return success(`等待确认提示：${settings.notifyWaiting ? '开' : '关'}`);
      }
      case 'status':
        return success(describe());
      default:
        return {
          kind: 'error',
          text: '用法：/chime [status|on|off|test [waiting]|volume <0.05~1>|mode <chime|speak>|waiting <on|off>|subagents <on|off>]',
        };
    }
  }

  function describe() {
    const parts = [
      settings.enabled ? '开启' : '关闭',
      settings.mode === 'speak' ? `语音「${settings.speakText}」` : `提示音 ${settings.volume}`,
      `冷却 ${settings.cooldownMs}ms`,
      `等待确认 ${settings.notifyWaiting ? '开' : '关'}`,
      settings.includeSubagents ? '含子代理' : '仅主会话',
    ];
    if (lastPlayed) {
      const seconds = Math.max(0, Math.round((Date.now() - lastPlayed.at) / 1000));
      parts.push(`${seconds}s 前响过一次`);
    }
    return parts.join(' · ');
  }

  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', onAgentStatus);
    const offApiStatus = ctx.on('api-session/status', onApiSessionStatus);
    const offSessionEvent = ctx.on('session/event', onSessionEvent);
    const offAsk = ctx.on('user-questions/request', onAskRequest);
    const offApproval = ctx.on('approval/request', onApprovalRequest);
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      const sessionId = payload?.agent?.id;
      if (typeof sessionId !== 'string') return;
      inFlight.delete(sessionId);
      const timer = settling.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        settling.delete(sessionId);
      }
      const wait = waiting.get(sessionId);
      if (wait) {
        if (wait.timer) clearTimeout(wait.timer);
        waiting.delete(sessionId);
      }
    });

    let offCommand = null;
    const commands = ctx.get('commands');
    if (commands?.register) {
      try {
        offCommand = commands.register({
          name: 'chime',
          description: '完成/需要确认提示音：开关、测试、音量、语音播报',
          input: {
            hint: 'status|on|off|test [waiting]|volume <0.05~1>|mode <chime|speak>|waiting <on|off>|subagents <on|off>',
          },
          handler: handleCommand,
        });
      } catch (error) {
        trace(`command registration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    note(
      `active: ${settings.enabled ? 'on' : 'off'}, ${settings.mode}, volume ${settings.volume}, ` +
        `settle ${settings.settleMs} ms, cooldown ${settings.cooldownMs} ms, ` +
        `waiting ${settings.notifyWaiting ? 'on' : 'off'}, subagents ${settings.includeSubagents ? 'included' : 'excluded'}`,
    );

    return () => {
      offStatus?.();
      offApiStatus?.();
      offSessionEvent?.();
      offAsk?.();
      offApproval?.();
      offDisposed?.();
      offCommand?.();
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
      inFlight.clear();
      for (const entry of waiting.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      waiting.clear();
      audio.dispose();
    };
  }, 'session-chime');
}
