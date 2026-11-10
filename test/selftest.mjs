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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DesktopChime, assetName, renderChime, renderPing } from '../audio.js';
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

/**
 * 20 ms RMS envelope of a rendered WAV, in dBFS. Used below to assert the two
 * earcons differ in *rhythm*, which is the cue that survives a bad speaker.
 */
function envelope(wav, blockMs = 20) {
  const rate = wav.readUInt32LE(24);
  const frames = (wav.length - 44) / 2;
  const block = Math.max(1, Math.round((rate * blockMs) / 1000));
  const levels = [];
  for (let start = 0; start < frames; start += block) {
    let sum = 0;
    let count = 0;
    for (let i = start; i < Math.min(frames, start + block); i += 1) {
      const value = wav.readInt16LE(44 + i * 2) / 32768;
      sum += value * value;
      count += 1;
    }
    levels.push(20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, count)), 1e-9)));
  }
  return levels;
}

/**
 * Indices where a block rises `riseDb` above the previous one — an attack.
 *
 * Block 0 counts when the clip starts loud, and the threshold is low because a
 * note landing on the previous note's tail only rises a few dB even though it is
 * plainly audible. The floor keeps the fade-out tail out of the count.
 */
function onsets(levels, riseDb = 2, floorDb = -45) {
  const found = [];
  if (levels.length > 0 && levels[0] > floorDb) found.push(0);
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] > floorDb && levels[i] - levels[i - 1] > riseDb) found.push(i);
  }
  return found;
}

/** Highest sample magnitude in a rendered WAV. */
function peakOf(wav) {
  let peak = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  }
  return peak;
}

/** Overall RMS in dBFS — enough to compare two clips' levels without a meter. */
function rmsOf(wav) {
  const frames = (wav.length - 44) / 2;
  let sum = 0;
  for (let i = 0; i < frames; i += 1) {
    const value = wav.readInt16LE(44 + i * 2) / 32768;
    sum += value * value;
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, frames)), 1e-9));
}

// ---------------------------------------------------------------- asset checks
console.log('audio asset');
{
  const wav = renderChime(0.8);
  const peak = peakOf(wav);
  check('chime is a RIFF/WAVE file', wav.subarray(0, 4).toString('ascii') === 'RIFF' && wav.subarray(8, 12).toString('ascii') === 'WAVE');
  check('chime is ~1.15 s of 44.1 kHz mono 16-bit', wav.readUInt32LE(24) === 44100 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16 && Math.round((wav.length - 44) / 2 / 44100 * 100) / 100 === 1.15);
  check('chime is normalized near full scale at volume 1', (() => {
    const loudPeak = peakOf(renderChime(1));
    return loudPeak > 27000 && loudPeak <= 32767;
  })());
  check('quieter volume renders quieter audio', peakOf(renderChime(0.2)) < peak / 2);
  check('nothing clips at volume 1', peakOf(renderChime(1)) < 32767 && peakOf(renderPing(1)) < 32767);

  const ping = renderPing(0.8);
  check('the attention clip is a distinct, shorter sound', ping.length < wav.length * 0.6 && peakOf(ping) > 15000 && peakOf(ping) <= 32767, `bytes=${ping.length} peak=${peakOf(ping)}`);
  check('desktop audio backend is available', DesktopChime.supported);

  // The pair has to be told apart across a room. Pitch is a weak cue for that;
  // rhythm, decay and contour are strong ones, so assert all three differ.
  const chimeHits = onsets(envelope(wav));
  const pingHits = onsets(envelope(ping));
  check('the completion earcon is two events', chimeHits.length === 2, `onsets at ${chimeHits.map((index) => index * 20)} ms`);
  check('the attention earcon is three events', pingHits.length === 3, `onsets at ${pingHits.map((index) => index * 20)} ms`);

  const chimeSpacing = chimeHits[1] - chimeHits[0];
  const pingSpacing = pingHits[1] - pingHits[0];
  check(
    'the attention rhythm is faster than the completion rhythm',
    pingSpacing < chimeSpacing,
    `chime ${chimeSpacing * 20} ms apart, ping ${pingSpacing * 20} ms apart`,
  );

  const chimeLevels = envelope(wav);
  check('the completion earcon rings for about a second', chimeLevels.length >= 55, `${chimeLevels.length * 20} ms`);
  check('the attention earcon stops within a second', envelope(ping).length <= 40, `${envelope(ping).length * 20} ms`);

  check('both clips end in silence, not on a step', (() => {
    const finalSample = (file) => {
      const frames = (file.length - 44) / 2;
      return file.readInt16LE(44 + (frames - 1) * 2);
    };
    return finalSample(wav) === 0 && finalSample(ping) === 0;
  })());

  const levelGap = Math.abs(rmsOf(wav) - rmsOf(ping));
  check('the pair sits at a comparable level, so neither startles', levelGap < 3, `${levelGap.toFixed(1)} dB apart`);

  // A cached clip from an older synthesis version must never be reused.
  const name = assetName('chime', 0.8);
  check('the cache name carries the synthesis version', /-v\d+-/.test(name), name);
  check('the cache name carries a spec hash, so edits invalidate it', /-v\d+-[0-9a-f]{8}-/.test(name), name);
  check('a different volume is a different asset', assetName('chime', 0.8) !== assetName('chime', 0.9));
  check('the two earcons never share a cache file', assetName('chime', 0.8) !== assetName('ping', 0.8));
}

// ---------------------------------------------------------------- asset cache
console.log('asset cache');
{
  const first = new DesktopChime({ volume: 0.37, log: () => {} });
  const path = first.resolveWav();
  check('resolving a clip writes it to the temp dir', existsSync(path) && path.endsWith('.wav'), path);
  check('resolving twice reuses the same file', first.resolveWav() === path);

  const other = new DesktopChime({ volume: 0.41, log: () => {} });
  check('a different volume resolves to its own file', other.resolveWav() !== path);

  // A truncated file (a crashed write, a half-copied asset) must be repaired.
  writeFileSync(path, Buffer.alloc(64));
  const repaired = new DesktopChime({ volume: 0.37, log: () => {} }).resolveWav();
  check('a truncated cached clip is rewritten', readFileSync(repaired).length > 1024);
  rmSync(path, { force: true });
  rmSync(other.resolveWav(), { force: true });
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
check('started the audio helper for that chime', trace().includes('audio helper started') || trace().includes('/usr/bin/afplay started'));

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

// Regression: `playWaiting` leaves the shared output on the attention clip. A
// completion arriving afterwards must switch it back, or every chime after the
// first question plays the "you are needed" ping instead of "done".
await sleep(900);
const beforeCompletion = trace().length;
start('s15-main');
await sleep(140);
stop('s15-main');
await sleep(200);
{
  const after = trace().slice(beforeCompletion);
  check('a completion after a ping plays the completion clip', after.includes('chime requested'), after.split('\n').slice(-3).join(' | '));
  check('and not the attention clip again', !after.includes('ping requested'));
}

// `/chime test both` plays the pair so the two can be compared in one gesture
await sleep(300);
const testBoth = registeredCommands[0].handler({ rawInput: 'test both' });
check('/chime test both is a success', testBoth.kind === 'success' && testBoth.text.includes('1.4'));
check('/chime test both plays the completion clip first', trace().split('\n').slice(-3).join('|').includes('chime requested'));

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
