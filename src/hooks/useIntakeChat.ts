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
import {
  buildInitialResponse,
  getItemAnswerOptionValue,
  isChoiceQuestion,
  isQuestionEnabled,
  useMedplum,
} from '@medplum/react';
import { useCallback, useMemo, useRef, useState } from 'react';

const INTAKE_CHAT_BOT = 'intake-chat';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'assistant' | 'user';
  readonly text: string;
}

/** A selectable option for a choice question (chips + LLM disambiguation). */
export interface ChoiceOption {
  readonly label: string;
  readonly value: QuestionnaireResponseItemAnswer;
}

interface PathSeg {
  readonly linkId: string;
  readonly index: number;
  readonly text?: string;
}

type Step =
  | { readonly kind: 'question'; readonly item: QuestionnaireItem; readonly path: PathSeg[] }
  | { readonly kind: 'repeat'; readonly group: QuestionnaireItem; readonly parentPath: PathSeg[]; readonly nextIndex: number };

export interface UseIntakeChat {
  readonly messages: ChatMessage[];
  readonly response: QuestionnaireResponse;
  /** Bumped on every merged answer so the live QuestionnaireForm can remount. */
  readonly version: number;
  readonly currentItem: QuestionnaireItem | undefined;
  readonly currentOptions: ChoiceOption[] | undefined;
  readonly isComplete: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  /** Kicks off the conversation; returns the first line to speak. */
  readonly start: () => string;
  /** Processes one user turn; returns the text the agent should speak next and whether the flow is done. */
  readonly submitUserMessage: (text: string) => Promise<{ speak: string; done: boolean }>;
}

export function useIntakeChat(questionnaire: Questionnaire): UseIntakeChat {
  const medplum = useMedplum();

  const stepsRef = useRef<Step[]>([]);
  if (stepsRef.current.length === 0) {
    stepsRef.current = buildSteps(questionnaire.item ?? [], []);
  }

  const responseRef = useRef<QuestionnaireResponse>(buildInitialResponse(questionnaire));
  const botIdRef = useRef<string | undefined>(undefined);
  const msgCounter = useRef(0);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isComplete, setIsComplete] = useState(false);

  const addMessage = useCallback((role: ChatMessage['role'], text: string) => {
    msgCounter.current += 1;
    setMessages((prev) => [...prev, { id: `m${msgCounter.current}`, role, text }]);
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

  const currentStep = stepsRef.current[currentIndex];
  const currentItem = currentStep?.kind === 'question' ? currentStep.item : undefined;

  // Chips for inline-answerOption choice questions (voice/text fallback aid).
  const currentOptions = useMemo<ChoiceOption[] | undefined>(() => {
    if (currentItem && isChoiceQuestion(currentItem) && currentItem.answerOption) {
      return currentItem.answerOption.map((o) => optionToChoice(getItemAnswerOptionValue(o)));
    }
    return undefined;
  }, [currentItem]);

  const start = useCallback((): string => {
    const idx = findNextIndex(stepsRef.current, 0, responseRef.current);
    setCurrentIndex(idx);
    const prompt = idx < stepsRef.current.length ? promptForStep(stepsRef.current[idx]) : COMPLETE_MESSAGE;
    if (idx >= stepsRef.current.length) {
      setIsComplete(true);
    }
    addMessage('assistant', prompt);
    return prompt;
  }, [addMessage]);

  const advanceFrom = useCallback((from: number): { prompt: string; done: boolean } => {
    const idx = findNextIndex(stepsRef.current, from, responseRef.current);
    setCurrentIndex(idx);
    if (idx >= stepsRef.current.length) {
      setIsComplete(true);
      return { prompt: COMPLETE_MESSAGE, done: true };
    }
    return { prompt: promptForStep(stepsRef.current[idx]), done: false };
  }, []);

  const submitUserMessage = useCallback(
    async (text: string): Promise<{ speak: string; done: boolean }> => {
      const trimmed = text.trim();
      if (!trimmed || pending || isComplete) {
        return { speak: '', done: isComplete };
      }
      addMessage('user', trimmed);
      setError(undefined);
      setPending(true);
      try {
        const step = stepsRef.current[currentIndex];

        // Repeating-group prompt is a local yes/no.
        if (step?.kind === 'repeat') {
          const wantsMore = /\b(yes|yeah|yep|sure|another|add|more)\b/i.test(trimmed);
          if (wantsMore) {
            const instance = buildGroupInstanceSteps(step.group, step.parentPath, step.nextIndex);
            stepsRef.current.splice(currentIndex + 1, 0, ...instance);
          }
          const confirm = wantsMore ? 'Sure, let’s add another.' : 'Okay.';
          addMessage('assistant', confirm);
          const next = advanceFrom(currentIndex + 1);
          addMessage('assistant', next.prompt);
          return { speak: `${confirm} ${next.prompt}`.trim(), done: next.done };
        }

        if (step?.kind !== 'question') {
          return { speak: '', done: true };
        }
        const item = step.item;

        // Reference items resolve to an Organization by name search.
        if (item.type === 'reference') {
          const orgs = await medplum.searchResources('Organization', { name: trimmed, _count: 1 });
          if (orgs.length === 0) {
            const msg = `I couldn’t find an organization named “${trimmed}”. What is its name?`;
            addMessage('assistant', msg);
            return { speak: msg, done: false };
          }
          const org = orgs[0];
          setAnswer(responseRef.current, step.path, item, {
            valueReference: { reference: `Organization/${org.id}`, display: org.name },
          });
          setVersion((v) => v + 1);
          const confirm = `Got it — ${org.name}.`;
          addMessage('assistant', confirm);
          const next = advanceFrom(currentIndex + 1);
          addMessage('assistant', next.prompt);
          return { speak: `${confirm} ${next.prompt}`.trim(), done: next.done };
        }

        // Choice options: inline answerOption, or a filtered ValueSet expansion.
        const options = await getChoiceOptions(medplum, item, trimmed);

        const botId = await resolveBotId();
        const params: Parameters = {
          resourceType: 'Parameters',
          parameter: [
            { name: 'linkId', valueString: item.linkId },
            { name: 'itemText', valueString: item.text ?? '' },
            { name: 'itemType', valueString: item.type },
            { name: 'userMessage', valueString: trimmed },
            { name: 'context', valueString: summarizeContext(responseRef.current) },
            ...(options ? [{ name: 'answerOptions', valueString: JSON.stringify(options) }] : []),
          ],
        };

        const result = (await medplum.executeBot(botId, params, ContentType.FHIR_JSON)) as Parameters;
        const answerStr = getResultParam(result, 'answer');
        const assistantMessage = getResultParam(result, 'assistantMessage') ?? '';
        const needsClarification = getResultParam(result, 'needsClarification') === 'true';
        const answerObj =
          answerStr && answerStr !== 'null' ? (JSON.parse(answerStr) as QuestionnaireResponseItemAnswer) : null;

        if (needsClarification || !answerObj) {
          const msg = assistantMessage || 'Sorry, could you say that again?';
          addMessage('assistant', msg);
          return { speak: msg, done: false };
        }

        setAnswer(responseRef.current, step.path, item, answerObj);
        setVersion((v) => v + 1);
        if (assistantMessage) {
          addMessage('assistant', assistantMessage);
        }
        const next = advanceFrom(currentIndex + 1);
        addMessage('assistant', next.prompt);
        return { speak: `${assistantMessage} ${next.prompt}`.trim(), done: next.done };
      } catch (err) {
        const msg = normalizeErrorString(err);
        setError(msg);
        addMessage('assistant', `Something went wrong: ${msg}`);
        return { speak: 'Something went wrong.', done: false };
      } finally {
        setPending(false);
      }
    },
    [addMessage, advanceFrom, currentIndex, isComplete, medplum, pending, resolveBotId]
  );

  return {
    messages,
    response: responseRef.current,
    version,
    currentItem,
    currentOptions,
    isComplete,
    pending,
    error,
    start,
    submitUserMessage,
  };
}

const COMPLETE_MESSAGE = 'That’s everything! Please review the form on the right and submit when you’re ready.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function buildSteps(items: QuestionnaireItem[], parentPath: PathSeg[]): Step[] {
  const steps: Step[] = [];
  for (const item of items) {
    if (item.type === 'display') {
      continue;
    }
    if (item.type === 'group') {
      const groupPath: PathSeg[] = [...parentPath, { linkId: item.linkId, index: 0, text: item.text }];
      steps.push(...buildSteps(item.item ?? [], groupPath));
      if (item.repeats) {
        steps.push({ kind: 'repeat', group: item, parentPath, nextIndex: 1 });
      }
    } else {
      steps.push({ kind: 'question', item, path: parentPath });
    }
  }
  return steps;
}

function buildGroupInstanceSteps(group: QuestionnaireItem, parentPath: PathSeg[], index: number): Step[] {
  const groupPath: PathSeg[] = [...parentPath, { linkId: group.linkId, index, text: group.text }];
  const inner = buildSteps(group.item ?? [], groupPath);
  inner.push({ kind: 'repeat', group, parentPath, nextIndex: index + 1 });
  return inner;
}

function findNextIndex(steps: Step[], from: number, response: QuestionnaireResponse): number {
  let i = from;
  while (i < steps.length) {
    const s = steps[i];
    if (s.kind === 'repeat' || isQuestionEnabled(s.item, response)) {
      return i;
    }
    i++;
  }
  return steps.length;
}

function promptForStep(step: Step): string {
  if (step.kind === 'repeat') {
    const label = (step.group.text ?? 'entry').replace(/\.$/, '').toLowerCase();
    return `Would you like to add another ${label}?`;
  }
  return step.item.text ?? 'Please provide a value.';
}

function optionToChoice(tv: { type: string; value: unknown }): ChoiceOption {
  if (tv.type === 'Coding') {
    const coding = tv.value as Coding;
    return { label: coding.display ?? coding.code ?? '', value: { valueCoding: coding } };
  }
  const str = String(tv.value);
  return { label: str, value: { valueString: str } };
}

async function getChoiceOptions(
  medplum: ReturnType<typeof useMedplum>,
  item: QuestionnaireItem,
  filter: string
): Promise<ChoiceOption[] | undefined> {
  if (!isChoiceQuestion(item)) {
    return undefined;
  }
  if (item.answerOption) {
    return item.answerOption.map((o) => optionToChoice(getItemAnswerOptionValue(o)));
  }
  if (item.answerValueSet) {
    try {
      const vs = await medplum.valueSetExpand({ url: item.answerValueSet, filter, count: 10 });
      const contains = vs.expansion?.contains ?? [];
      return contains.map((c) => ({
        label: c.display ?? c.code ?? '',
        value: { valueCoding: { system: c.system, code: c.code, display: c.display } },
      }));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Ensures the nested group items exist along `path`, then sets the leaf answer (mutates response). */
function setAnswer(
  response: QuestionnaireResponse,
  path: PathSeg[],
  item: QuestionnaireItem,
  answer: QuestionnaireResponseItemAnswer
): void {
  let container: QuestionnaireResponseItem[] = response.item ?? (response.item = []);
  for (const seg of path) {
    const sameLink = container.filter((i) => i.linkId === seg.linkId);
    while (sameLink.length <= seg.index) {
      const gi: QuestionnaireResponseItem = { linkId: seg.linkId, text: seg.text, item: [] };
      container.push(gi);
      sameLink.push(gi);
    }
    const g = sameLink[seg.index];
    container = g.item ?? (g.item = []);
  }
  let leaf = container.find((i) => i.linkId === item.linkId);
  if (!leaf) {
    leaf = { linkId: item.linkId, text: item.text };
    container.push(leaf);
  }
  leaf.answer = [answer];
}

/** A compact recent-answers summary passed to the model for disambiguation. */
function summarizeContext(response: QuestionnaireResponse): string {
  const parts: string[] = [];
  collectAnswers(response.item ?? [], parts);
  return parts.slice(-8).join('; ');
}

function collectAnswers(items: QuestionnaireResponseItem[], out: string[]): void {
  for (const item of items) {
    if (item.answer?.[0]) {
      const a = item.answer[0];
      const value =
        a.valueString ??
        a.valueCoding?.display ??
        a.valueReference?.display ??
        (a.valueBoolean !== undefined ? String(a.valueBoolean) : undefined) ??
        a.valueDate ??
        a.valueDateTime;
      if (value) {
        out.push(`${item.text ?? item.linkId}: ${value}`);
      }
    }
    if (item.item) {
      collectAnswers(item.item, out);
    }
  }
}

function getResultParam(result: Parameters, name: string): string | undefined {
  return result.parameter?.find((p) => p.name === name)?.valueString;
}
