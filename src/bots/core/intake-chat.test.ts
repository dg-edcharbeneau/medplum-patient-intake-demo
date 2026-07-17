// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent } from '@medplum/core';
import type { Parameters } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { handler } from './intake-chat';

// Bedrock is now a signed fetch — mock the global fetch.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function bedrockOk(text: string): unknown {
  return {
    ok: true,
    json: async () => ({ output: { message: { content: [{ text }] } } }),
  };
}

function makeEvent(parameter: Parameters['parameter']): BotEvent<Parameters> {
  return {
    bot: { reference: 'Bot/123' },
    contentType: 'application/fhir+json',
    input: { resourceType: 'Parameters', parameter },
    secrets: {
      AWS_REGION: { name: 'AWS_REGION', valueString: 'us-east-1' },
      AWS_ACCESS_KEY_ID: { name: 'AWS_ACCESS_KEY_ID', valueString: 'test-key' },
      AWS_SECRET_ACCESS_KEY: { name: 'AWS_SECRET_ACCESS_KEY', valueString: 'test-secret' },
      BEDROCK_MODEL_ID: { name: 'BEDROCK_MODEL_ID', valueString: 'openai.gpt-oss-20b-1:0' },
    },
  };
}

describe('intake-chat bot', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('parses a string answer and confirmation', async () => {
    fetchMock.mockResolvedValue(
      bedrockOk(JSON.stringify({ answer: { valueString: 'Alex' }, assistantMessage: 'Got it, Alex.', needsClarification: false }))
    );

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'linkId', valueString: 'first-name' },
        { name: 'itemText', valueString: 'What is your first name?' },
        { name: 'itemType', valueString: 'string' },
        { name: 'userMessage', valueString: 'My name is Alex' },
      ])
    );

    const answer = result.parameter?.find((p) => p.name === 'answer')?.valueString;
    const message = result.parameter?.find((p) => p.name === 'assistantMessage')?.valueString;
    const needsClarification = result.parameter?.find((p) => p.name === 'needsClarification')?.valueString;

    expect(JSON.parse(answer as string)).toEqual({ valueString: 'Alex' });
    expect(message).toBe('Got it, Alex.');
    expect(needsClarification).toBe('false');
  });

  test('tolerates model output wrapped in prose / code fences', async () => {
    fetchMock.mockResolvedValue(
      bedrockOk('```json\n{"answer":{"valueBoolean":true},"assistantMessage":"Noted.","needsClarification":false}\n```')
    );

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'linkId', valueString: 'veteran-status' },
        { name: 'itemText', valueString: 'Are you a veteran?' },
        { name: 'itemType', valueString: 'boolean' },
        { name: 'userMessage', valueString: 'yes' },
      ])
    );

    const answer = result.parameter?.find((p) => p.name === 'answer')?.valueString;
    expect(JSON.parse(answer as string)).toEqual({ valueBoolean: true });
  });

  test('falls back to needsClarification on unparseable output', async () => {
    fetchMock.mockResolvedValue(
      bedrockOk('I am not sure what you mean.'));

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'linkId', valueString: 'first-name' },
        { name: 'itemText', valueString: 'What is your first name?' },
        { name: 'itemType', valueString: 'string' },
        { name: 'userMessage', valueString: '...' },
      ])
    );

    const answer = result.parameter?.find((p) => p.name === 'answer')?.valueString;
    const needsClarification = result.parameter?.find((p) => p.name === 'needsClarification')?.valueString;
    expect(answer).toBe('null');
    expect(needsClarification).toBe('true');
  });

  test('throws when AWS credentials are missing', async () => {
    const event = makeEvent([{ name: 'userMessage', valueString: 'hi' }]);
    const noCreds: BotEvent<Parameters> = { ...event, secrets: {} };
    await expect(handler(medplum, noCreds)).rejects.toThrow(/AWS credentials/);
  });
});
