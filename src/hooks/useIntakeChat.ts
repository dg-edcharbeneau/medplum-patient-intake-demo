// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType, normalizeErrorString } from '@medplum/core';
import type {
  Coding,
  Parameters,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
} from '@medplum/fhirtypes';
import { buildInitialResponse, getItemAnswerOptionValue, isChoiceQuestion, useMedplum } from '@medplum/react';
import { useCallback, useEffect, useRef, useState } from 'react';

const INTAKE_CHAT_BOT = 'intake-chat';
const OPENER = 'Begin the intake: greet the patient warmly and ask the first question.';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'assistant' | 'user';
  readonly text: string;
}

interface FieldOption {
  value: string;
  label: string;
  system?: string;
}

interface FormField {
  linkId: string;
  label: string;
  group?: string;
  type: 'string' | 'date' | 'dateTime' | 'boolean' | 'integer' | 'choice' | 'reference';
  required: boolean;
  options?: FieldOption[];
  valueSet?: string;
}

export interface UseIntakeChat {
  readonly messages: ChatMessage[];
  readonly response: QuestionnaireResponse;
  readonly version: number;
  /** Whether the form schema has finished loading (choice options/value sets expanded). */
  readonly ready: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly progress: { current: number; total: number };
  /** Every required field has a value. */
  readonly isComplete: boolean;
  /** The agent asked to submit (after the patient confirmed). */
  readonly submitRequested: boolean;
  /** Opens the conversation (agent greets + asks first question); returns the text to speak. */
  readonly start: () => Promise<string>;
  /** One conversational turn; returns the text to speak next and whether the agent asked to submit. */
  readonly submitUserMessage: (text: string) => Promise<{ speak: string; done: boolean }>;
}

export function useIntakeChat(questionnaire: Questionnaire): UseIntakeChat {
  const medplum = useMedplum();

  const schemaRef = useRef<FormField[]>([]);
  const formStateRef = useRef<Record<string, unknown>>({});
  const messagesRef = useRef<ChatMessage[]>([]);
  const botIdRef = useRef<string | undefined>(undefined);
  const answerCache = useRef<Map<string, QuestionnaireResponseItemAnswer>>(new Map());
  const msgCounter = useRef(0);

  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [response, setResponse] = useState<QuestionnaireResponse>(() => buildInitialResponse(questionnaire));
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitRequested, setSubmitRequested] = useState(false);
  const [filledCount, setFilledCount] = useState(0);
  const [isComplete, setIsComplete] = useState(false);

  // Build the flattened form schema once (expands choice value sets).
  useEffect(() => {
    let cancelled = false;
    buildFormSchema(medplum, questionnaire)
      .then((schema) => {
        if (!cancelled) {
          schemaRef.current = schema;
          setReady(true);
        }
      })
      .catch((err) => setError(normalizeErrorString(err)));
    return () => {
      cancelled = true;
    };
  }, [medplum, questionnaire]);

  const addMessage = useCallback((role: ChatMessage['role'], text: string): void => {
    msgCounter.current += 1;
    const msg: ChatMessage = { id: `m${msgCounter.current}`, role, text };
    messagesRef.current = [...messagesRef.current, msg];
    setMessages(messagesRef.current);
  }, []);

  const resolveBotId = useCallback(async (): Promise<string> => {
    if (botIdRef.current) {
      return botIdRef.current;
    }
    const bot = await medplum.searchOne('Bot', { name: INTAKE_CHAT_BOT });
    if (!bot?.id) {
      throw new Error(`Bot "${INTAKE_CHAT_BOT}" not found. Deploy bots via Upload Example Bots.`);
    }
    botIdRef.current = bot.id;
    return bot.id;
  }, [medplum]);

  const refreshDerived = useCallback((): void => {
    const schema = schemaRef.current;
    const state = formStateRef.current;
    const filled = schema.filter((f) => hasValue(state[f.linkId])).length;
    setFilledCount(filled);
    setIsComplete(schema.filter((f) => f.required).every((f) => hasValue(state[f.linkId])));
  }, []);

  const rebuildResponse = useCallback(async (): Promise<void> => {
    const qr = await buildResponse(medplum, questionnaire, schemaRef.current, formStateRef.current, answerCache.current);
    setResponse(qr);
    setVersion((v) => v + 1);
  }, [medplum, questionnaire]);

  const runTurn = useCallback(
    async (userMessage: string, opener: boolean): Promise<{ speak: string; done: boolean }> => {
      try {
        const botId = await resolveBotId();
        const history = messagesRef.current.slice(-20).map((m) => ({ role: m.role, content: m.text }));
        const params: Parameters = {
          resourceType: 'Parameters',
          parameter: [
            { name: 'schema', valueString: JSON.stringify(schemaRef.current.map(toSchemaForModel)) },
            { name: 'formState', valueString: JSON.stringify(formStateRef.current) },
            { name: 'history', valueString: JSON.stringify(opener ? [] : history) },
            { name: 'userMessage', valueString: userMessage },
          ],
        };
        const result = (await medplum.executeBot(botId, params, ContentType.FHIR_JSON)) as Parameters;

        const assistantMessage = getResultParam(result, 'assistantMessage') ?? '';
        const updates = safeParseObject(getResultParam(result, 'updates'));
        const clear = safeParseStringArray(getResultParam(result, 'clear'));
        const submit = getResultParam(result, 'submit') === 'true';

        // Apply updates/clears to the working form state.
        const next = { ...formStateRef.current };
        for (const [k, v] of Object.entries(updates)) {
          if (schemaRef.current.some((f) => f.linkId === k)) {
            next[k] = v;
          }
        }
        for (const k of clear) {
          delete next[k];
        }
        formStateRef.current = next;

        if (assistantMessage) {
          addMessage('assistant', assistantMessage);
        }
        refreshDerived();
        await rebuildResponse();
        if (submit) {
          setSubmitRequested(true);
        }
        return { speak: assistantMessage, done: submit };
      } catch (err) {
        const msg = normalizeErrorString(err);
        setError(msg);
        addMessage('assistant', `Something went wrong: ${msg}`);
        return { speak: 'Something went wrong.', done: false };
      }
    },
    [addMessage, medplum, rebuildResponse, refreshDerived, resolveBotId]
  );

  const start = useCallback(async (): Promise<string> => {
    if (pending || messagesRef.current.length > 0) {
      return '';
    }
    setPending(true);
    try {
      const { speak } = await runTurn(OPENER, true);
      return speak;
    } finally {
      setPending(false);
    }
  }, [pending, runTurn]);

  const submitUserMessage = useCallback(
    async (text: string): Promise<{ speak: string; done: boolean }> => {
      const trimmed = text.trim();
      if (!trimmed || pending) {
        return { speak: '', done: false };
      }
      addMessage('user', trimmed);
      setError(undefined);
      setPending(true);
      try {
        return await runTurn(trimmed, false);
      } finally {
        setPending(false);
      }
    },
    [addMessage, pending, runTurn]
  );

  return {
    messages,
    response,
    version,
    ready,
    pending,
    error,
    progress: { current: filledCount, total: schemaRef.current.length },
    isComplete,
    submitRequested,
    start,
    submitUserMessage,
  };
}

// ---------------------------------------------------------------------------
// Schema + response construction
// ---------------------------------------------------------------------------

async function buildFormSchema(
  medplum: ReturnType<typeof useMedplum>,
  questionnaire: Questionnaire
): Promise<FormField[]> {
  const fields: FormField[] = [];

  async function walk(items: QuestionnaireItem[], groupText: string | undefined): Promise<void> {
    for (const item of items) {
      if (item.type === 'display') {
        continue;
      }
      if (item.type === 'group') {
        await walk(item.item ?? [], item.text ?? groupText);
        continue;
      }
      const field: FormField = {
        linkId: item.linkId,
        label: item.text ?? item.linkId,
        group: groupText,
        type: mapType(item.type),
        required: Boolean(item.required),
      };
      if (isChoiceQuestion(item)) {
        if (item.answerOption) {
          field.options = item.answerOption.map((o) => optionFrom(getItemAnswerOptionValue(o)));
        } else if (item.answerValueSet) {
          field.valueSet = item.answerValueSet;
          try {
            const vs = await medplum.valueSetExpand({ url: item.answerValueSet, count: 40 });
            const contains = vs.expansion?.contains ?? [];
            if (contains.length > 0 && contains.length <= 40) {
              field.options = contains.map((c) => ({
                value: c.code ?? c.display ?? '',
                label: c.display ?? c.code ?? '',
                system: c.system,
              }));
            }
          } catch {
            // leave as free-text; resolved at conversion time
          }
        }
      }
      fields.push(field);
    }
  }

  await walk(questionnaire.item ?? [], undefined);
  return fields;
}

function mapType(type: string | undefined): FormField['type'] {
  switch (type) {
    case 'choice':
    case 'open-choice':
      return 'choice';
    case 'reference':
      return 'reference';
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'decimal':
      return 'integer';
    case 'date':
      return 'date';
    case 'dateTime':
      return 'dateTime';
    default:
      return 'string';
  }
}

function optionFrom(tv: { type: string; value: unknown }): FieldOption {
  if (tv.type === 'Coding') {
    const coding = tv.value as Coding;
    return { value: coding.code ?? coding.display ?? '', label: coding.display ?? coding.code ?? '', system: coding.system };
  }
  const str = String(tv.value);
  return { value: str, label: str };
}

/** Trim the schema to what the model needs (labels + option choices). */
function toSchemaForModel(field: FormField): Record<string, unknown> {
  return {
    linkId: field.linkId,
    label: field.label,
    ...(field.group ? { group: field.group } : {}),
    type: field.type,
    required: field.required,
    ...(field.options ? { options: field.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
  };
}

async function buildResponse(
  medplum: ReturnType<typeof useMedplum>,
  questionnaire: Questionnaire,
  schema: FormField[],
  formState: Record<string, unknown>,
  cache: Map<string, QuestionnaireResponseItemAnswer>
): Promise<QuestionnaireResponse> {
  const qr = buildInitialResponse(questionnaire);
  for (const field of schema) {
    const value = formState[field.linkId];
    if (!hasValue(value)) {
      continue;
    }
    const key = `${field.linkId}|${JSON.stringify(value)}`;
    let answer = cache.get(key);
    if (!answer) {
      const resolved = await toAnswer(medplum, field, value);
      if (resolved) {
        answer = resolved;
        cache.set(key, resolved);
      }
    }
    if (answer) {
      setAnswerByLinkId(qr.item ?? [], field.linkId, answer);
    }
  }
  return qr;
}

async function toAnswer(
  medplum: ReturnType<typeof useMedplum>,
  field: FormField,
  value: unknown
): Promise<QuestionnaireResponseItemAnswer | undefined> {
  const str = String(value).trim();
  if (!str) {
    return undefined;
  }
  switch (field.type) {
    case 'boolean':
      return { valueBoolean: value === true || /^(true|yes|y)$/i.test(str) };
    case 'integer': {
      const n = Number(str);
      return Number.isFinite(n) ? { valueInteger: Math.trunc(n) } : undefined;
    }
    case 'date':
      return { valueDate: str.slice(0, 10) };
    case 'dateTime':
      return { valueDateTime: str.length <= 10 ? `${str}T00:00:00Z` : str };
    case 'reference': {
      const orgs = await medplum.searchResources('Organization', { name: str, _count: 1 });
      return orgs.length ? { valueReference: { reference: `Organization/${orgs[0].id}`, display: orgs[0].name } } : undefined;
    }
    case 'choice': {
      const opt = field.options?.find(
        (o) => o.value === str || o.label.toLowerCase() === str.toLowerCase() || o.value.toLowerCase() === str.toLowerCase()
      );
      if (opt) {
        return opt.system ? { valueCoding: { system: opt.system, code: opt.value, display: opt.label } } : { valueString: opt.value };
      }
      if (field.valueSet) {
        try {
          const vs = await medplum.valueSetExpand({ url: field.valueSet, filter: str, count: 5 });
          const first = vs.expansion?.contains?.[0];
          if (first) {
            return { valueCoding: { system: first.system, code: first.code, display: first.display } };
          }
        } catch {
          // fall through to string
        }
      }
      return { valueString: str };
    }
    default:
      return { valueString: str };
  }
}

function setAnswerByLinkId(items: QuestionnaireResponseItem[], linkId: string, answer: QuestionnaireResponseItemAnswer): boolean {
  for (const item of items) {
    if (item.linkId === linkId) {
      item.answer = [answer];
      return true;
    }
    if (item.item && setAnswerByLinkId(item.item, linkId, answer)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function getResultParam(result: Parameters, name: string): string | undefined {
  return result.parameter?.find((p) => p.name === name)?.valueString;
}

function safeParseObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParseStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
