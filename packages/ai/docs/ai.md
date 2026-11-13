# The AI package

`@scfloworg/ai` holds all access to language models: the types of a
conversation, the connections, the transports, the profiles of models, the
normalized errors, the report of usage and the agent loop. Every host uses it
the same way: an application, the `scflow` command, a test harness.

It depends on nothing, knows nothing of supply chains, MCL or actions, and
runs in the browser, in Tauri and under Bun. It talks to providers through the
global `fetch`, or the one the host gives. It stores no key: the host passes
the settings of a connection each time it creates a client.

```ts
import { createAiClient, runAgent } from "@scfloworg/ai";

const client = createAiClient({
  connection: { kind: "byok", baseUrl: "https://api.openai.com/v1", apiKey, model: "gpt-4o-mini" },
  onUsage: (usage) => console.error(usage),
});

for await (const chunk of client.chat({ messages: [{ role: "user", content: "Hello" }] })) {
  if (chunk.type === "text") process.stdout.write(chunk.text);
}
```

## Types

| Type | Is |
| --- | --- |
| `AiMessage` | One message: `role` (`system`, `user`, `assistant`, `tool`), `content`, and `images` (data URLs, user messages), `toolCalls` (assistant messages) or `toolCallId` (tool messages) |
| `AiToolCall` | A call the model asks for: `id`, `name`, and `arguments`, the raw JSON text the model wrote |
| `AiToolSpec` | A tool the model may call, in the shape of an MCP tool: `name`, `description`, `inputSchema` (a JSON Schema object), and optional `title` and `annotations` |
| `AiChatRequest` | `messages`, and optional `tools`, `model` (replaces the model of the connection), `tier` (`fast` or `strong`, see [Model tiers](#model-tiers)), `temperature` and `maxTokens` |
| `AiChunk` | One piece of a streamed answer: `text`, `tool-call` (a whole call), or `done` with the `finishReason`, the `usage` and the `retried` parameter when there is one |

The names are those of the `AiService` types of the framework, so the
framework can re-export them. One field changed: a tool gives its parameters
as `inputSchema`, the name MCP uses, so the AI tools of `@scfloworg/actions`
fit as they are.

The tool calls of one answer come after its text, each whole, then `done`
ends the stream.

## Connections

A request always goes through a connection, so the code that chats does not
know which kind is in use.

| Kind | Settings | Goes to |
| --- | --- | --- |
| `byok` | `baseUrl`, `apiKey`, `model`, optional `models` and `headers` | The provider, with the user's own key |

`byok` is the only kind today. A connection to a service run by SCFlow will be
a second kind of the same union, whose credential is an account token the host
gives through a callback that can renew it. Hosts write their code against
`AiConnection` and `AiConnectionKind`, so that kind adds no breaking change.

The `transport` of a connection says how to talk to it. `openai-compatible`
is the only one and the default: `POST {baseUrl}/chat/completions`, streamed
as server-sent events, which OpenAI, Azure, Ollama, LM Studio, OpenRouter and
the OpenAI-compatible endpoint of Anthropic accept. The transport is never
guessed from the host name. The one quirk of a host is a header: a call to
`anthropic.com` carries the header Anthropic asks for before it accepts a
call from a browser.

## Providers

`PROVIDERS` is a catalogue of the providers known to accept the
`openai-compatible` transport, so a host offers a choice instead of asking for
a URL. Each entry, a `ProviderPreset`, gives:

| Field | Is |
| --- | --- |
| `id` | A short stable name: `openai`, `anthropic`, `mistral`, `gemini`, `groq`, `openrouter`, `ollama`, `lmstudio` |
| `label` | The name shown to a user |
| `baseUrl` | The `baseUrl` of a `byok` connection to it |
| `models` | Model ids suggested for it, the first the default; empty when only the provider can tell |
| `keyUrl` | The page where a user gets a key, when there is one |
| `needsKey` | `false` for a local server, which reads no key: any non-empty text does |

The URLs change seldom; the model ids change often, so `models` are
suggestions a host shows and lets the user replace, never a list of what is
allowed. `providerOf(baseUrl)` gives the entry whose `baseUrl` is the given
one, compared without a trailing `/`, so a host shows the provider of a
connection it stored. The catalogue holds no key.

`listModels(connection, options)` asks a connection which models it serves:
`GET {baseUrl}/models` with the same credential and headers as a chat, read
as `{ data: [{ id }] }`. It gives the ids sorted, each once. It takes the
`fetch` and the `signal` a chat takes, and fails with the same `AiError`
kinds: `auth` with no key or a refused key, `network` with no answer,
`provider` for an answer it cannot read.

## Model tiers

A connection may name a model for each of two tiers, so a caller asks for the
kind of model a task needs rather than for a model id:

| Tier | For |
| --- | --- |
| `fast` | A cheap and quick model |
| `strong` | A model that plans and calls tools better, at a higher cost |

`models: { fast?, strong? }` of a connection gives them; a tier it leaves out
is its `model`. A request names the tier it wants with `tier`. The model of a
request is its `model` when it has one, else the model of its `tier`, else the
`model` of the connection. A connection with no `models` thus behaves as
before, whatever tier is asked.

The package does not read a request to choose its tier: the caller knows what
it asks. As a guide:

| The task | Tier |
| --- | --- |
| Answer a short question, rephrase, name, summarize, with no tool | `fast` |
| Change a project through several tool calls, plan, follow a long instruction | `strong` |
| A long conversation or images | `strong`, if the fast model is short of context or reads no image |
| Not known | `fast` with `escalate` in the agent loop |

## Model profiles

A request says what the caller wants; the transport sends what the model
accepts. A profile says what one model, or a family, accepts:

| Field | Means |
| --- | --- |
| `temperature` | `false` when the model refuses it; it is then not sent |
| `lengthLimit` | The name of the length limit: `max_tokens` (the default) or `max_completion_tokens` |
| `images` | `false` when the model reads no image |
| `tools` | `false` when the model calls no tool |

A request that has images or tools the profile refuses fails with
`unsupported-parameter` before anything is sent: dropping them would change
what the model is asked.

`DEFAULT_PROFILES` is a short table of rules, `{ match, profile }`, where
`match` is a model id with `*` for any text, compared without case and without
a `provider/` prefix such as OpenRouter writes. It covers the reasoning models
of OpenAI (`o1*`, `o3*`, `o4*`, `gpt-5*`), which refuse `temperature` and take
`max_completion_tokens`. A host gives its own rules in `profiles`; they are
tried before the defaults and the first match wins. A model no rule matches
gets the defaults of the provider: everything the caller asked is sent.

## Errors

Every failure of a call is an `AiError`, whose `kind` the caller branches on,
and whose `message` keeps the message of the provider.

| Kind | When |
| --- | --- |
| `auth` | No key, or the provider answers `401` or `403` |
| `rate-limit` | `429`, or a quota of the provider |
| `context-length` | The prompt is longer than the model accepts |
| `unsupported-parameter` | The model refuses a parameter or a value; `parameter` names it |
| `model-not-found` | The model id is unknown (`404`, or a `model_not_found` code) |
| `network` | No answer: the host is unreachable, or the stream is cut |
| `provider` | Any other failure, in an answer or in the stream |

`status` holds the HTTP status when there is one. An abort is not an `AiError`:
the abort error of `fetch` is thrown as it is.

When the model refuses an optional parameter (`temperature`, the length limit,
the request of usage in the stream), the transport retries once without it, or
with the other name of the length limit. The `done` chunk and the usage report
it in `retried`: `{ parameter, replacedBy?, message }`. A model with no profile
so works the first time, and the report says which rule to write. A second
refusal is thrown.

## Usage

`onUsage` is called once per chat, at its end, whatever the outcome:

| Field | Holds |
| --- | --- |
| `model` | The model the request named |
| `connection` | The kind of the connection |
| `inputTokens`, `outputTokens` | When the provider gives them |
| `durationMs` | From the request to the end of the stream |
| `outcome` | `ok`, `aborted` (the signal, or the caller stopped reading) or `error` |
| `error` | The kind of the error, with `outcome: "error"` |
| `retried` | The retried parameter, when there was one |

The host shows the usage; the package keeps no count. An exception thrown by
`onUsage` is ignored.

## The agent loop

`runAgent` asks the model, runs the tool calls it makes, gives back their
results, and asks again, until the model answers with no call or the turn
limit is reached.

```ts
const outcome = await runAgent({
  client,
  messages: [{ role: "system", content: "…" }, { role: "user", content: prompt }],
  tools,                                   // AiToolSpec[], toAiTools(actions) as they are
  approve: async (calls) => ask(calls),    // once per turn, with all the calls of the turn
  execute: async (call, args) => run(call.name, args),
  maxTurns: 10,
  signal,
  onEvent: (event) => show(event),
});
// outcome: { messages, text, turns, stopped: "done" | "turn-limit", escalated }
```

| Option | Is |
| --- | --- |
| `client` | Anything with the `chat` of `createAiClient` |
| `messages` | The conversation so far; the loop adds to a copy |
| `tools` | The tools the model may call |
| `execute(call, args)` | Runs one call, `args` being its arguments parsed; its result is sent back as JSON |
| `approve(calls)` | Optional. Called once per turn with every call of the turn, so the host approves them as a group. `true` approves them all, `false` none, a list of call ids those calls only |
| `maxTurns` | The number of answers asked of the model, `10` by default |
| `signal` | Aborts the chat and stops before the next call |
| `onEvent` | `text` as it streams, `tool-calls` when a turn asks for calls, `tool-result` for each call, `done` for each answer |
| `model`, `tier`, `temperature`, `maxTokens` | Passed with each request |
| `escalate` | Optional. With `true`, the loop moves from the `fast` tier to `strong` when the fast model fails, as below |

A call that is refused, has arguments that are not JSON, names no tool, or
whose `execute` throws, is answered to the model with `{ "error": message }`,
and the loop goes on: the model can correct itself. The calls of a turn run
one after the other, in the order the model gave them.

### Escalation

With `escalate: true`, the loop starts with the tier `fast`, unless `tier`
says `strong`, and moves to `strong` for the rest of the run when the fast
model:

- makes a call whose arguments are not JSON or that names no tool, or whose
  `execute` throws: the next turn is asked of the strong model, which reads
  the error as any model would;
- is refused a request with `unsupported-parameter`, for instance tools or
  images its profile does not take: the same turn is asked again of the
  strong model.

A call the user refused does not escalate: the model did not fail. The move
happens once; `onEvent` gets `{ type: "escalated", reason }`, where `reason`
is `call-failed` or `unsupported-parameter`, and `escalated` of the outcome is
`true`. A `model` given to the loop names the model of every request, so
there is nothing to escalate. When the connection names no model for the
tiers, both are its `model`, and an escalation asks the same model again.

`stopped` is `done` when the last answer asked for no call, and `turn-limit`
when the limit came first; then the last calls have run and their results are
in `messages`, but the model has not read them.
