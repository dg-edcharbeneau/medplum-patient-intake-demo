// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// AudioWorklet that converts mic Float32 samples to 16-bit PCM and posts them in
// ~80ms chunks (1280 samples @ 16kHz), the cadence Deepgram Flux recommends.
// The capture AudioContext is created at 16kHz, so no manual resampling is needed here.

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._target = 1280; // 80ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this._buffer.push(channel[i]);
      }
      while (this._buffer.length >= this._target) {
        const chunk = this._buffer.splice(0, this._target);
        const pcm = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
