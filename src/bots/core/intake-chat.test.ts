// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent } from '@medplum/core';
import type { Parameters } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { handler } from './intake-chat';

// Bedrock is a signed fetch — mock the global fetch.
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
      AWS_ACCESS_KEY_ID: { name: 'AWS_ACCESS_KEY_ID', valueString: 'test-key' },
      AWS_SECRET_ACCESS_KEY: { name: 'AWS_SECRET_ACCESS_KEY', valueString: 'test-secret' },
    },
  };
}

function getParam(result: Parameters, name: string): string | undefined {
  return result.parameter?.find((p) => p.name === name)?.valueString;
}

describe('intake-chat agent bot', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('returns multi-field updates and the next message', async () => {
    fetchMock.mockResolvedValue(
      bedrockOk(
        JSON.stringify({
          updates: { 'first-name': 'Alex', 'last-name': 'Kim' },
          clear: [],
          assistantMessage: 'Thanks Alex! What is your date of birth?',
          submit: false,
        })
      )
    );

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'schema', valueString: '[{"linkId":"first-name","label":"First name","type":"string","required":true}]' },
        { name: 'formState', valueString: '{}' },
        { name: 'history', valueString: '[]' },
        { name: 'userMessage', valueString: "I'm Alex Kim" },
      ])
    );

    expect(JSON.parse(getParam(result, 'updates') as string)).toEqual({ 'first-name': 'Alex', 'last-name': 'Kim' });
    expect(getParam(result, 'assistantMessage')).toContain('date of birth');
    expect(getParam(result, 'submit')).toBe('false');
  });

  test('tolerates code fences and surfaces submit + clear', async () => {
    fetchMock.mockResolvedValue(
      bedrockOk('```json\n{"updates":{},"clear":["email"],"assistantMessage":"Submitting now.","submit":true}\n```')
    );

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'schema', valueString: '[]' },
        { name: 'formState', valueString: '{"first-name":"Alex"}' },
        { name: 'history', valueString: '[]' },
        { name: 'userMessage', valueString: 'remove my email and submit' },
      ])
    );

    expect(JSON.parse(getParam(result, 'clear') as string)).toEqual(['email']);
    expect(getParam(result, 'submit')).toBe('true');
  });

  test('degrades gracefully on unparseable output', async () => {
    fetchMock.mockResolvedValue(bedrockOk('not json at all'));

    const result = await handler(
      medplum,
      makeEvent([
        { name: 'schema', valueString: '[]' },
        { name: 'formState', valueString: '{}' },
        { name: 'history', valueString: '[]' },
        { name: 'userMessage', valueString: 'hello' },
      ])
    );

    expect(JSON.parse(getParam(result, 'updates') as string)).toEqual({});
    expect(getParam(result, 'assistantMessage')).toBeTruthy();
  });

  test('throws when AWS credentials are missing', async () => {
    const event = makeEvent([{ name: 'userMessage', valueString: 'hi' }]);
    const noCreds: BotEvent<Parameters> = { ...event, secrets: {} };
    await expect(handler(medplum, noCreds)).rejects.toThrow(/AWS credentials/);
  });
});
