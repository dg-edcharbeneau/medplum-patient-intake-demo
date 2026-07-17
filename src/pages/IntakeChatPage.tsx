// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Grid,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum, useMedplumProfile } from '@medplum/react';
import {
  IconAlertCircle,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlayerStopFilled,
  IconSend,
} from '@tabler/icons-react';
import { useContext, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { Loading } from '../components/Loading';
import { IntakeQuestionnaireContext } from '../Questionnaire.context';
import { useVoiceIntake } from '../hooks/useVoiceIntake';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  connecting: 'yellow',
  listening: 'green',
  thinking: 'blue',
  speaking: 'grape',
};

export function IntakeChatPage(): JSX.Element {
  const { questionnaire } = useContext(IntakeQuestionnaireContext);

  if (!questionnaire) {
    return <Loading />;
  }

  return <IntakeChat />;
}

function IntakeChat(): JSX.Element {
  const navigate = useNavigate();
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { questionnaire } = useContext(IntakeQuestionnaireContext);

  const voice = useVoiceIntake(questionnaire!);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const started = voice.messages.length > 0;

  // Auto-scroll the transcript.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' });
  }, [voice.messages, voice.partialTranscript]);

  // Stop mic/audio when leaving the page.
  useEffect(() => {
    return () => voice.stopVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = (text: string): void => {
    const value = text.trim();
    if (!value || voice.pending) {
      return;
    }
    setInput('');
    voice.sendText(value).catch((err) => showError(normalizeErrorString(err)));
  };

  const handleSubmit = (): void => {
    if (!profile) {
      return;
    }
    setSubmitting(true);
    const response: QuestionnaireResponse = {
      ...voice.response,
      status: 'completed',
      author: createReference(profile),
    };
    medplum
      .createResource<QuestionnaireResponse>(response)
      .then(() => {
        voice.stopVoice();
        showNotification({ color: 'green', title: 'Success', message: 'Intake submitted' });
        navigate('/Patient')?.catch(console.error);
        window.scrollTo(0, 0);
      })
      .catch((err) => showError(normalizeErrorString(err)))
      .finally(() => setSubmitting(false));
  };

  return (
    <Box p="md">
      <Grid gutter="md">
        {/* Left: voice-first chat */}
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper withBorder p="md" radius="md" h="calc(100vh - 120px)">
            <Stack h="100%" gap="sm">
              <Group justify="space-between">
                <Title order={2}>Voice Intake</Title>
                <Badge color={STATUS_COLOR[voice.status]} variant="light">
                  {STATUS_LABEL[voice.status]}
                </Badge>
              </Group>

              {voice.voiceError && (
                <Alert color="yellow" icon={<IconAlertCircle />} title="Voice unavailable">
                  {voice.voiceError} You can continue by typing below.
                </Alert>
              )}

              {!started && (
                <Stack align="center" py="lg" gap="sm">
                  <Text c="dimmed" ta="center">
                    Answer a few questions and watch the form fill itself in. Speak your answers, or type them.
                  </Text>
                  <Group>
                    <Button
                      leftSection={<IconMicrophone size={18} />}
                      disabled={!voice.voiceSupported}
                      onClick={() => voice.startVoice().catch((err) => showError(normalizeErrorString(err)))}
                    >
                      Start with voice
                    </Button>
                    <Button variant="light" onClick={() => voice.startText()}>
                      Type instead
                    </Button>
                  </Group>
                </Stack>
              )}

              <ScrollArea viewportRef={viewportRef} style={{ flex: 1 }} type="auto">
                <Stack gap="xs" pr="sm">
                  {voice.messages.map((m) => (
                    <Group key={m.id} justify={m.role === 'user' ? 'flex-end' : 'flex-start'}>
                      <Paper
                        withBorder
                        p="xs"
                        radius="md"
                        maw="85%"
                        bg={m.role === 'user' ? 'blue.0' : 'gray.0'}
                      >
                        <Text size="sm">{m.text}</Text>
                      </Paper>
                    </Group>
                  ))}
                  {voice.partialTranscript && (
                    <Group justify="flex-end">
                      <Paper withBorder p="xs" radius="md" maw="85%" bg="blue.0" opacity={0.6}>
                        <Text size="sm" fs="italic">
                          {voice.partialTranscript}
                        </Text>
                      </Paper>
                    </Group>
                  )}
                </Stack>
              </ScrollArea>

              {/* Choice chips for the current question */}
              {started && voice.currentOptions && voice.currentOptions.length > 0 && (
                <Group gap="xs">
                  {voice.currentOptions.map((opt) => (
                    <Button
                      key={opt.label}
                      size="xs"
                      variant="outline"
                      disabled={voice.pending}
                      onClick={() => handleSend(opt.label)}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </Group>
              )}

              {/* Text fallback input + voice controls */}
              {started && (
                <Group gap="xs">
                  {voice.status !== 'idle' ? (
                    <ActionIcon
                      variant="light"
                      color={voice.muted ? 'red' : 'gray'}
                      size="lg"
                      onClick={() => voice.setMuted(!voice.muted)}
                      title={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {voice.muted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
                    </ActionIcon>
                  ) : (
                    voice.voiceSupported && (
                      <ActionIcon
                        variant="light"
                        size="lg"
                        onClick={() => voice.startVoice().catch((err) => showError(normalizeErrorString(err)))}
                        title="Start voice"
                      >
                        <IconMicrophone size={18} />
                      </ActionIcon>
                    )
                  )}
                  <TextInput
                    style={{ flex: 1 }}
                    placeholder="Type your answer…"
                    value={input}
                    disabled={voice.pending || voice.isComplete}
                    onChange={(e) => setInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSend(input);
                      }
                    }}
                  />
                  <ActionIcon
                    variant="filled"
                    size="lg"
                    disabled={voice.pending || voice.isComplete || !input.trim()}
                    onClick={() => handleSend(input)}
                    title="Send"
                  >
                    <IconSend size={18} />
                  </ActionIcon>
                  {voice.status !== 'idle' && (
                    <ActionIcon variant="light" color="red" size="lg" onClick={() => voice.stopVoice()} title="Stop voice">
                      <IconPlayerStopFilled size={18} />
                    </ActionIcon>
                  )}
                </Group>
              )}
            </Stack>
          </Paper>
        </Grid.Col>

        {/* Right: live-filling form */}
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Paper withBorder p="md" radius="md" h="calc(100vh - 120px)">
            <Stack h="100%" gap="sm">
              <Group justify="space-between">
                <Title order={2}>Intake Form</Title>
                <Button onClick={handleSubmit} loading={submitting} disabled={!voice.isComplete}>
                  Submit
                </Button>
              </Group>
              <ScrollArea style={{ flex: 1 }} type="auto">
                <QuestionnaireForm
                  key={voice.version}
                  questionnaire={questionnaire!}
                  questionnaireResponse={voice.response}
                  excludeButtons
                />
              </ScrollArea>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Box>
  );
}

function showError(message: string): void {
  showNotification({ color: 'red', title: 'Error', message });
}
