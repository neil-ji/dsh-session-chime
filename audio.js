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
 * The chime itself is synthesized here (no third-party asset, no dependency):
 * a soft two-note bell, then written as a 16-bit mono WAV into the OS temp dir
 * and cached per volume.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_RATE = 44100;
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
 * Render the completion chime.
 *
 * @param {number} volume linear gain, 0..1 (internally normalized so that the
 *   peak lands at 89% of full scale, which keeps it loud enough over game audio
 *   without clipping at volume 1).
 * @returns {Buffer} a complete RIFF/WAVE file.
 */
const SOUNDS = {
  /** Completion: a soft two-note rising bell that reads as "done". */
  chime: {
    duration: 1.0,
    notes: [
      { at: 0.0, freq: 1046.5, gain: 1.0 },
      { at: 0.16, freq: 1568.0, gain: 0.9 },
    ],
    partials: [
      { mult: 1, gain: 1 },
      { mult: 2.01, gain: 0.28 },
      { mult: 3.02, gain: 0.1 },
    ],
    decay: 0.26,
    attack: 0.006,
  },
  /** Attention: two short high pips that read as "you are needed". */
  ping: {
    duration: 0.5,
    notes: [
      { at: 0.0, freq: 880.0, gain: 1.0 },
      { at: 0.15, freq: 1318.5, gain: 1.0 },
    ],
    partials: [
      { mult: 1, gain: 1 },
      { mult: 2.0, gain: 0.18 },
    ],
    decay: 0.085,
    attack: 0.004,
  },
};

/**
 * Render one tone sequence into a complete RIFF/WAVE file.
 *
 * @param {object} sound notes, partials and envelope for this sound
 * @param {number} volume linear gain, 0..1 (internally normalized so that the
 *   peak lands at 89% of full scale, loud enough over game audio without
 *   clipping at volume 1)
 * @returns {Buffer} a complete RIFF/WAVE file
 */
function synthesize(sound, volume) {
  const frames = Math.floor(SAMPLE_RATE * sound.duration);
  const data = new Float64Array(frames);

  for (const note of sound.notes) {
    const start = Math.floor(note.at * SAMPLE_RATE);
    for (let i = 0; i < frames - start; i += 1) {
      const t = i / SAMPLE_RATE;
      const envelope = Math.exp(-t / sound.decay) * Math.min(1, t / sound.attack);
      let sample = 0;
      for (const partial of sound.partials) {
        sample += partial.gain * Math.sin(2 * Math.PI * note.freq * partial.mult * t);
      }
      data[start + i] += sample * envelope * note.gain;
    }
  }

  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? (0.89 / peak) * Math.min(1, Math.max(0, volume)) : 0;

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

/** The completion sound: one second, two rising notes. */
export function renderChime(volume = 0.8) {
  return synthesize(SOUNDS.chime, volume);
}

/** The "you are needed" sound: two short pips, clearly not the completion bell. */
export function renderPing(volume = 0.8) {
  return synthesize(SOUNDS.ping, volume);
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
  }

  /** Whether this platform can produce a sound through this module. */
  static get supported() {
    return process.platform === 'win32';
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
   * Path of the WAV to play: the configured override when it exists, otherwise
   * a cached synthesized clip for this sound and volume.
   */
  resolveWav() {
    if (this.wavPath) {
      if (existsSync(this.wavPath)) return this.wavPath;
      this.log(`configured wavPath not found: ${this.wavPath}`);
    }
    try {
      const directory = join(tmpdir(), 'dsh-session-chime');
      mkdirSync(directory, { recursive: true });
      const key = String(Math.round(this.volume * 100));
      const path = join(directory, `${this.sound}-${SAMPLE_RATE}-${key}.wav`);
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
      return path;
    } catch (error) {
      this.log(`could not prepare the ${this.sound} asset: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }
}
