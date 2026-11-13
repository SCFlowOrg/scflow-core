# @scfloworg/ai

The neutral AI package: the types of a conversation with a language model, the
connections, an OpenAI-compatible transport over `fetch`, the profiles of
models, the normalized errors, the report of usage and the agent loop.

It depends on nothing, knows nothing of supply chains, MCL or actions, and
runs in the browser, in Tauri and under Bun. It stores no key: the host passes
the settings of a connection. The use of the package is in
[docs/ai.md](docs/ai.md).

```ts
import { createAiClient, runAgent } from "@scfloworg/ai";
import { toAiTools } from "@scfloworg/actions";

const client = createAiClient({
  connection: { kind: "byok", baseUrl: "https://api.openai.com/v1", apiKey, model: "gpt-4o-mini" },
  onUsage: (usage) => console.error(usage),
});

const outcome = await runAgent({
  client,
  messages: [{ role: "user", content: "Create a task named Plan" }],
  tools: toAiTools(registry.list()),
  approve: async (calls) => confirm(`Run ${calls.length} calls?`),
  execute: async (call, args) => (await registry.run(actionIdOfTool(call.name)!, args)).result,
});
```

| Part | Gives |
| --- | --- |
| `AiMessage`, `AiToolCall`, `AiToolSpec`, `AiChatRequest`, `AiChunk` | The types of a conversation, with images, tools in the shape of MCP, and streamed chunks |
| `AiConnection` | The settings of a connection: `byok` (own key) today |
| `PROVIDERS`, `providerOf`, `listModels` | A catalogue of OpenAI-compatible providers (URL, suggested models, key page), and the models a connection serves |
| `AiModelTier` | `fast` or `strong`: a connection names a model for each in `models`, a request asks for one with `tier` |
| `createAiClient` | The client of a connection: `chat` streams one answer, through the OpenAI-compatible transport |
| `ModelProfile`, `DEFAULT_PROFILES`, `profileOf` | What a model accepts: `temperature`, the name of the length limit, images, tools |
| `AiError` | The normalized error; callers branch on `.kind`, the message keeps the provider's |
| `AiUsage` | The report of one chat: model, connection kind, tokens, duration, outcome |
| `runAgent` | The agent loop: tool calls approved once per turn, a turn limit, an abort signal, and an optional escalation from the `fast` tier to `strong` when the fast model fails |

The tests run against recorded streams and error bodies in `tests/fixtures`,
with no network.
