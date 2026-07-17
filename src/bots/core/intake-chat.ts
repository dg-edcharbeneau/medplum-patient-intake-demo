// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { Sha256 } from '@aws-crypto/sha256-js';

const DEFAULT_MODEL_ID = 'openai.gpt-oss-20b-1:0';
const DEFAULT_REGION = 'us-east-1';
const BEDROCK_SERVICE = 'bedrock';

/**
 * Stateless "brain" bot for the voice/chat intake flow.
 *
 * Given a single questionnaire item and the patient's latest reply (typed or transcribed), it calls
 * Amazon Bedrock and returns the parsed FHIR answer for that item plus a short, spoken-friendly
 * confirmation message. The frontend owns questionnaire ordering, enableWhen, repeats, and merging.
 *
 * Input: Parameters with parts:
 *  - linkId (valueString), itemText (valueString), itemType (valueString)
 *  - answerOptions (valueString, JSON array of {code, system, display}) — for choice items
 *  - userMessage (valueString) — the patient's reply
 *  - context (valueString, optional) — recent answers, for disambiguation
 *
 * Output: Parameters with parts:
 *  - answer (valueString) — JSON of a single FHIR answer object, or "null"
 *  - assistantMessage (valueString) — short natural-language confirmation / follow-up
 *  - needsClarification (valueString) — "true" | "false"
 */
export async function handler(_medplum: MedplumClient, event: BotEvent<Parameters>): Promise<Parameters> {
  const getParam = (name: string): string | undefined =>
    event.input.parameter?.find((p) => p.name === name)?.valueString;

  const linkId = getParam('linkId') ?? '';
  const itemText = getParam('itemText') ?? '';
  const itemType = getParam('itemType') ?? 'string';
  const answerOptions = getParam('answerOptions');
  const userMessage = getParam('userMessage') ?? '';
  const context = getParam('context');

  const region = event.secrets['AWS_REGION']?.valueString ?? DEFAULT_REGION;
  const accessKeyId = event.secrets['AWS_ACCESS_KEY_ID']?.valueString;
  const secretAccessKey = event.secrets['AWS_SECRET_ACCESS_KEY']?.valueString;
  const sessionToken = event.secrets['AWS_SESSION_TOKEN']?.valueString;
  const modelId = event.secrets['BEDROCK_MODEL_ID']?.valueString ?? DEFAULT_MODEL_ID;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY bot secrets.');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ linkId, itemText, itemType, answerOptions, userMessage, context });

  const requestBody = JSON.stringify({
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: userPrompt }] }],
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  });

  const bedrockResponse = await invokeConverse({
    region,
    modelId,
    body: requestBody,
    accessKeyId,
    secretAccessKey,
    sessionToken,
  });
  const rawText = bedrockResponse.output?.message?.content?.find((c) => c.text)?.text ?? '';
  const parsed = parseModelJson(rawText);

  const parameter: ParametersParameter[] = [
    { name: 'answer', valueString: JSON.stringify(parsed.answer ?? null) },
    { name: 'assistantMessage', valueString: parsed.assistantMessage ?? '' },
    { name: 'needsClarification', valueString: String(Boolean(parsed.needsClarification)) },
  ];

  return { resourceType: 'Parameters', parameter };
}

function buildSystemPrompt(): string {
  return [
    'You help patients fill out a medical intake form by voice.',
    'You are given ONE FHIR Questionnaire item and the patient\'s latest reply.',
    'Convert the reply into a single FHIR QuestionnaireResponse answer object for that item.',
    'Answer object shape depends on the item type:',
    '- string/text: {"valueString": "..."}',
    '- boolean: {"valueBoolean": true|false}',
    '- integer: {"valueInteger": 123}',
    '- date: {"valueDate": "YYYY-MM-DD"}',
    '- dateTime: {"valueDateTime": "YYYY-MM-DDThh:mm:ssZ"}',
    '- choice: pick the single best match from the provided options and return its exact "value" object as answer',
    '- reference: {"valueReference": {"display": "..."}} (frontend resolves the actual reference)',
    'Rules:',
    '- Return ONLY minified JSON, no prose, no markdown fences.',
    '- JSON shape: {"answer": <answer object or null>, "assistantMessage": "<short confirmation, max ~12 words>", "needsClarification": <true|false>}.',
    '- If the reply is unclear, empty, or does not answer the question, set answer=null, needsClarification=true, and make assistantMessage a brief re-ask.',
    '- When options are provided (JSON array of {label, value}), choose the best match and return its "value" object verbatim; never invent a value.',
    '- assistantMessage is spoken aloud, so keep it short and natural.',
  ].join('\n');
}

function buildUserPrompt(args: {
  linkId: string;
  itemText: string;
  itemType: string;
  answerOptions?: string;
  userMessage: string;
  context?: string;
}): string {
  const lines = [
    `Item linkId: ${args.linkId}`,
    `Item type: ${args.itemType}`,
    `Question: ${args.itemText}`,
  ];
  if (args.answerOptions) {
    lines.push(`Allowed options (JSON): ${args.answerOptions}`);
  }
  if (args.context) {
    lines.push(`Recent answers for context: ${args.context}`);
  }
  lines.push(`Patient reply: "${args.userMessage}"`);
  return lines.join('\n');
}

interface ConverseResponse {
  output?: { message?: { content?: { text?: string }[] } };
}

interface InvokeArgs {
  region: string;
  modelId: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Calls the Bedrock Converse REST endpoint with a hand-signed SigV4 request (no AWS SDK). */
async function invokeConverse(args: InvokeArgs): Promise<ConverseResponse> {
  const host = `bedrock-runtime.${args.region}.amazonaws.com`;
  // Actual request path is encoded once; the SigV4 canonical URI for non-S3 services
  // is encoded twice (e.g. ":" -> "%3A" in the URL, "%253A" in the signature).
  const requestPath = `/model/${encodeURIComponent(args.modelId)}/converse`;
  const canonicalUri = `/model/${encodeURIComponent(encodeURIComponent(args.modelId))}/converse`;
  const url = `https://${host}${requestPath}`;
  const headers = signRequest({ ...args, host, canonicalUri });

  const response = await fetch(url, { method: 'POST', headers, body: args.body });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bedrock request failed: ${response.status} ${detail}`);
  }
  return (await response.json()) as ConverseResponse;
}

// --- AWS Signature V4 (pure JS, via @aws-crypto/sha256-js) ------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sha256Hex(data: string): string {
  const hash = new Sha256();
  hash.update(data);
  return toHex(hash.digestSync());
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  const hash = new Sha256(key);
  hash.update(data);
  return hash.digestSync();
}

function signRequest(args: InvokeArgs & { host: string; canonicalUri: string }): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // e.g. 20260717T130000Z
  const dateStamp = amzDate.slice(0, 8);

  // Canonical headers must be sorted by lowercase name.
  const headerPairs: [string, string][] = [
    ['content-type', 'application/json'],
    ['host', args.host],
    ['x-amz-date', amzDate],
  ];
  if (args.sessionToken) {
    headerPairs.push(['x-amz-security-token', args.sessionToken]);
  }
  headerPairs.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerPairs.map(([k]) => k).join(';');
  const payloadHash = sha256Hex(args.body);
  const canonicalRequest = `POST\n${args.canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${args.region}/${BEDROCK_SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmac(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, BEDROCK_SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = toHex(hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    Authorization: authorization,
  };
  if (args.sessionToken) {
    headers['X-Amz-Security-Token'] = args.sessionToken;
  }
  return headers;
}

interface ModelResult {
  answer: unknown;
  assistantMessage?: string;
  needsClarification?: boolean;
}

/** Extract the JSON object from a model response, tolerating stray text or code fences. */
function parseModelJson(text: string): ModelResult {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as ModelResult;
      if (obj && typeof obj === 'object') {
        return obj;
      }
    } catch {
      // try next candidate
    }
  }
  return { answer: null, assistantMessage: "Sorry, I didn't catch that. Could you say it again?", needsClarification: true };
}
