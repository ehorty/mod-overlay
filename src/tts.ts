import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EdgeTTS } from '@andresaya/edge-tts';
import { log, warn } from './log';

export type VoiceProvider = 'yandex' | 'steos';

export interface VoiceInfo {
  id: string;
  name: string;
  locale: string;
  gender: string;
  provider?: VoiceProvider;
}

export interface SayResult {
  url: string;
  file: string;
  duration: number;
}

interface RawVoice {
  ShortName: string;
  DisplayName?: string;
  LocalName?: string;
  Locale: string;
  Gender: string;
}

export interface TtsGenerateOptions {
  rate: string;
  pitch: string;
  volume: string;
  outputFormat: string;
}

export interface TtsEngine {
  getVoices(): Promise<RawVoice[]>;
  generate(
    text: string,
    voice: string,
    options: TtsGenerateOptions,
  ): Promise<{ audio: ArrayBuffer | Uint8Array | Buffer; duration?: unknown }>;
}

export type TtsEngineFactory = () => TtsEngine;

export interface TtsProviders {
  yandexKey?: string;
  yandexFolder?: string;
  steosToken?: string;
  steosApiUrl?: string;
}

const defaultEngineFactory: TtsEngineFactory = () =>
  new EdgeTTS({ timeout: 25000 }) as unknown as TtsEngine;

function toBuffer(audio: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(new Uint8Array(audio));
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
}

export const FALLBACK_VOICES: VoiceInfo[] = [
  { id: 'ru-RU-DmitryNeural', name: 'Дмитрий', locale: 'ru-RU', gender: 'Male' },
  { id: 'ru-RU-SvetlanaNeural', name: 'Светлана', locale: 'ru-RU', gender: 'Female' },
  { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
  { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' },
  { id: 'de-DE-KatjaNeural', name: 'Katja', locale: 'de-DE', gender: 'Female' },
];

/** Классические голоса Yandex SpeechKit v1 — те же, что в DonationAlerts. */
export const YANDEX_VOICES: VoiceInfo[] = [
  { id: 'yandex:alena', name: 'Алёна', locale: 'ru-RU', gender: 'Female', provider: 'yandex' },
  { id: 'yandex:filipp', name: 'Филипп', locale: 'ru-RU', gender: 'Male', provider: 'yandex' },
  { id: 'yandex:ermil', name: 'Ермил', locale: 'ru-RU', gender: 'Male', provider: 'yandex' },
  { id: 'yandex:jane', name: 'Джейн', locale: 'ru-RU', gender: 'Female', provider: 'yandex' },
  { id: 'yandex:omazh', name: 'Омаж', locale: 'ru-RU', gender: 'Female', provider: 'yandex' },
  { id: 'yandex:zahar', name: 'Захар', locale: 'ru-RU', gender: 'Male', provider: 'yandex' },
  { id: 'yandex:madirus', name: 'Мадирус', locale: 'ru-RU', gender: 'Male', provider: 'yandex' },
  { id: 'yandex:marina', name: 'Марина', locale: 'ru-RU', gender: 'Female', provider: 'yandex' },
];

const YANDEX_IDS = new Set(YANDEX_VOICES.map((v) => v.id.slice('yandex:'.length)));
const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const STEOS_DEFAULT_API = 'https://api.voice.steos.io/v1';
const DEFAULT_VOICE = 'ru-RU-DmitryNeural';

interface SteosVoice {
  voice_id: number;
  name?: { RU?: string; EN?: string };
  description?: { RU?: string; EN?: string };
}

interface SteosVoicesResponse {
  status?: boolean;
  message?: string;
  voices?: SteosVoice[];
}

interface SteosTtsResponse {
  status?: boolean;
  message?: string;
  audio_url?: string;
  format?: string;
}

const MAX_TEXT = 500;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

function normalizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function percent(value: unknown): string {
  const n = Math.max(-50, Math.min(100, Math.round(Number(value) || 0)));
  return `${n >= 0 ? '+' : ''}${n}%`;
}

function hertz(value: unknown): string {
  const n = Math.max(-50, Math.min(50, Math.round(Number(value) || 0)));
  return `${n >= 0 ? '+' : ''}${n}Hz`;
}

export class TtsService {
  private voiceCache: { at: number; list: VoiceInfo[] } | null = null;
  private steosCache: { at: number; list: VoiceInfo[] } | null = null;
  private steosRetryAt = 0;

  constructor(
    private readonly dir: string,
    private readonly engineFactory: TtsEngineFactory = defaultEngineFactory,
    private readonly providers: TtsProviders = {},
  ) {}

  private get yandexReady(): boolean {
    return Boolean(this.providers.yandexKey && this.providers.yandexFolder);
  }

  private get steosReady(): boolean {
    return Boolean(this.providers.steosToken);
  }

  private steosApiBase(): string {
    return (this.providers.steosApiUrl ?? STEOS_DEFAULT_API).replace(/\/+$/, '');
  }

  private toVoiceInfo(v: RawVoice): VoiceInfo {
    return {
      id: v.ShortName,
      name: (v.DisplayName || v.LocalName || v.ShortName).replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, ''),
      locale: v.Locale,
      gender: v.Gender,
    };
  }

  private async steosVoices(): Promise<VoiceInfo[]> {
    const now = Date.now();
    if (this.steosCache && now - this.steosCache.at < 12 * 60 * 60 * 1000) {
      return this.steosCache.list;
    }
    if (now < this.steosRetryAt) return this.steosCache?.list ?? [];
    try {
      const res = await fetch(`${this.steosApiBase()}/get/voices`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.providers.steosToken ?? '',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SteosVoicesResponse;
      if (!data?.status) throw new Error(data?.message || 'bad_response');
      const list = (data.voices ?? [])
        .filter((v) => Number.isInteger(v.voice_id))
        .map((v) => ({
          id: `steos:${v.voice_id}`,
          name: v.name?.RU || v.name?.EN || `Голос ${v.voice_id}`,
          locale: 'ru-RU',
          gender: '',
          provider: 'steos' as const,
        }));
      this.steosCache = { at: now, list };
      return list;
    } catch (e) {
      this.steosRetryAt = now + 5 * 60 * 1000;
      warn('SteosVoice: не удалось получить голоса:', (e as Error)?.message ?? e);
      return this.steosCache?.list ?? [];
    }
  }

  private async edgeVoices(): Promise<VoiceInfo[]> {
    const now = Date.now();
    if (this.voiceCache && now - this.voiceCache.at < 12 * 60 * 60 * 1000) {
      return this.voiceCache.list;
    }
    try {
      const voices = await this.engineFactory().getVoices();
      const list = voices
        .filter((v) => /^(ru|en|uk|de|fr|es|it|pl|tr|kk|ja|ko|zh)-/i.test(v.Locale))
        .map((v) => this.toVoiceInfo(v))
        .sort((a, b) => {
          const rank = (l: string) => (l.startsWith('ru') ? 0 : l.startsWith('en') ? 1 : 2);
          return rank(a.locale) - rank(b.locale) || a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name);
        });
      if (list.length) {
        this.voiceCache = { at: now, list };
        return list;
      }
    } catch (e) {
      warn('Не удалось получить список голосов Edge TTS:', (e as Error)?.message ?? e);
    }
    return this.voiceCache?.list ?? FALLBACK_VOICES;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const extra: VoiceInfo[] = [];
    if (this.yandexReady) extra.push(...YANDEX_VOICES);
    if (this.steosReady) extra.push(...(await this.steosVoices()));
    return [...extra, ...(await this.edgeVoices())];
  }

  private pickVoice(voice: unknown): string {
    if (typeof voice === 'string') {
      if (voice.startsWith('yandex:')) {
        const id = voice.slice('yandex:'.length);
        if (this.yandexReady && YANDEX_IDS.has(id)) return voice;
      } else if (/^steos:\d+$/.test(voice)) {
        if (this.steosReady) return voice;
      } else if (VOICE_RE.test(voice)) {
        return voice;
      }
    }
    return DEFAULT_VOICE;
  }

  async say(input: unknown, voiceInput: unknown, rate: unknown, pitch: unknown): Promise<SayResult> {
    const text = normalizeText(input);
    if (!text) throw Object.assign(new Error('empty_text'), { code: 'empty_text' });
    const voice = this.pickVoice(voiceInput);
    const attempts = voice.startsWith('steos:') ? 2 : 3;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { audio, duration } = voice.startsWith('yandex:')
          ? await this.yandexSay(text, voice.slice('yandex:'.length), rate)
          : voice.startsWith('steos:')
            ? await this.steosSay(text, voice.slice('steos:'.length))
            : await this.edgeSay(text, voice, rate, pitch);
        const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.mp3`;
        const file = path.join(this.dir, name);
        await fs.promises.writeFile(file, audio);
        log(`TTS: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''} (${voice}, ${(audio.length / 1024).toFixed(1)} КБ)`);
        return { url: `/media/tts/${name}`, file, duration: Number(duration) || 0 };
      } catch (e) {
        lastError = e;
        warn(`TTS попытка ${attempt}/${attempts} не удалась:`, (e as Error)?.message ?? e);
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: lastError });
  }

  private async edgeSay(
    text: string,
    voice: string,
    rate: unknown,
    pitch: unknown,
  ): Promise<{ audio: Buffer; duration?: unknown }> {
    const engine = this.engineFactory();
    const result = await engine.generate(text, voice, {
      rate: percent(rate),
      pitch: hertz(pitch),
      volume: '+0%',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    });
    const audio = toBuffer(result.audio);
    if (!audio.length) throw new Error('empty_audio');
    return { audio, duration: result.duration };
  }

  private async yandexSay(
    text: string,
    voice: string,
    rate: unknown,
  ): Promise<{ audio: Buffer; duration?: number }> {
    const n = Math.max(-50, Math.min(100, Math.round(Number(rate) || 0)));
    const speed = Math.max(0.1, Math.min(3, 1 + n / 100)).toFixed(2);
    const body = new URLSearchParams({
      text,
      lang: 'ru-RU',
      voice,
      speed,
      format: 'mp3',
      sampleRateHertz: '48000',
      folderId: this.providers.yandexFolder ?? '',
    });
    const res = await fetch(YANDEX_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${this.providers.yandexKey ?? ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Yandex TTS HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('empty_audio');
    return { audio };
  }

  private async steosSay(text: string, voiceId: string): Promise<{ audio: Buffer; duration?: number }> {
    const base = this.steosApiBase();
    const res = await fetch(`${base}/get/tts`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: this.providers.steosToken ?? '',
      },
      body: JSON.stringify({ voice_id: Number(voiceId), text, format: 'mp3' }),
      signal: AbortSignal.timeout(45000),
    });
    const data = (await res.json().catch(() => null)) as SteosTtsResponse | null;
    if (!res.ok || !data?.status || !data.audio_url) {
      throw new Error(`SteosVoice: ${data?.message || `HTTP ${res.status}`}`);
    }
    const audioRes = await fetch(data.audio_url, { signal: AbortSignal.timeout(30000) });
    if (!audioRes.ok) throw new Error(`SteosVoice audio HTTP ${audioRes.status}`);
    const audio = Buffer.from(await audioRes.arrayBuffer());
    if (!audio.length) throw new Error('empty_audio');
    return { audio };
  }

  cleanup(maxAgeMs = 2 * 60 * 60 * 1000): void {
    const now = Date.now();
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.mp3')) continue;
        const file = path.join(this.dir, name);
        try {
          if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
            fs.unlinkSync(file);
            removed++;
          }
        } catch {
          /* файл уже удалён */
        }
      }
    } catch {
      /* папки нет */
    }
    if (removed) log(`TTS: удалено старых файлов — ${removed}`);
  }
}
