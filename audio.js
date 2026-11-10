/**
 * Desktop audio for the session-chime bundle.
 *
 * The sound is produced by one long-lived Windows PowerShell helper process that
 * keeps reading statements from stdin. Starting PowerShell costs a few hundred
 * milliseconds, so paying it once at the first chime keeps later chimes instant
 * (measured: first command ~15 ms after spawn, following commands ~0 ms before
 * playback). Everything written to stdin is plain ASCII: paths and speech text
 * travel base64-encoded and are decoded inside the helper, so non-ASCII user
 * names and Chinese speech text survive the pipe on a 5.1 host.
 *
 * On macOS and Linux the rendered WAV goes to a short-lived detached child
 * (`afplay`, `paplay`, `pw-play`, `ffplay` or `aplay`), and speech to `say` or
 * `spd-say`: those binaries start in a few dozen milliseconds, so no resident
 * supervisor process is worth keeping around.
 *
 * The two earcons are synthesized here (no third-party asset, no dependency),
 * written as a 16-bit mono WAV into the OS temp dir, and cached per sound,
 * synthesis version and volume.
 *
 * ## Why the two sounds are built the way they are
 *
 * A notification pair has to be told apart across a room, at low volume, over
 * game audio — and, for a large part of the population, with hearing loss above
 * 8 kHz. Pitch alone is a weak cue for that: two rising two-note figures differ
 * only by which notes they are, and the previous pair here did exactly that
 * (measured: same 2-onset rhythm, 150 ms apart, -12.5 vs -12.7 LUFS). If the
 * person cannot tell them apart, "finished" and "you are needed" collapse into
 * "something happened", and the plugin loses its point.
 *
 * So the two are separated on four axes at once:
 *
 * | | completion (`chime`) | attention (`ping`) |
 * |---|---|---|
 * | contour | C6 → G6, a perfect fifth **up**: resolves | D6 → D6 → F6, a minor third **left hanging**: does not resolve |
 * | rhythm | 2 events, 200 ms apart | 3 events, 100 ms apart |
 * | decay | 320–340 ms, bell-like, rings | 55–110 ms, dry, stops |
 * | register | fundamental 1.0–1.6 kHz, plus a sub-octave for warmth | 1.2–1.4 kHz with a strong octave, no sub: brighter, thinner |
 *
 * A perfect fifth sounds settled and a minor third sounds unsettled, which is
 * the same distinction the plugin is making in words. The rhythm difference is
 * the one that survives a bad speaker: three short events versus two long ones
 * is legible even when everything above 4 kHz is gone.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const SAMPLE_RATE = 44100;

/**
 * Bumped whenever the synthesized earcons change, so an upgrade does not keep
 * playing the cached WAV of the previous version. The spec hash in the cache
 * name covers smaller edits; this covers everything else.
 */
const SYNTH_VERSION = 3;

/** Peak of a rendered clip at volume 1, in linear gain (-1.1 dBFS). */
const TARGET_PEAK = 0.88;

/** The tail is faded so a clip never ends on a step. */
const FADE_OUT_SECONDS = 0.02;

const PS_RELATIVE = join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Absolute path of the Windows PowerShell 5.1 host, or `powershell.exe` from PATH. */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const absolute = join(root, PS_RELATIVE);
  return existsSync(absolute) ? absolute : 'powershell.exe';
}

/** ASCII-only carrier for an arbitrary UTF-8 value: decoded inside the helper. */
function decodedExpression(value) {
  const base64 = Buffer.from(String(value), 'utf8').toString('base64');
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))`;
}

/**
 * Locate an executable on PATH without spawning anything, so the first chime
 * does not pay for a `which`.
 *
 * @param {string} name executable name
 * @returns {string} absolute path, or '' when not found
 */
function findExecutable(name) {
  const path = process.env.PATH ?? '';
  if (!path) return '';
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not in this directory */
    }
  }
  return '';
}

/**
 * Player candidates per POSIX platform, in preference order. PipeWire and
 * PulseAudio first because they respect the desktop mixer and its volume;
 * `aplay` writes to the raw ALSA device and bypasses it.
 */
const POSIX_PLAYERS = {
  darwin: [{ command: '/usr/bin/afplay', args: [] }],
  linux: [
    { command: 'pw-play', args: [] }, // PipeWire
    { command: 'paplay', args: [] }, // PulseAudio
    { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
    { command: 'aplay', args: ['-q'] },
  ],
};

/** Speech backends per POSIX platform. */
const POSIX_SPEAKERS = {
  darwin: { command: '/usr/bin/say', args: [] },
  linux: { command: 'spd-say', args: ['--wait'] },
};

/**
 * Synthesis spec for one earcon.
 *
 * A note is a fundamental plus the shared partial stack, a short mallet click
 * on the attack (what lets it cut through background noise at low volume), and
 * its own envelope. `sub` adds a sub-octave sine for body.
 */
const SOUNDS = {
  chime: {
    duration: 1.15,
    /** Per-sound trim before the volume knob: equal peaks is not equal loudness. */
    level: 1.0,
    /** Harmonics relative to the note's fundamental. */
    partials: [
      { mult: 1, gain: 1 },
      { mult: 2, gain: 0.18 },
      { mult: 2.99, gain: 0.06 },
    ],
    /** Sub-octave weight: the difference between a bell and a beep. */
    sub: 0.14,
    /** Attack transient: a very short high tone, i.e. a mallet hitting the bell. */
    mallet: { gain: 0.1, freq: 5200, decay: 0.0035 },
    notes: [
      { at: 0.0, freq: 1046.5, gain: 1.0, decay: 0.32, attack: 0.007 },
      // The second note starts after the first has decayed ~5 dB, so the contour
      // is legible instead of being masked by the tail it lands on.
      { at: 0.2, freq: 1567.98, gain: 1.0, decay: 0.34, attack: 0.007 },
    ],
  },
  ping: {
    duration: 0.62,
    /**
     * Deliberately a little quieter than the completion bell. The attention
     * signal is already harder to ignore because of its rhythm and timbre; also
     * making it louder turns a notification into a jump scare.
     */
    level: 0.85,
    partials: [
      { mult: 1, gain: 1 },
      { mult: 2, gain: 0.22 },
    ],
    sub: 0,
    mallet: { gain: 0.07, freq: 6400, decay: 0.0025 },
    notes: [
      { at: 0.0, freq: 1174.66, gain: 0.9, decay: 0.055, attack: 0.0025 },
      { at: 0.1, freq: 1174.66, gain: 0.95, decay: 0.055, attack: 0.0025 },
      { at: 0.2, freq: 1396.91, gain: 1.0, decay: 0.11, attack: 0.0025 },
    ],
  },
};

/**
 * Render one earcon into a complete RIFF/WAVE file.
 *
 * @param {object} sound notes, partials and envelope for this sound
 * @param {number} volume linear gain, 0..1
 * @returns {Buffer} a complete RIFF/WAVE file
 */
function synthesize(sound, volume) {
  const frames = Math.floor(SAMPLE_RATE * sound.duration);
  const data = new Float64Array(frames);

  for (const note of sound.notes) {
    const start = Math.floor(note.at * SAMPLE_RATE);
    const decay = note.decay ?? 0.2;
    const attack = note.attack ?? 0.005;

    for (let i = 0; i < frames - start; i += 1) {
      const t = i / SAMPLE_RATE;

      // Slightly raised-cosine attack: a linear ramp leaves a slope step that
      // reads as a tick on small speakers.
      const attackShape = attack > 0 ? Math.min(1, t / attack) : 1;
      const envelope = Math.exp(-t / decay) * (0.5 - 0.5 * Math.cos(Math.PI * attackShape));

      let sample = 0;
      for (const partial of sound.partials) {
        sample += partial.gain * Math.sin(2 * Math.PI * note.freq * partial.mult * t);
      }
      if (sound.sub > 0) sample += sound.sub * Math.sin(Math.PI * note.freq * t);

      let value = sample * envelope * note.gain;

      if (sound.mallet) {
        const click = sound.mallet.gain
          * Math.sin(2 * Math.PI * sound.mallet.freq * t)
          * Math.exp(-t / sound.mallet.decay);
        value += click * note.gain;
      }

      data[start + i] += value;
    }
  }

  // Fade the tail: the decay is far below full scale by then, but a step at the
  // end is audible on headphones in a quiet room.
  const fadeFrames = Math.min(frames, Math.floor(SAMPLE_RATE * FADE_OUT_SECONDS));
  for (let i = 0; i < fadeFrames; i += 1) {
    const shape = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeFrames);
    data[frames - 1 - i] *= shape;
  }

  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  const level = Number.isFinite(sound.level) ? sound.level : 1;
  const gain = peak > 0 ? ((TARGET_PEAK * level) / peak) * Math.min(1, Math.max(0, volume)) : 0;

  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.max(-1, Math.min(1, data[i] * gain));
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return bytes;
}

/** Stable short hash of a synthesis spec, used in the cache file name. */
function specHash(sound) {
  return createHash('sha1').update(JSON.stringify(sound)).digest('hex').slice(0, 8);
}

/** The completion sound: two notes, a fifth up, ringing. */
export function renderChime(volume = 0.8) {
  return synthesize(SOUNDS.chime, volume);
}

/** The "you are needed" sound: three dry pips that do not resolve. */
export function renderPing(volume = 0.8) {
  return synthesize(SOUNDS.ping, volume);
}

/** Cache identity for one rendered clip: sound, spec, rate and volume. */
export function assetName(sound, volume) {
  const key = String(Math.round(volume * 100));
  return `${sound}-v${SYNTH_VERSION}-${specHash(SOUNDS[sound] ?? SOUNDS.chime)}-${SAMPLE_RATE}-${key}.wav`;
}

/**
 * One desktop sound output.
 *
 * `play()` never throws: a notification must not take the Host down when the
 * audio helper or the WAV file is unavailable.
 */
export class DesktopChime {
  /**
   * @param {object} options
   * @param {'chime' | 'speak'} [options.mode]
   * @param {'chime' | 'ping'} [options.sound] which synthesized clip `mode: 'chime'` plays
   * @param {number} [options.volume]
   * @param {string} [options.speakText]
   * @param {string} [options.wavPath] play this file instead of the synthesized chime
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.mode = options.mode === 'speak' ? 'speak' : 'chime';
    this.sound = options.sound === 'ping' ? 'ping' : 'chime';
    this.volume = Number.isFinite(options.volume) ? options.volume : 0.8;
    this.speakText = typeof options.speakText === 'string' ? options.speakText : '';
    this.wavPath = typeof options.wavPath === 'string' ? options.wavPath : '';
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.child = null;
    this.disposed = false;
    /** Resolved POSIX player `{ command, args }`; `undefined` until looked up. */
    this.player = undefined;
    /** Path of the last rendered clip, reused across plays at the same volume. */
    this.assetPath = '';
  }

  /** Whether this platform can produce a sound through this module. */
  static get supported() {
    return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
  }

  /**
   * Ask for one sound. Returns false when nothing could be played.
   * @param {boolean} [retry] internal flag: one retry after restarting the helper.
   */
  play(retry = true) {
    if (this.disposed) return false;
    if (!DesktopChime.supported) {
      this.log('no desktop audio backend on this platform');
      return false;
    }
    if (process.platform !== 'win32') return this.playPosix();

    const script = this.mode === 'speak' ? this.speechScript() : this.soundScript();
    if (!script) return false;

    const child = this.ensureHelper();
    if (!child) return false;

    try {
      child.stdin.write(`${script}\n`);
      this.log(this.mode === 'speak' ? 'speak requested' : `${this.sound} requested (${this.volume})`);
      return true;
    } catch (error) {
      this.log(`helper write failed: ${error instanceof Error ? error.message : String(error)}`);
      this.reset();
      return retry ? this.play(false) : false;
    }
  }

  /** Stop the helper and release its pipes. */
  dispose() {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 400);
    timer.unref?.();
  }

  /** @returns {import('node:child_process').ChildProcess | null} */
  ensureHelper() {
    const live = this.child;
    if (live && live.exitCode === null && live.signalCode === null && live.stdin && !live.stdin.destroyed) {
      return live;
    }

    let child;
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden', '-Command', '-'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      this.log(`could not start the audio helper: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    child.on('error', (error) => {
      this.log(`audio helper error: ${error instanceof Error ? error.message : String(error)}`);
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code, signal) => {
      this.log(`audio helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      if (this.child === child) this.child = null;
    });
    child.stdin.on('error', () => {
      if (this.child === child) this.child = null;
    });

    // The helper must not keep the Host process alive: stdin closing is enough
    // for `powershell -Command -` to exit, so an orphaned helper cleans itself up.
    child.unref();
    child.stdin.unref?.();

    this.child = child;
    this.log('audio helper started');
    return child;
  }

  reset() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** PowerShell statement that plays the current sound. */
  soundScript() {
    const path = this.resolveWav();
    if (!path) return '';
    return `$file = ${decodedExpression(path)}; (New-Object System.Media.SoundPlayer $file).PlaySync()`;
  }

  /** PowerShell statement that speaks `speakText`. */
  speechScript() {
    const text = this.speakText.trim();
    if (!text) return this.soundScript();
    return `$text = ${decodedExpression(text)}; try { $voice = New-Object -ComObject SAPI.SpVoice; $null = $voice.Speak($text) } catch { }`;
  }

  /**
   * First available player for this platform, or null when none is installed.
   *
   * The returned command is always absolute, including the ones discovered on
   * PATH: `spawnDetached` checks `existsSync` before spawning, so a bare name
   * from PATH would be reported as missing.
   *
   * @returns {{command: string, args: string[]} | null} the player
   */
  resolvePlayer() {
    if (this.player !== undefined) return this.player;
    const candidates = POSIX_PLAYERS[process.platform] ?? [];
    let found = null;
    for (const candidate of candidates) {
      const command = candidate.command.startsWith('/') ? candidate.command : findExecutable(candidate.command);
      if (command) {
        found = { command, args: candidate.args };
        break;
      }
    }
    this.player = found;
    if (!found) {
      this.log(`no audio player found (looked for ${candidates.map((candidate) => candidate.command).join(', ')})`);
    }
    return found;
  }

  /**
   * POSIX playback: the rendered WAV through the platform player, or speech
   * through `say` / `spd-say`.
   *
   * Volume is already baked into the synthesized file, so the player needs no
   * gain flag; a configured `wavPath` plays at its own level, exactly as the
   * Windows path behaves.
   */
  playPosix() {
    const text = this.speakText.trim();
    if (this.mode === 'speak' && text) {
      const speaker = POSIX_SPEAKERS[process.platform];
      if (!speaker) return false;
      const command = speaker.command.startsWith('/') ? speaker.command : findExecutable(speaker.command);
      if (!command) {
        this.log(`${speaker.command} is not installed; falling back to the chime`);
      } else {
        this.log('speak requested');
        return this.spawnDetached(command, speaker.args, text);
      }
    }

    const player = this.resolvePlayer();
    if (!player) return false;
    const path = this.resolveWav();
    if (!path) return false;
    this.log(`${this.sound} requested (${this.volume})`);
    return this.spawnDetached(player.command, [...player.args, path]);
  }

  /** Kept for callers that referenced the macOS entry point by name. */
  playMac() {
    return this.playPosix();
  }

  /**
   * Run one short-lived audio command detached from the Host.
   *
   * `stdinText` is optional: `say` reads the text it speaks from stdin, which
   * keeps quotes, punctuation and CJK out of argument parsing entirely.
   *
   * @param {string} command absolute path of the audio binary
   * @param {string[]} args
   * @param {string} [stdinText]
   * @returns {boolean} whether the child was started
   */
  spawnDetached(command, args, stdinText = '') {
    if (!existsSync(command)) {
      this.log(`${command} is missing; cannot play`);
      return false;
    }
    try {
      const child = spawn(command, args, {
        stdio: [stdinText ? 'pipe' : 'ignore', 'ignore', 'ignore'],
        detached: true,
      });
      child.on('error', (error) => {
        this.log(`${command} error: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (stdinText && child.stdin) {
        child.stdin.on('error', () => {
          /* the player exiting early must not surface as an unhandled error */
        });
        child.stdin.end(stdinText);
        child.stdin.unref?.();
      }
      child.unref();
      this.log(`${command} started`);
      return true;
    } catch (error) {
      this.log(`could not run ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Path of the WAV to play: the configured override when it exists, otherwise
   * a cached synthesized clip for this sound, synthesis version and volume.
   */
  resolveWav() {
    if (this.wavPath) {
      if (existsSync(this.wavPath)) return this.wavPath;
      this.log(`configured wavPath not found: ${this.wavPath}`);
    }
    try {
      const directory = join(tmpdir(), 'dsh-session-chime');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, assetName(this.sound, this.volume));
      if (this.assetPath === path) return path;
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        size = 0;
      }
      if (size < 1024) {
        writeFileSync(path, this.sound === 'ping' ? renderPing(this.volume) : renderChime(this.volume));
        this.log(`wrote ${this.sound} asset ${path}`);
      }
      this.assetPath = path;
      return path;
    } catch (error) {
      this.log(`could not prepare the ${this.sound} asset: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }
}
