// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType, normalizeErrorString } from '@medplum/core';
import type { Parameters, Questionnaire } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useRef, useState } from 'react';
import { useIntakeChat } from './useIntakeChat';
import type { UseIntakeChat } from './useIntakeChat';

// Served verbatim from /public so AudioWorklet.addModule gets a real file URL
// (worklets can't be bundled or inlined as data: URLs).
const PCM_WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet.js`;

const DEEPGRAM_TOKEN_BOT = 'deepgram-token';
const STT_MODEL = 'flux-general-en';
const TTS_MODEL = 'aura-2-thalia-en';
const STT_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 24000;

const FLUX_URL = `wss://api.deepgram.com/v2/listen?model=${STT_MODEL}&encoding=linear16&sample_rate=${STT_SAMPLE_RATE}`;
const AURA_URL = `wss://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=linear16&sample_rate=${TTS_SAMPLE_RATE}`;

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface UseVoiceIntake extends UseIntakeChat {
  readonly status: VoiceStatus;
  readonly partialTranscript: string;
  readonly muted: boolean;
  readonly setMuted: (muted: boolean) => void;
  readonly voiceError: string | undefined;
  /** Whether the browser can support the mic pipeline at all. */
  readonly voiceSupported: boolean;
  /** Start the conversation with voice (mic + spoken questions). */
  readonly startVoice: () => Promise<void>;
  /** Start the conversation in text-only mode (no mic, no audio). */
  readonly startText: () => void;
  /** Stop the mic + audio; the chat state is preserved. */
  readonly stopVoice: () => void;
  /** Text-fallback input (also used for option chips); speaks the reply if voice is active. */
  readonly sendText: (text: string) => Promise<void>;
}

export function useVoiceIntake(questionnaire: Questionnaire): UseVoiceIntake {
  const medplum = useMedplum();
  const chat = useIntakeChat(questionnaire);

  const voiceSupported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof AudioContext !== 'undefined';

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [muted, setMutedState] = useState(false);
  const [voiceError, setVoiceError] = useState<string | undefined>(undefined);

  const startedRef = useRef(false);
  const voiceActiveRef = useRef(false);
  const mutedRef = useRef(false);

  // STT (mic → Flux)
  const micStreamRef = useRef<MediaStream | undefined>(undefined);
  const captureCtxRef = useRef<AudioContext | undefined>(undefined);
  const workletRef = useRef<AudioWorkletNode | undefined>(undefined);
  const fluxRef = useRef<WebSocket | undefined>(undefined);
  const transcriptRef = useRef('');

  // TTS (Aura → speakers)
  const auraRef = useRef<WebSocket | undefined>(undefined);
  const playbackCtxRef = useRef<AudioContext | undefined>(undefined);
  const nextStartRef = useRef(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isSpeakingRef = useRef(false);

  // Keep the latest chat.submitUserMessage without re-opening sockets.
  const submitRef = useRef(chat.submitUserMessage);
  submitRef.current = chat.submitUserMessage;

  const getToken = useCallback(async (): Promise<string> => {
    const bot = await medplum.searchOne('Bot', { name: DEEPGRAM_TOKEN_BOT });
    if (!bot?.id) {
      throw new Error(`Bot "${DEEPGRAM_TOKEN_BOT}" not found. Deploy bots via Upload Example Bots.`);
    }
    const input: Parameters = { resourceType: 'Parameters', parameter: [{ name: 'ttl_seconds', valueInteger: 300 }] };
    const result = (await medplum.executeBot(bot.id, input, ContentType.FHIR_JSON)) as Parameters;
    const token = result.parameter?.find((p) => p.name === 'access_token')?.valueString;
    if (!token) {
      throw new Error('Deepgram token bot did not return an access_token.');
    }
    return token;
  }, [medplum]);

  // --- TTS playback ------------------------------------------------------

  const clearTts = useCallback(() => {
    // Barge-in: destroy buffered agent audio immediately.
    try {
      auraRef.current?.send(JSON.stringify({ type: 'Clear' }));
    } catch {
      // socket may be closed
    }
    for (const src of sourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    sourcesRef.current = [];
    nextStartRef.current = playbackCtxRef.current?.currentTime ?? 0;
    isSpeakingRef.current = false;
  }, []);

  const enqueuePcm = useCallback((pcm: ArrayBuffer) => {
    const ctx = playbackCtxRef.current;
    if (!ctx) {
      return;
    }
    const view = new Int16Array(pcm);
    if (view.length === 0) {
      return;
    }
    const buffer = ctx.createBuffer(1, view.length, TTS_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < view.length; i++) {
      channel[i] = view[i] / 0x8000;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStartRef.current);
    source.start(startAt);
    nextStartRef.current = startAt + buffer.duration;
    isSpeakingRef.current = true;
    setStatus('speaking');
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== source);
      if (sourcesRef.current.length === 0 && voiceActiveRef.current) {
        isSpeakingRef.current = false;
        setStatus('listening');
      }
    };
    sourcesRef.current.push(source);
  }, []);

  const speakText = useCallback(
    (text: string) => {
      if (!voiceActiveRef.current || !text.trim() || !auraRef.current) {
        return;
      }
      try {
        auraRef.current.send(JSON.stringify({ type: 'Speak', text }));
        auraRef.current.send(JSON.stringify({ type: 'Flush' }));
      } catch {
        // socket not ready
      }
    },
    []
  );

  // --- One conversational turn ------------------------------------------

  const runTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      clearTts();
      setPartialTranscript('');
      setStatus('thinking');
      const { speak, done } = await submitRef.current(trimmed);
      if (speak) {
        speakText(speak);
      }
      if (done) {
        setStatus(voiceActiveRef.current ? 'listening' : 'idle');
      } else if (!voiceActiveRef.current) {
        setStatus('idle');
      }
    },
    [clearTts, speakText]
  );

  const sendText = useCallback(
    async (text: string) => {
      await runTurn(text);
    },
    [runTurn]
  );

  // --- Flux STT handling -------------------------------------------------

  const handleFluxMessage = useCallback(
    (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const type = msg.type as string | undefined;

      // Transcript can appear on TurnInfo (field names vary by Flux revision; be tolerant).
      const transcript =
        (msg.transcript as string | undefined) ??
        ((msg as { channel?: { alternatives?: { transcript?: string }[] } }).channel?.alternatives?.[0]?.transcript ??
          undefined);

      if (typeof transcript === 'string' && transcript.length > 0) {
        transcriptRef.current = transcript;
        setPartialTranscript(transcript);
        // Barge-in: the user spoke while the agent was talking.
        if (isSpeakingRef.current) {
          clearTts();
          setStatus('listening');
        }
      }

      const isEndOfTurn =
        type === 'EndOfTurn' || msg.event === 'EndOfTurn' || (msg as { end_of_turn?: boolean }).end_of_turn === true;

      if ((type === 'StartOfTurn' || type === 'EagerEndOfTurn' || type === 'TurnResumed') && isSpeakingRef.current) {
        clearTts();
        setStatus('listening');
      }

      if (isEndOfTurn) {
        const finalText = transcriptRef.current.trim();
        transcriptRef.current = '';
        if (finalText) {
          runTurn(finalText).catch((err) => setVoiceError(normalizeErrorString(err)));
        }
      }
    },
    [clearTts, runTurn]
  );

  // --- Start / stop ------------------------------------------------------

  const openSockets = useCallback(
    async (token: string) => {
      // TTS socket
      const aura = new WebSocket(AURA_URL, ['token', token]);
      aura.binaryType = 'arraybuffer';
      aura.onmessage = (event) => {
        if (typeof event.data === 'string') {
          return; // JSON control frames (Flushed/Cleared/Metadata)
        }
        enqueuePcm(event.data as ArrayBuffer);
      };
      aura.onerror = () => setVoiceError('Text-to-speech connection error.');
      auraRef.current = aura;

      // STT socket
      const flux = new WebSocket(FLUX_URL, ['token', token]);
      flux.binaryType = 'arraybuffer';
      flux.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleFluxMessage(event.data);
        }
      };
      flux.onerror = () => setVoiceError('Speech-to-text connection error.');
      fluxRef.current = flux;

      // Mic capture → worklet → Flux
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = stream;
      const captureCtx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
      captureCtxRef.current = captureCtx;
      await captureCtx.audioWorklet.addModule(PCM_WORKLET_URL);
      const sourceNode = captureCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(captureCtx, 'pcm-worklet');
      worklet.port.onmessage = (event) => {
        if (!mutedRef.current && fluxRef.current?.readyState === WebSocket.OPEN) {
          fluxRef.current.send(event.data as ArrayBuffer);
        }
      };
      sourceNode.connect(worklet);
      workletRef.current = worklet;

      // Playback context for Aura audio.
      const playbackCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      playbackCtxRef.current = playbackCtx;
      nextStartRef.current = playbackCtx.currentTime;
    },
    [enqueuePcm, handleFluxMessage]
  );

  const stopVoice = useCallback(() => {
    voiceActiveRef.current = false;
    clearTts();
    try {
      fluxRef.current?.close();
    } catch {
      /* noop */
    }
    try {
      auraRef.current?.close();
    } catch {
      /* noop */
    }
    workletRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    captureCtxRef.current?.close().catch(() => undefined);
    playbackCtxRef.current?.close().catch(() => undefined);
    fluxRef.current = undefined;
    auraRef.current = undefined;
    workletRef.current = undefined;
    micStreamRef.current = undefined;
    captureCtxRef.current = undefined;
    playbackCtxRef.current = undefined;
    setStatus('idle');
  }, [clearTts]);

  const startText = useCallback(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    chat.start();
  }, [chat]);

  const startVoice = useCallback(async () => {
    if (voiceActiveRef.current) {
      return;
    }
    setVoiceError(undefined);
    setStatus('connecting');
    try {
      const token = await getToken();
      await openSockets(token);
      voiceActiveRef.current = true;
      setStatus('listening');
      if (!startedRef.current) {
        startedRef.current = true;
        const first = chat.start();
        speakText(first);
      }
    } catch (err) {
      setVoiceError(normalizeErrorString(err));
      stopVoice();
      // Fall back to text-only so the user is not stuck.
      startText();
    }
  }, [chat, getToken, openSockets, speakText, startText, stopVoice]);

  const setMuted = useCallback((value: boolean) => {
    mutedRef.current = value;
    setMutedState(value);
  }, []);

  return {
    ...chat,
    status,
    partialTranscript,
    muted,
    setMuted,
    voiceError,
    voiceSupported,
    startVoice,
    startText,
    stopVoice,
    sendText,
  };
}
