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

import { DesktopChime, SOUND_IDS, assetName, renderSound } from '../audio.js';
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

/** 20 ms RMS envelope of a rendered WAV, in dBFS. */
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

/** Zero-crossing rate over a frame range: a cheap pitch proxy. */
function zeroCrossingRate(wav, from, to) {
  const frames = (wav.length - 44) / 2;
  const start = Math.max(0, Math.floor(frames * from));
  const end = Math.min(frames, Math.floor(frames * to));
  let crossings = 0;
  let previous = 0;
  for (let i = start; i < end; i += 1) {
    const value = wav.readInt16LE(44 + i * 2);
    if ((value >= 0) !== (previous >= 0)) crossings += 1;
    previous = value;
  }
  return crossings / Math.max(1, end - start);
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

/** Final sample of a clip; a fade that ends on a step shows up here. */
function finalSample(wav) {
  const frames = (wav.length - 44) / 2;
  return wav.readInt16LE(44 + (frames - 1) * 2);
}

// ---------------------------------------------------------------- asset checks
console.log('audio assets');
{
  const clips = Object.fromEntries(SOUND_IDS.map((id) => [id, renderSound(id, 0.8)]));
  const wav = clips.chime;

  check('chime is a RIFF/WAVE file', wav.subarray(0, 4).toString('ascii') === 'RIFF' && wav.subarray(8, 12).toString('ascii') === 'WAVE');
  check('chime is ~1.15 s of 44.1 kHz mono 16-bit', wav.readUInt32LE(24) === 44100 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16 && Math.round((wav.length - 44) / 2 / 44100 * 100) / 100 === 1.15);
  check('chime is normalized near full scale at volume 1', peakOf(renderSound('chime', 1)) > 27000 && peakOf(renderSound('chime', 1)) <= 32767);
  check('quieter volume renders quieter audio', peakOf(renderSound('chime', 0.2)) < peakOf(wav) / 2);
  check('no sound clips at volume 1', SOUND_IDS.every((id) => peakOf(renderSound(id, 1)) < 32767));
  check('every sound ends on silence, not a step', SOUND_IDS.every((id) => finalSample(clips[id]) === 0));
  check('desktop audio backend is available', DesktopChime.supported);

  // The vocabulary is generated by two rules — direction says good/bad, event
  // count says how much is asked of you — so those are what the test asserts.
  const counts = Object.fromEntries(SOUND_IDS.map((id) => [id, onsets(envelope(clips[id])).length]));
  check('completion is two events (done, stated once)', counts.chime === 2, `onsets ${counts.chime}`);
  check('a decision is three events (come back and decide)', counts.ping === 3, `onsets ${counts.ping}`);
  check('an approval is two events (one click)', counts.nudge === 2, `onsets ${counts.nudge}`);
  check('a failure is two events (bad news, stated once)', counts.error === 2, `onsets ${counts.error}`);
  check('information is one event (nothing asked)', counts.info === 1, `onsets ${counts.info}`);

  const rise = (id) => zeroCrossingRate(clips[id], 0.65, 0.98) - zeroCrossingRate(clips[id], 0.05, 0.35);
  check('the completion figure rises', rise('chime') > 0.005, rise('chime').toFixed(4));
  check('the decision figure rises', rise('ping') > 0.005, rise('ping').toFixed(4));
  check('the approval figure stays flat', Math.abs(rise('nudge')) < 0.003, rise('nudge').toFixed(4));
  check('the failure figure falls', rise('error') < -0.002, rise('error').toFixed(4));

  check('the failure tone is the only descending figure', (() => {
    const descending = SOUND_IDS.filter((id) => rise(id) < -0.002);
    return descending.length === 1 && descending[0] === 'error';
  })());

  const levels = Object.fromEntries(SOUND_IDS.map((id) => [id, rmsOf(clips[id])]));
  const peaks = Object.fromEntries(SOUND_IDS.map((id) => [id, 20 * Math.log10(peakOf(clips[id]) / 32768)]));
  check('attention out-peaks information, so a child tick cannot pull focus', peaks.ping > peaks.info + 2, `${peaks.ping.toFixed(1)} vs ${peaks.info.toFixed(1)} dBFS`);
  check('information is the quietest tone', Math.min(...Object.values(levels)) === levels.info);
  check('the two actionable tones sit at a comparable level', Math.abs(levels.ping - levels.nudge) < 3);

  const name = assetName('chime', 0.8);
  check('the cache name carries the synthesis version', /-v\d+-/.test(name), name);
  check('the cache name carries a spec hash, so edits invalidate it', /-v\d+-[0-9a-f]{8}-/.test(name), name);
  check('a different volume is a different asset', assetName('chime', 0.8) !== assetName('chime', 0.9));
  check('no two sounds share a cache file', new Set(SOUND_IDS.map((id) => assetName(id, 0.8))).size === SOUND_IDS.length);
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

  if (process.platform !== 'win32') {
    const resolved = new DesktopChime({ log: () => {} }).resolvePlayer();
    check('the resolved player is an absolute path that exists', resolved !== null && existsSync(resolved.command), JSON.stringify(resolved));
  }

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
const runningJobs = new Map();
const jobListeners = [];
let disposer = null;

const jobsService = {
  list(agent) {
    const count = runningJobs.get(agent?.id) ?? 0;
    if (count === 0) return [];
    return [{
      id: 'bash-1',
      kind: 'bash',
      label: 'long render',
      ownerSession: agent.id,
      status: 'running',
      startedAt: Date.now(),
    }];
  },
  onJobDone(listener) {
    jobListeners.push(listener);
    return () => {
      const index = jobListeners.indexOf(listener);
      if (index >= 0) jobListeners.splice(index, 1);
    };
  },
};

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
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { id } : undefined) };
    if (name === 'jobs') return jobsService;
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
/** End the open turn with a structured reason, the way the agent loop does. */
function endTurn(sessionId, kind = 'completed') {
  emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind } } });
}
function finishJob(sessionId) {
  runningJobs.set(sessionId, 0);
  for (const listener of jobListeners) listener({ id: 'bash-1', ownerSession: sessionId, status: 'completed' }, { id: sessionId });
}
function trace() {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}
/** Trace written since a marker, so a repeat of an older line cannot pass a check. */
function since(marker) {
  return trace().slice(marker);
}
const mark = () => trace().length;

// ---------------------------------------------------------------- behavior
console.log('plugin behavior');
apply(ctx, {
  enabled: true,
  mode: 'chime',
  volume: 0.5,
  wavPath: silentPath,
  cooldownMs: 400,
  settleMs: 20,
  minRunMs: 100,
  includeSubagents: false,
  subagentAggregateMs: 300,
  notifyWaiting: true,
  notifyOnFailure: true,
  notifyOnAbort: false,
  splitWaiting: true,
  deferWhileBusy: true,
  waitingDelayMs: 100,
  waitingDedupeMs: 200,
  logFile: logPath,
});

check('registers a global /chime command', registeredCommands.length === 1 && registeredCommands[0].name === 'chime');
check('subscribes to agent/status', (listeners.get('agent/status') ?? []).length === 1);
check('subscribes to background job completion', jobListeners.length === 1);

// too short to count
start('s0-main');
await sleep(20);
stop('s0-main');
await sleep(120);
check('ignores a run shorter than minRunMs', trace().includes('skip s0-main: ran'));

// a real completion plays
start('s1-main');
endTurn('s1-main');
await sleep(140);
stop('s1-main');
await sleep(160);
check('plays for a completed main session', trace().includes('played chime for s1-main (completed)'), trace().split('\n').slice(-4).join(' | '));
check('started the audio helper for that chime', trace().includes('audio helper started') || trace().includes('/usr/bin/afplay started'));

// a second completion inside the cooldown is suppressed
start('s2-main');
endTurn('s2-main');
await sleep(140);
stop('s2-main');
await sleep(80);
check('suppresses a completion inside cooldownMs', trace().includes('skip s2-main: chime cooldown'));

// subagents are excluded by default
await sleep(200);
start('s3-child', 'subagent');
endTurn('s3-child');
await sleep(140);
stop('s3-child');
await sleep(120);
check('skips a subagent completion by default', trace().includes('skip s3-child: outcome subagent/info is silent'), trace().split('\n').slice(-3).join(' | '));

// a failed turn must not sound like a completed one
await sleep(200);
start('s4-main');
endTurn('s4-main', 'error');
await sleep(140);
stop('s4-main');
await sleep(160);
check('a failed turn plays the failure tone', trace().includes('played error for s4-main (error)'), trace().split('\n').slice(-4).join(' | '));

// ... and the failure tone is not swallowed by a recent completion
await sleep(1100);
const beforeBypass = mark();
start('s5-main');
endTurn('s5-main');
await sleep(140);
stop('s5-main');
await sleep(60);
start('s6-main');
endTurn('s6-main', 'error');
await sleep(140);
stop('s6-main');
await sleep(160);
{
  const window = since(beforeBypass);
  check('a failure is not swallowed by a completion just before it', window.includes('played error for s6-main'), window.split('\n').slice(-5).join(' | '));
}

// blocked and truncated turns are failures too
await sleep(1100);
const beforeKinds = mark();
start('s7-main');
endTurn('s7-main', 'blocked');
await sleep(140);
stop('s7-main');
await sleep(160);
check('a blocked turn plays the failure tone', since(beforeKinds).includes('played error for s7-main (blocked)'), since(beforeKinds));

// a cancelled turn is silent by default: the person pressed stop
const beforeAbort = mark();
await sleep(200);
start('s8-main');
endTurn('s8-main', 'aborted');
await sleep(140);
stop('s8-main');
await sleep(160);
check('a cancelled turn is silent by default', since(beforeAbort).includes('skip s8-main: outcome aborted'), since(beforeAbort));
check('and plays nothing', !since(beforeAbort).includes('played '));

// /chime off mutes, /chime on restores
await sleep(200);
const offResult = registeredCommands[0].handler({ rawInput: 'off' });
check('/chime off succeeds', offResult.kind === 'success' && offResult.text.includes('关闭'));
start('s9-main');
endTurn('s9-main');
await sleep(140);
stop('s9-main');
await sleep(120);
check('a disabled plugin plays nothing', trace().includes('skip s9-main: disabled'));
check('/chime on succeeds', registeredCommands[0].handler({ rawInput: 'on' }).kind === 'success');

// /chime volume reaches the audio request
await sleep(200);
const volumeResult = registeredCommands[0].handler({ rawInput: 'volume 0.3' });
check('/chime volume sets the level', volumeResult.kind === 'success' && volumeResult.text.includes('0.3'));

// a follow-up arriving during the settle delay cancels the chime
start('s10-main');
endTurn('s10-main');
await sleep(140);
stop('s10-main');
await sleep(5);
start('s10-main');
endTurn('s10-main');
await sleep(140);
check('does not play when the session resumes during settle', !trace().includes('played chime for s10-main'));

// the next real completion plays at the new volume
await sleep(200);
start('s11-main');
endTurn('s11-main');
await sleep(140);
stop('s11-main');
await sleep(160);
check('plays again once the cooldown passed', trace().includes('played chime for s11-main (completed)'));
check('the new volume reached the audio player', trace().includes('chime requested (0.3)'), trace().split('\n').slice(-3).join(' | '));

const status = registeredCommands[0].handler({ rawInput: 'status' });
check('/chime status reports the live settings', status.kind === 'success' && status.text.includes('开启') && status.text.includes('冷却') && status.text.includes('失败 开'));

// both status carriers describe the same edge: it must play once, not twice
await sleep(400);
emit('agent/status', { agent: { id: 's12-main' }, status: 'running' });
emit('api-session/status', 's12-main', true);
endTurn('s12-main');
await sleep(140);
emit('agent/status', { agent: { id: 's12-main' }, status: 'idle' });
emit('api-session/status', 's12-main', false);
await sleep(160);
check('both status carriers produce exactly one chime', (trace().match(/played chime for s12-main/g) ?? []).length === 1);

// the API mirror alone is enough to drive a chime
await sleep(400);
emit('api-session/status', 's13-main', true);
await sleep(140);
emit('api-session/status', 's13-main', false);
await sleep(160);
check('the api-session/status carrier alone drives a chime', trace().includes('played chime for s13-main (completed)'));

// ---------------------------------------------------------------- subagents
console.log('subagents');
await sleep(400);
// Turn the tier on: a child's completion is information, not "done".
registeredCommands[0].handler({ rawInput: 'subagents on' });
start('s14-child', 'subagent');
endTurn('s14-child');
await sleep(140);
stop('s14-child');
await sleep(160);
check('a child completion plays the information tone', trace().includes('played info for s14-child (subagent/info)'), trace().split('\n').slice(-4).join(' | '));

// a burst of children must not become a burst of ticks
const beforeBurst = mark();
for (const id of ['s15-child', 's16-child', 's17-child']) {
  start(id, 'subagent');
  endTurn(id);
  await sleep(140);
  stop(id);
  await sleep(60);
}
check('child ticks are aggregated', since(beforeBurst).includes('info aggregated'), since(beforeBurst).split('\n').slice(-4).join(' | '));
registeredCommands[0].handler({ rawInput: 'subagents off' });

// ---------------------------------------------------------------- waiting for a person
console.log('waiting for a person');
await sleep(400);

// a blocking question announces itself while the agent is parked
emit('session/event', { id: 's20-main' }, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } });
await sleep(200);
check('pings while the agent waits for an answer', trace().includes('played ping for s20-main (question)'), trace().split('\n').slice(-3).join(' | '));

// an approval is one click, so it gets the two-pip figure
await sleep(300);
emit('session/event', { id: 's21-main' }, { type: 'approval/asked', data: { callId: 'a1' } });
await sleep(200);
check('an approval request plays the two-pip approval tone', trace().includes('played nudge for s21-main (approval)'), trace().split('\n').slice(-3).join(' | '));

// an answer that arrives before the delay never reaches the speaker
emit('session/event', { id: 's22-main' }, { type: 'tool/call', data: { callId: 'c2', name: 'ask_user_question' } });
await sleep(20);
emit('session/event', { id: 's22-main' }, { type: 'tool/result', data: { message: { toolCallId: 'c2' } } });
await sleep(200);
check('stays quiet when the question settles instantly', !trace().includes('s22-main'));

// the request waterfall is a second carrier and must stay unclaimed
await sleep(300);
let released = false;
const next = () => {
  released = true;
  return Promise.resolve('allowed-once');
};
emit('user-questions/request', { agent: { id: 's23-main' }, questions: [] }, next);
await sleep(200);
check('an ask request also pings', trace().includes('played ping for s23-main (question)'));
check('the observer delegates instead of claiming the request', released === true);

// the waiting signal has its own switch
await sleep(300);
const waitingOff = registeredCommands[0].handler({ rawInput: 'waiting off' });
check('/chime waiting off succeeds', waitingOff.kind === 'success' && waitingOff.text.includes('关'));
emit('session/event', { id: 's24-main' }, { type: 'tool/call', data: { callId: 'c4', name: 'ask_user_question' } });
await sleep(200);
check('waiting notifications can be switched off', !trace().includes('s24-main'));
registeredCommands[0].handler({ rawInput: 'waiting on' });

// ---------------------------------------------------------------- shared output
console.log('shared output');
await sleep(400);

// Regression: `playWaiting` leaves the shared output on the attention clip. A
// completion arriving afterwards must switch it back, or every chime after the
// first question plays the "you are needed" ping instead of "done".
const beforeCompletion = mark();
start('s30-main');
endTurn('s30-main');
await sleep(140);
stop('s30-main');
await sleep(200);
{
  const window = since(beforeCompletion);
  check('a completion after a ping plays the completion clip', window.includes('chime requested'), window.split('\n').slice(-3).join(' | '));
  check('and not the attention clip again', !window.includes('ping requested'));
}

// ---------------------------------------------------------------- deferred completion
console.log('background jobs');
await sleep(400);
const beforeDefer = mark();
runningJobs.set('s40-main', 1);
start('s40-main');
endTurn('s40-main');
await sleep(140);
stop('s40-main');
await sleep(200);
check('a session with a running job does not ring "done" yet', !since(beforeDefer).includes('played chime for s40-main'), since(beforeDefer));
check('the completion is held instead', since(beforeDefer).includes('deferred s40-main'), since(beforeDefer));

finishJob('s40-main');
await sleep(120);
check('the held completion rings when the job settles', since(beforeDefer).includes('played chime for s40-main (completed)'), since(beforeDefer).split('\n').slice(-3).join(' | '));

// a held completion is dropped when the session starts working again
await sleep(400);
const beforeResume = mark();
runningJobs.set('s41-main', 1);
start('s41-main');
endTurn('s41-main');
await sleep(140);
stop('s41-main');
await sleep(200);
check('the completion is held while the job runs', since(beforeResume).includes('deferred s41-main'), since(beforeResume));
start('s41-main');
await sleep(60);
check('a resumed session drops the held completion', since(beforeResume).includes('dropped deferred s41-main: session resumed'), since(beforeResume));
finishJob('s41-main');
await sleep(120);
check('and it does not ring afterwards', !since(beforeResume).includes('played chime for s41-main'), since(beforeResume));
stop('s41-main');
await sleep(200);

// a held completion for a session that was disposed is dropped, not played
await sleep(400);
const beforeGone = mark();
runningJobs.set('s42-main', 1);
start('s42-main');
endTurn('s42-main');
await sleep(140);
stop('s42-main');
await sleep(200);
sessions.delete('s42-main');
emit('agent/disposed', { agent: { id: 's42-main' } });
finishJob('s42-main');
await sleep(120);
check('a disposed session never rings late', since(beforeGone).includes('deferred s42-main') && !since(beforeGone).includes('played chime for s42-main'), since(beforeGone).split('\n').slice(-4).join(' | '));

// ---------------------------------------------------------------- test gesture
console.log('/chime test');
await sleep(400);
const testAll = registeredCommands[0].handler({ rawInput: 'test all' });
check('/chime test all is a success', testAll.kind === 'success' && testAll.text.includes('chime / ping / nudge / error / info'), testAll.text);
check('/chime test all plays the first tone immediately', trace().split('\n').slice(-3).join('|').includes('chime requested'));

const testFailure = registeredCommands[0].handler({ rawInput: 'test error' });
check('/chime test error plays the failure tone', testFailure.kind === 'success' && testFailure.text.includes('error'));
check('/chime test nudge plays the approval tone', registeredCommands[0].handler({ rawInput: 'test nudge' }).kind === 'success');
check('/chime test waiting still works', registeredCommands[0].handler({ rawInput: 'test waiting' }).kind === 'success');
check('an unknown test argument falls back to the completion tone', registeredCommands[0].handler({ rawInput: 'test nonsense' }).kind === 'success');

// ---------------------------------------------------------------- teardown
console.log('teardown');
disposer?.();
await sleep(300);
check('unsubscribes on dispose', (listeners.get('agent/status') ?? []).length === 0);
check('unregisters the job listener on dispose', jobListeners.length === 0);
start('s50-main');
endTurn('s50-main');
await sleep(140);
stop('s50-main');
await sleep(120);
check('plays nothing after dispose', !trace().includes('s50-main'));

console.log('');
if (failures.length) {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  console.log(`kept ${directory} for inspection`);
  process.exitCode = 1;
} else {
  rmSync(directory, { recursive: true, force: true });
  console.log('all checks passed');
}
