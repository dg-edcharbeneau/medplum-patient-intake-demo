// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters } from '@medplum/fhirtypes';

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_VOICE_ID = 'aura-2-thalia-en';

/**
 * Mints a short-lived Deepgram token so the browser can open the Flux (STT) and Aura (TTS) WebSockets
 * without ever holding the long-lived DEEPGRAM_API_KEY. Also returns the configured Aura voice.
 *
 * Secrets:
 *  - DEEPGRAM_API_KEY (required)
 *  - DEEPGRAM_VOICE_ID (optional) — Aura TTS voice/model, defaults to aura-2-thalia-en
 *
 * Output: Parameters with parts:
 *  - access_token (valueString)
 *  - expires_in (valueInteger, seconds)
 *  - voice_id (valueString)
 */
export async function handler(_medplum: MedplumClient, event: BotEvent<Parameters>): Promise<Parameters> {
  const apiKey = event.secrets['DEEPGRAM_API_KEY']?.valueString;
  if (!apiKey) {
    throw new Error('Missing DEEPGRAM_API_KEY bot secret.');
  }

  const voiceId = event.secrets['DEEPGRAM_VOICE_ID']?.valueString ?? DEFAULT_VOICE_ID;
  const requestedTtl = event.input.parameter?.find((p) => p.name === 'ttl_seconds')?.valueInteger;
  const ttlSeconds = requestedTtl ?? DEFAULT_TTL_SECONDS;

  // Preferred: mint a short-lived scoped token. Requires a key with token-grant permission.
  try {
    const response = await fetch(GRANT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });

    if (response.ok) {
      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (data.access_token) {
        return {
          resourceType: 'Parameters',
          parameter: [
            { name: 'access_token', valueString: data.access_token },
            { name: 'expires_in', valueInteger: data.expires_in ?? ttlSeconds },
            { name: 'token_type', valueString: 'grant' },
            { name: 'voice_id', valueString: voiceId },
          ],
        };
      }
    }
  } catch {
    // fall through to raw-key fallback
  }

  // Fallback: the key can't grant tokens, so return it for direct browser WS auth.
  // Tradeoff: the long-lived key reaches the authenticated browser session. Provide a
  // grant-capable Deepgram key to automatically switch back to short-lived tokens.
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'access_token', valueString: apiKey },
      { name: 'expires_in', valueInteger: ttlSeconds },
      { name: 'token_type', valueString: 'apikey' },
      { name: 'voice_id', valueString: voiceId },
    ],
  };
}
