<h1 align="center">Medplum Voice-First AI Patient Intake</h1>
<p align="center">A patient intake app on Medplum with a conversational, voice-first AI assistant.</p>
<p align="center">
<a href="https://github.com/medplum/medplum-hello-world/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/badge/license-Apache-blue.svg" />
  </a>
</p>

This app extends the Medplum patient intake demo with an **AI assistant that fills out the intake form through conversation** — by voice or text. A patient answers in their own words, an LLM captures the relevant fields, and the FHIR intake form fills in live beside the chat. On submit it produces the same `QuestionnaireResponse` as the manual form, so all downstream processing is unchanged.

It demonstrates:

- A **voice-first AI form assistant** — real-time speech in/out with interruption (barge-in), plus a text fallback.
- An **agent-driven flow**: one LLM agent receives the whole form schema + collected data + chat history each turn and decides what to ask, captures multiple fields at once, and handles corrections conversationally.
- Running the LLM on **Amazon Bedrock** (`openai.gpt-oss-20b`) and speech on **Deepgram** (Flux STT + Aura TTS), all brokered through **Medplum Bots** so no API keys reach the browser.
- The original demo: building an intake form, converting the response into structured FHIR (`Patient`, `Coverage`, `Observation`, …), conditional questionnaire flows, and using [Medplum React Components](https://storybook.medplum.com/?path=/docs/medplum-introduction--docs).

## The voice intake experience

Open **New Patient (Voice)** (`/onboarding/chat`). The screen is split: the conversation on the left, the live-filling `QuestionnaireForm` on the right.

```
Browser (IntakeChatPage + hooks)                 Medplum Bots (vmcontext)        External
────────────────────────────────                ────────────────────────        ────────
mic → PCM16 worklet → Flux STT WS ═════════════════════════════════════════════► Deepgram Flux
        transcript ◄══════════════════════════════════════════════════════════     (v2/listen)
              │
              ▼ user turn (schema + collected data + history)
   agent turn ──executeBot(intake-chat)──► intake-chat bot ──SigV4 Converse──► Bedrock gpt-oss-20b
   apply updates/clear ◄── {updates, clear, assistantMessage, submit} ◄──
   live-fill QuestionnaireForm
              ▼ spoken reply
   Aura TTS WS: {Speak}+{Flush} ◄══════════════════════════════════════════════► Deepgram Aura
   barge-in: {Clear} + drain local audio on user speech                            (v1/speak)

   token: executeBot(deepgram-token) → short-lived Deepgram token (never expose the key)
   submit → createResource(QuestionnaireResponse) → existing intake-form bot builds the Patient
```

The frontend owns voice I/O, barge-in, and the live form; the **`intake-chat`** bot is the conversational brain; the **`deepgram-token`** bot mints a browser-safe Deepgram credential.

## Code organization

`src` contains the React app and, under `src/bots/core`, the Medplum Bots.

Key additions for the AI assistant:

- `src/pages/IntakeChatPage.tsx` — the split-view voice/chat page.
- `src/hooks/useIntakeChat.ts` — the agent loop: builds the form schema, calls the `intake-chat` bot each turn, applies `updates`/`clear`, and rebuilds the live `QuestionnaireResponse`.
- `src/hooks/useVoiceIntake.ts` — Deepgram Flux STT + Aura TTS with barge-in, wrapping the agent.
- `public/pcm-worklet.js` — AudioWorklet that streams 16 kHz PCM to Flux.
- `src/bots/core/intake-chat.ts` — the Bedrock agent bot (hand-signed SigV4, no AWS SDK).
- `src/bots/core/deepgram-token.ts` — mints a short-lived Deepgram token (falls back to the API key if the key lacks grant permission).

`data` contains uploadable resources: `core` (questionnaire, value sets, bots) and `example` (sample org data).

## Getting started

### Prerequisites

- A **Medplum server with Bots enabled** — either the [hosted service](https://app.medplum.com/) (Bots are enabled per project; contact Medplum) or a self-hosted server where you're the admin (see [Local Medplum with Docker](#local-medplum-with-docker) below).
- **AWS Bedrock** access with model access granted for `openai.gpt-oss-20b` in your region.
- A **Deepgram** API key.

### Install and run

Fork and clone the repo, then:

```bash
cp .env.defaults .env       # then set MEDPLUM_BASE_URL (see .env.example for all vars)
npm install
npm run build:bots
npm run dev                 # http://localhost:3000/ (or :3001 if 3000 is taken)
```

Point `.env` at your Medplum API server:

```
MEDPLUM_BASE_URL=https://api.medplum.com/   # or http://localhost:8103/ for local Docker
```

> The AWS/Deepgram credentials are **bot secrets** set on the Medplum project (below), **not** frontend `.env` values. See [`.env.example`](.env.example).

### Upload data

From the app's nav menu (in order):

1. **Upload Core ValueSets**
2. **Upload Questionnaires**
3. **Upload Example Bots** — deploys `intake-form`, `intake-chat`, and `deepgram-token`
4. *(optional)* **Upload Example Data**

### Configure bot secrets

In the Medplum app, open your project's **Admin → Project → Secrets** tab and add:

| Secret | Required | Default |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | yes | — |
| `AWS_SECRET_ACCESS_KEY` | yes | — |
| `DEEPGRAM_API_KEY` | yes | — |
| `AWS_REGION` | no | `us-east-1` |
| `BEDROCK_MODEL_ID` | no | `openai.gpt-oss-20b-1:0` |
| `DEEPGRAM_VOICE_ID` | no | `aura-2-thalia-en` |

> `DEEPGRAM_VOICE_ID` sets the spoken [Aura voice](https://developers.deepgram.com/docs/tts-models) (e.g. `aura-2-apollo-en`). No redeploy needed — the `deepgram-token` bot reads it and the browser uses it for the next voice session.

> Some regions require a cross-region inference profile id, e.g. `us.openai.gpt-oss-20b-1:0` — set `BEDROCK_MODEL_ID` accordingly.

### Try it

Go to **New Patient (Voice)**, click **Start with voice** (or **Type instead**), and answer naturally — e.g. "I'm Alex Kim, born March 3 1990." Watch the form fill on the right; the assistant asks for what's missing and offers to submit when required fields are complete.

## Local Medplum with Docker

If you self-host with the standard Medplum `docker-compose` stack (`medplum-server` on `:8103`, `medplum-app` on `:3000`):

1. **Enable in-process bots** on the server: set `vmContextBotsEnabled: true` (or env `MEDPLUM_VM_CONTEXT_BOTS_ENABLED=true`) and restart the server container. Bots are deployed with `runtimeVersion: 'vmcontext'` by default here (override with `BOT_RUNTIME_VERSION=awslambda` for hosted AWS Lambda).
2. **Enable the `bots` feature** on your project (super admin): add `"bots"` to `Project.features` (edit the `Project` resource, or `PATCH /fhir/R4/Project/<id>`).
3. Point `.env` at `http://localhost:8103/`. The demo app runs on `:3001` when the Medplum app already holds `:3000` — fine as long as the server's `allowedOrigins` permits it (`*` by default in the sample compose).

## Notes and limitations

- **Repeating groups** (allergies, medications, etc.) are captured as a **single instance** in this demo.
- **Large value sets** (e.g. SNOMED medications/conditions) are treated as free text and resolved to codings on submit; smaller value sets (state, gender identity, …) are offered to the agent as options.
- The `intake-chat` bot calls Bedrock via a hand-rolled **SigV4** request (pure-JS SHA-256) instead of the AWS SDK, keeping the deployed bot small.

## Troubleshooting

Errors seen during setup, with causes and fixes. Several are already handled in this repo and are listed so you know what to check if they resurface.

| Symptom | Cause | Fix |
| --- | --- | --- |
| **"Bots not enabled"** | The project's `Project.features` doesn't include `"bots"`. | Enable it: hosted → contact Medplum; self-hosted → add `"bots"` to `Project.features` as super admin. Affects *all* bots, including `intake-form`. |
| **"VM Context bots not enabled on this server"** | Self-hosted server missing the flag. | Set `vmContextBotsEnabled: true` (env `MEDPLUM_VM_CONTEXT_BOTS_ENABLED=true`) and restart the server. |
| **CORS error / calls hit `/auth/me` on the wrong port** | `MEDPLUM_BASE_URL` points at the Medplum **app** (`:3000`) instead of the **API** (`:8103`), or the app's origin isn't allowed. | Set `MEDPLUM_BASE_URL=http://localhost:8103/`; ensure the server's `allowedOrigins` permits the app origin (`*` in the sample compose). |
| **"Upload Example Bots" button disabled** | Requires the questionnaire to be uploaded first. | Run **Upload Questionnaires** first. (Re-uploading bots is allowed — the upload is idempotent and redeploys code.) |
| **"Request body too large"** | Deploy bundle exceeded the server's `maxJsonSize` (default `1mb`). | Handled — bots are small (no AWS SDK). If a proxy or low `maxJsonSize` still blocks it, raise `maxJsonSize` (e.g. `"16mb"`) and any nginx `client_max_body_size`. |
| **"Unexpected token 'export'"** | Bot code bundled as ESM; vmcontext evaluates CommonJS. | Handled — `esbuild` builds bots as `cjs`. |
| **"exports.handler is not a function"** | esbuild reassigns `module.exports`; the vmcontext runner reads `exports.handler`. | Handled — an esbuild `footer` copies the handler onto `exports`. |
| **Bedrock 403 "signature we calculated does not match"** | SigV4 canonical path not double-encoded for non-S3 services. | Handled — the canonical URI is URI-encoded twice (`:` → `%253A`). Also verify the AWS secret and that model access is granted in your region. |
| **Deepgram grant 403 "Insufficient permissions"** | The Deepgram key can't mint short-lived grant tokens. | Handled — `deepgram-token` falls back to returning the API key for the browser WebSocket. For short-lived tokens, use a grant-capable Deepgram key. |
| **Voice: no audio / mic blocked** | Browser mic + WebSockets require a secure context. | Use `http://localhost` or HTTPS; grant mic permission. Text input works regardless. |

## About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code, and supports both [self-hosting](https://www.medplum.com/docs/self-hosting) and a [hosted service](https://app.medplum.com/).

- Read our [documentation](https://www.medplum.com/docs)
- Browse our [react component library](https://storybook.medplum.com/)
- Join our [Discord](https://discord.gg/medplum)
