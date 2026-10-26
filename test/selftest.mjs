/**
 * Self-test for the session-chime bundle.
 *
 * It drives the real `apply()` through a minimal fake Cordis context and the
 * real desktop audio module, with a silent WAV substituted for the chime, so the
 * whole chain (event → policy → spawn → playback) runs without making noise.
 * The decision trace is asserted from the plugin's own log file.
 *
 *   node test/selftest.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DesktopChime, renderChime, renderPing } from '../audio.js';
import { apply } from '../index.js';

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid, silent 60 ms WAV so playback is silent but still real. */
function silentWav(seconds = 0.06) {
  const rate = 44100;
  const frames = Math.floor(rate * seconds);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}

// ---------------------------------------------------------------- asset checks
console.log('audio asset');
{
  const wav = renderChime(0.8);
  const peak = (() => {
    let max = 0;
    for (let offset = 44; offset + 1 < wav.length; offset += 2) max = Math.max(max, Math.abs(wav.readInt16LE(offset)));
    return max;
  })();
  check('chime is a RIFF/WAVE file', wav.subarray(0, 4).toString('ascii') === 'RIFF' && wav.subarray(8, 12).toString('ascii') === 'WAVE');
  check('chime is 1 s of 44.1 kHz mono 16-bit', wav.readUInt32LE(24) === 44100 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16 && Math.round((wav.length - 44) / 2 / 44100 * 100) / 100 === 1);
  check('chime is normalized near full scale at volume 1', (() => {
    const loud = renderChime(1);
    let loudPeak = 0;
    for (let offset = 44; offset + 1 < loud.length; offset += 2) loudPeak = Math.max(loudPeak, Math.abs(loud.readInt16LE(offset)));
    return loudPeak > 27000 && loudPeak <= 32767;
  })());
  check('quieter volume renders quieter audio', (() => {
    const soft = renderChime(0.2);
    let softPeak = 0;
    for (let offset = 44; offset + 1 < soft.length; offset += 2) softPeak = Math.max(softPeak, Math.abs(soft.readInt16LE(offset)));
    return softPeak < peak / 2;
  })());
  const ping = renderPing(0.8);
  let pingPeak = 0;
  for (let offset = 44; offset + 1 < ping.length; offset += 2) pingPeak = Math.max(pingPeak, Math.abs(ping.readInt16LE(offset)));
  check('the attention clip is a distinct, shorter sound', ping.length < wav.length * 0.6 && pingPeak > 15000 && pingPeak <= 32767, `bytes=${ping.length} peak=${pingPeak}`);
  check('desktop audio backend is available', DesktopChime.supported);
}

// ---------------------------------------------------------------- fake context
const directory = mkdtempSync(join(tmpdir(), 'session-chime-selftest-'));
const silentPath = join(directory, 'silent.wav');
const logPath = join(directory, 'trace.log');
writeFileSync(silentPath, silentWav());

const listeners = new Map();
const registeredCommands = [];
const sessions = new Map();
let disposer = null;

const ctx = {
  on(name, listener) {
    const bucket = listeners.get(name) ?? [];
    bucket.push(listener);
    listeners.set(name, bucket);
    return () => {
      const current = listeners.get(name) ?? [];
      listeners.set(name, current.filter((entry) => entry !== listener));
    };
  },
  effect(callback) {
    disposer = callback();
    return () => disposer?.();
  },
  get(name) {
    if (name === 'sessions') return { get: (id) => sessions.get(id) };
    if (name === 'commands') {
      return {
        register: (definition) => {
          registeredCommands.push(definition);
          return () => {};
        },
      };
    }
    return undefined;
  },
};

function emit(name, ...args) {
  for (const listener of listeners.get(name) ?? []) listener(...args);
}
function start(sessionId, origin) {
  sessions.set(sessionId, { header: { id: sessionId, origin } });
  emit('agent/status', { agent: { id: sessionId }, status: 'running' });
}
function stop(sessionId) {
  emit('agent/status', { agent: { id: sessionId }, status: 'idle' });
}
function trace() {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- behavior
console.log('plugin behavior');
apply(ctx, {
  enabled: true,
  mode: 'chime',
  volume: 0.5,
  wavPath: silentPath,
  cooldownMs: 800,
  settleMs: 20,
  minRunMs: 100,
  includeSubagents: false,
  notifyWaiting: true,
  waitingDelayMs: 100,
  waitingDedupeMs: 200,
  logFile: logPath,
});

check('registers a global /chime command', registeredCommands.length === 1 && registeredCommands[0].name === 'chime');
check('subscribes to agent/status', (listeners.get('agent/status') ?? []).length === 1);

// too short to count
start('s0-main');
await sleep(20);
stop('s0-main');
await sleep(120);
check('ignores a run shorter than minRunMs', trace().includes('skip s0-main: ran'));

// a real completion plays
start('s1-main');
await sleep(140);
stop('s1-main');
await sleep(160);
check('plays for a completed main session', trace().includes('played chime for s1-main (session)'), trace().split('\n').slice(-4).join(' | '));
check('started the audio helper for that chime', trace().includes('audio helper started'));

// a second completion inside the cooldown is suppressed
start('s2-main');
await sleep(140);
stop('s2-main');
await sleep(80);
check('suppresses a completion inside cooldownMs', trace().includes('skip s2-main: cooldown'));

// subagents are excluded by default
await sleep(340);
start('s3-child', 'subagent');
await sleep(140);
stop('s3-child');
await sleep(120);
check('skips a subagent completion', trace().includes('skip s3-child: subagent'));

// /chime off mutes, /chime on restores
await sleep(340);
const offResult = registeredCommands[0].handler({ rawInput: 'off' });
check('/chime off succeeds', offResult.kind === 'success' && offResult.text.includes('关闭'));
start('s4-main');
await sleep(140);
stop('s4-main');
await sleep(120);
check('a disabled plugin plays nothing', trace().includes('skip s4-main: disabled'));
check('/chime on succeeds', registeredCommands[0].handler({ rawInput: 'on' }).kind === 'success');

// /chime volume reaches the audio request
await sleep(340);
const volumeResult = registeredCommands[0].handler({ rawInput: 'volume 0.3' });
check('/chime volume sets the level', volumeResult.kind === 'success' && volumeResult.text.includes('0.3'));

// a follow-up arriving during the settle delay cancels the chime
start('s5-main');
await sleep(140);
stop('s5-main');
await sleep(5);
start('s5-main');
await sleep(140);
check('does not play when the session resumes during settle', !trace().includes('played chime for s5-main'));

// the next real completion plays at the new volume
await sleep(340);
start('s6-main');
await sleep(140);
stop('s6-main');
await sleep(160);
check('plays again once the cooldown passed', trace().includes('played chime for s6-main (session)'));
check('the new volume reached the audio helper', trace().includes('chime requested (0.3)'), trace().split('\n').slice(-3).join(' | '));

const status = registeredCommands[0].handler({ rawInput: 'status' });
check('/chime status reports the live settings', status.kind === 'success' && status.text.includes('开启') && status.text.includes('冷却'));

// both status carriers describe the same edge: it must play once, not twice
await sleep(900);
emit('agent/status', { agent: { id: 's8-main' }, status: 'running' });
emit('api-session/status', 's8-main', true);
await sleep(140);
emit('agent/status', { agent: { id: 's8-main' }, status: 'idle' });
emit('api-session/status', 's8-main', false);
await sleep(160);
const duplicatePlays = (trace().match(/played chime for s8-main/g) ?? []).length;
check('both status carriers produce exactly one chime', duplicatePlays === 1, `plays=${duplicatePlays}`);

// the API mirror alone is enough to drive a chime
await sleep(900);
emit('api-session/status', 's9-main', true);
await sleep(140);
emit('api-session/status', 's9-main', false);
await sleep(160);
check('the api-session/status carrier alone drives a chime', trace().includes('played chime for s9-main (session)'));

// ---------------------------------------------------------------- waiting for a person
console.log('waiting for a person');
await sleep(900);

// a blocking question announces itself while the agent is parked
emit('session/event', { id: 's10-main' }, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } });
await sleep(200);
check('pings while the agent waits for an answer', trace().includes('played ping for s10-main (question)'), trace().split('\n').slice(-3).join(' | '));
check('the ping is a different clip from the completion chime', trace().includes('ping requested'));

// an answer that arrives before the delay never reaches the speaker
emit('session/event', { id: 's11-main' }, { type: 'tool/call', data: { callId: 'c2', name: 'ask_user_question' } });
await sleep(20);
emit('session/event', { id: 's11-main' }, { type: 'tool/result', data: { message: { toolCallId: 'c2' } } });
await sleep(200);
check('stays quiet when the question settles instantly', !trace().includes('s11-main'));

// an approval request pings through its audit event
await sleep(300);
emit('session/event', { id: 's12-main' }, { type: 'approval/asked', data: { callId: 'a1' } });
await sleep(200);
check('pings when an approval is requested', trace().includes('played ping for s12-main (approval)'));

// the request waterfall is a second carrier and must stay unclaimed
await sleep(300);
let released = false;
const next = () => {
  released = true;
  return Promise.resolve('allowed-once');
};
emit('user-questions/request', { agent: { id: 's13-main' }, questions: [] }, next);
await sleep(200);
check('an ask request also pings', trace().includes('played ping for s13-main (question)'));
check('the observer delegates instead of claiming the request', released === true);

// the waiting signal has its own switch
await sleep(300);
const waitingOff = registeredCommands[0].handler({ rawInput: 'waiting off' });
check('/chime waiting off succeeds', waitingOff.kind === 'success' && waitingOff.text.includes('关'));
emit('session/event', { id: 's14-main' }, { type: 'tool/call', data: { callId: 'c4', name: 'ask_user_question' } });
await sleep(200);
check('waiting notifications can be switched off', !trace().includes('s14-main'));
registeredCommands[0].handler({ rawInput: 'waiting on' });

// the explicit test gesture plays the attention clip
const testWaiting = registeredCommands[0].handler({ rawInput: 'test waiting' });
check('/chime test waiting plays the attention clip', testWaiting.kind === 'success' && testWaiting.text.includes('等待确认'));

// ---------------------------------------------------------------- teardown
console.log('teardown');
disposer?.();
await sleep(300);
check('unsubscribes on dispose', (listeners.get('agent/status') ?? []).length === 0);
start('s7-main');
await sleep(140);
stop('s7-main');
await sleep(120);
check('plays nothing after dispose', !trace().includes('s7-main'));

console.log('');
if (failures.length) {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  console.log(`kept ${directory} for inspection`);
  process.exitCode = 1;
} else {
  rmSync(directory, { recursive: true, force: true });
  console.log('all checks passed');
}
