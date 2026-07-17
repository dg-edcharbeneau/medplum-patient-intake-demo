// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { Sha256 } from '@aws-crypto/sha256-js';

const DEFAULT_MODEL_ID = 'openai.gpt-oss-20b-1:0';
const DEFAULT_REGION = 'us-east-1';
const BEDROCK_SERVICE = 'bedrock';

/**
 * Conversational "agent" bot for the intake flow.
 *
 * The agent owns the conversation: it receives the whole form schema, the data collected so far,
 * and the chat history, then decides what to ask next, captures whatever the patient said (possibly
 * several fields at once), and returns the fields to set/clear plus the next thing to say. The
 * frontend just applies the updates, renders the form, and speaks the message.
 *
 * Input: Parameters with parts:
 *  - schema (valueString)      — JSON array of form fields {linkId, label, type, required, options?}
 *  - formState (valueString)   — JSON object of the answers collected so far {linkId: value}
 *  - history (valueString)     — JSON array of prior turns [{role:'user'|'assistant', content}]
 *  - userMessage (valueString) — the patient's latest message
 *
 * Output: Parameters with parts:
 *  - assistantMessage (valueString) — what to say/speak next
 *  - updates (valueString)          — JSON object of fields to set this turn {linkId: value}
 *  - clear (valueString)            — JSON array of linkIds to clear
 *  - submit (valueString)           — "true" | "false"
 */
export async function handler(_medplum: MedplumClient, event: BotEvent<Parameters>): Promise<Parameters> {
  const getParam = (name: string): string | undefined =>
    event.input.parameter?.find((p) => p.name === name)?.valueString;

  const schema = getParam('schema') ?? '[]';
  const formState = getParam('formState') ?? '{}';
  const history = safeParseArray(getParam('history'));
  const userMessage = getParam('userMessage') ?? '';

  const region = event.secrets['AWS_REGION']?.valueString ?? DEFAULT_REGION;
  const accessKeyId = event.secrets['AWS_ACCESS_KEY_ID']?.valueString;
  const secretAccessKey = event.secrets['AWS_SECRET_ACCESS_KEY']?.valueString;
  const sessionToken = event.secrets['AWS_SESSION_TOKEN']?.valueString;
  const modelId = event.secrets['BEDROCK_MODEL_ID']?.valueString ?? DEFAULT_MODEL_ID;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY bot secrets.');
  }

  const messages = [
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: [{ text: String(m.content) }] })),
    { role: 'user', content: [{ text: `USER_DATA: ${formState}\nUSER_REQUEST: ${userMessage}` }] },
  ];

  const requestBody = JSON.stringify({
    system: [{ text: buildSystemPrompt(schema) }],
    messages,
    inferenceConfig: { maxTokens: 700, temperature: 0 },
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
    { name: 'assistantMessage', valueString: parsed.assistantMessage ?? '' },
    { name: 'updates', valueString: JSON.stringify(parsed.updates ?? {}) },
    { name: 'clear', valueString: JSON.stringify(parsed.clear ?? []) },
    { name: 'submit', valueString: String(Boolean(parsed.submit)) },
  ];

  return { resourceType: 'Parameters', parameter };
}

function buildSystemPrompt(schema: string): string {
  const today = new Date().toISOString().slice(0, 10); // yyyy-MM-dd
  return [
    `Current date: ${today}.`,
    '- You are helping a patient complete a medical intake. Assist them in a warm, natural conversation.',
    `- The form fields are described by this JSON schema: ${schema}`,
    '- USER_DATA (sent with each request) is the data collected so far.',
    '- Each time the patient provides information that maps to one or more fields, set those fields.',
    '- Convert any dates the patient gives to yyyy-MM-dd format.',
    '- For a choice field, the value MUST be one of that field\'s allowed option values; if the reply does not match, ask them to clarify.',
    '- Guide the patient by asking about missing data WITHOUT revealing they are filling out a form.',
    '- Ask about only one item at a time.',
    '- Briefly acknowledge what you captured, then ask the next question. Keep replies short and natural — they may be spoken aloud.',
    '- If the patient wants to change or remove something, clear those fields.',
    '- When all required fields have values, summarize briefly and ask if they would like to submit.',
    '- Set submit=true only after the patient confirms they want to submit.',
    'Respond with ONLY minified JSON, no prose and no code fences, in exactly this shape:',
    '{"updates":{"<linkId>":<value>},"clear":["<linkId>"],"assistantMessage":"<what to say next>","submit":<true|false>}',
    '- Put in "updates" only the fields you are setting this turn (omit the rest). Use each choice field\'s allowed option value.',
    '- "clear" and "submit" are optional; use [] and false when nothing applies.',
  ].join('\n');
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

// --- Response parsing -------------------------------------------------------

interface AgentResult {
  updates?: Record<string, unknown>;
  clear?: string[];
  assistantMessage?: string;
  submit?: boolean;
}

interface HistoryTurn {
  role?: string;
  content?: string;
}

function safeParseArray(value: string | undefined): HistoryTurn[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as HistoryTurn[]) : [];
  } catch {
    return [];
  }
}

/** Extract the JSON object from a model response, tolerating stray text or code fences. */
function parseModelJson(text: string): AgentResult {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as AgentResult;
      if (obj && typeof obj === 'object') {
        return obj;
      }
    } catch {
      // try next candidate
    }
  }
  return { assistantMessage: "Sorry, I didn't catch that — could you say it again?" };
}
