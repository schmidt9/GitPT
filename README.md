# GitPT

GitPT (Git Prompt Tool) is a git command alias that writes your commit messages with an LLM, built for on-device models. Use it anywhere you use git: every command it doesn't change passes straight through, so you can replace git with it and lose nothing. The one command that changes is `commit`, which writes the message for you.

Big remote models already write commits fine. The harder case is the small local model on your machine (Apple's Foundation Models, Ollama, LM Studio), which holds only a few thousand tokens. A real diff is much larger, so GitPT summarizes it file by file until it fits the model's context window, then writes the message from that summary. Remote APIs (OpenAI, Anthropic, OpenRouter) work too.

![GitPT generating a commit message](assets/demo.gif)

<sub>The diff is summarized to fit the model's context window before the message is written.</sub>

> **New: Apple Foundation Models.** On macOS 27 and later, GitPT runs on Apple's built-in on-device model. No API key, no signup, nothing leaves your Mac. Run `gitpt setup` and choose Apple Foundation Models.

## Install

```bash
npm install -g gitpt
```

## Setup

```bash
gitpt setup     # pick a model
```

> **Apple Foundation Models:** Enable Apple Intelligence in System Settings and run `sudo fm license` to accept the CLI terms before setup. Acceptance applies to every user on the Mac.

Optional: alias git so GitPT runs everywhere you already type git.

```bash
alias git=gitpt
```

## Config file location

Created when running `gitpt setup`. For individual keys that are not covered by `gitpt setup` (such as the advanced summarization options below), edit `gitpt.json` directly

macOS / Linux `~/.config/configstore/gitpt.json`

Windows	`%USERPROFILE%\.config\configstore\gitpt.json`

## Available keys

| Key | Type | Description |
| --- | --- | --- |
| provider | `"openrouter"` \| `"local"` \| `"apple"` \| `"openai"` \| `"anthropic"` | LLM provider. |
| customLLMEndpoint | `string` | Custom base URL for an OpenAI-compatible endpoint (used with "local" or custom servers). |
| model | `string` | Model ID, e.g. "openai/gpt-4.1-mini" or a local model name. |
| apiKey | `string` | API key for the selected remote provider. |
| apiKeys | `Record<string, string>` | Per-provider API keys, keyed by provider name. |
| contextWindow | `number` | Manual override for the model's context-window size, in tokens. |
| debug | `boolean` | Enable verbose logging. |
| summarySystemPromptPath | `string` | Path to a file whose contents replace the system prompt used when summarizing each diff chunk. Supports `~/` and relative paths. |
| summaryUserPromptPath | `string` | Path to a file whose contents are used as the user-prompt template for each chunk. Use `{{diff}}` (or `{{chunk}}`) as a placeholder; if omitted, the chunk is appended. |
| skipFinalSummarization | `boolean` | When true, GitPT stops after the per-file summarization step and emits the change list directly instead of asking the LLM for a single commit message. |

## Examples

### Minimal remote setup

```json
{
  "provider": "openrouter",
  "model": "openai/gpt-4.1-mini",
  "apiKey": "sk-or-..."
}
```

### On-device Apple model (no API key)

```json
{
  "provider": "apple",
  "model": "system"
}
```

### Custom OpenAI-compatible endpoint

```json
{
  "provider": "local",
  "customLLMEndpoint": "http://localhost:11434/v1",
  "model": "llama3.1"
}
```

### Custom summarization prompts from files

```json
{
  "summarySystemPromptPath": "~/.config/configstore/gitpt-summary-system.md",
  "summaryUserPromptPath": "~/.config/configstore/gitpt-summary-user.md"
}
```

`~/.config/configstore/gitpt-summary-system.md`:

```text
You are condensing a git diff fragment.
Output one line per file: <filename>: <summary>
```

`~/.config/configstore/gitpt-summary-user.md`:
```text
Summarize the changes in this diff fragment:

{{diff}}
```

### Change-list mode (skip final summarization)

```json
{
  "skipFinalSummarization": true
}
```

With this enabled, gitpt commit produces output like:

```text
README.md: update install steps;
src/main.py: handle null userId;
package.json: bump lodash to 4.17.21
```

instead of a single commit-message paragraph.

### Multiline prompts

If you prefer to keep prompts inline in `gitpt.json` rather than in separate files, represent line breaks with `\n`:

```json
{
  "summarySystemPrompt": "You are condensing a git diff fragment.\nOutput one line per file: <filename>: <summary>"
}
```

Using `summarySystemPromptPath` / `summaryUserPromptPath` is usually more convenient because you can edit a normal multi-line file without escaping.

## `gitpt serve` — OpenAI‑compatible HTTP server

GitPT can run as a local HTTP server that speaks the OpenAI Chat Completions API. This lets any AI‑powered Git client that supports a **custom OpenAI‑compatible endpoint** — notably [SmartGit](https://docs.smartgit.dev/latest/manual/integrations/ai/built-in-ai) — use GitPT to generate commit messages, without the client needing to know anything about GitPT or its LLM configuration.

```bash
gitpt serve
# → GitPT serve listening on http://127.0.0.1:9999
# → Default model: foundation
# → Concurrency: 2
# → skipFinalSummarization: false
```

Point your client at `http://127.0.0.1:4242/v1` with any model name (the server echoes it back; the default is `foundation`, which matches SmartGit's built‑in expectations for macOS).

### What the server does

`POST /v1/chat/completions` accepts two kinds of requests and routes them automatically:

| Request contains | Behaviour |
|------------------|-----------|
| A Git diff (detected by a line starting with `diff --git` or `diff --cc`, or SmartGit's `Git Diff:` marker) | Runs GitPT's full commit‑message pipeline: `prepareCommitContext` → optional per‑file summarization → `generateCommitMessage`. Honours `skipFinalSummarization` from your GitPT config exactly as `gitpt commit` does. |
| A plain user message and **no** diff | Forwards the last `role: "user"` message to the configured LLM with a minimal system prompt. Used by SmartGit's connection test and any other plain‑chat probe. |

Responses are OpenAI‑compatible and support `"stream": true` via Server‑Sent Events (`data: {…}\n\n` chunks terminated by `data: [DONE]`). Non‑streaming requests receive a standard `chat.completion` JSON body.

Because the diff comes from the request payload, **one server instance serves every repository**. No per‑repository configuration is required.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/chat/completions` | Commit‑message generation or generic chat |
| `GET`  | `/v1/models` | Static model list (used by SmartGit's AI setup) |
| `GET`  | `/health` | Liveness probe, returns `{ "status": "ok" }` |

### Options

```
-p, --port <port>   Port to listen on (default: 9999)
--host <host>       Interface to bind (default: 127.0.0.1)
-m, --model <model> Default model name advertised to clients (default: foundation)
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GITPT_SERVE_PORT` | `4242` | Port (overridden by `--port`) |
| `GITPT_SERVE_HOST` | `127.0.0.1` | Bind interface (overridden by `--host`) |
| `GITPT_SERVE_MODEL` | `foundation` | Default model name (overridden by `--model`) |
| `GITPT_SERVE_CONCURRENCY` | `2` | Max concurrent LLM generations |
| `GITPT_SERVE_TIMEOUT_MS` | `60000` | Per‑request timeout in milliseconds |

### SmartGit setup

1. Run `gitpt setup` once so a provider and API key are configured.
2. Start the server: `gitpt serve`.
3. In SmartGit → *Preferences → AI → Custom (OpenAI compatible)*:
   - **Base URL:** `http://127.0.0.1:4242/v1`
   - **Model:** `foundation`

### Security notes

- The server binds to **`127.0.0.1` by default**, so it is not reachable from other machines. Only use `--host 0.0.0.0` if you understand that any host on your network could trigger LLM calls billed to your API key.
- The server **does not check the `Authorization` header** — it relies on loopback binding for access control. If you expose it beyond `localhost`, put it behind a reverse proxy that enforces authentication.
- All LLM calls go through the provider configured with `gitpt setup`; no credentials are read from request headers or bodies.

### Implementation notes

- The HTTP layer lives in `src/commands/serve/server.ts`, registered as `gitpt serve` in the CLI entry point.
- Commit‑message generation reuses `prepareCommitContext` and `generateCommitMessage` from the commit command, so changes to the core prompt or summarization logic automatically apply to the server.
- Concurrent requests are queued behind a small semaphore (`GITPT_SERVE_CONCURRENCY`) to avoid saturating the provider.
- `SIGINT` / `SIGTERM` trigger a graceful shutdown with a 5‑second grace period for in‑flight requests.

## Use

With plain git, you write the message yourself:

```bash
git add .
git commit -m "fix: handle empty staged diff"   # you write the message
```

With GitPT, you don't:

```bash
gitpt add .
gitpt commit                                    # GitPT writes it from the diff
```

`gitpt commit` reads your staged diff, writes the message, and opens it in your editor. Save and close to commit.

### Through plain `git commit`

Prefer typing `git commit`? Two ways:

- **Shell alias** — add `alias git=gitpt` to your shell rc, then `git commit` runs GitPT.
- **Git hook** — run `gitpt hook install` once. A normal `git commit` (without `-m`) then opens your editor prefilled with an AI-generated message. It steps aside for `-m`, merges, squashes, and amends, and never blocks a commit if generation fails. Remove it with `gitpt hook uninstall`.

## Commands

- `gitpt commit`: write a commit message from staged changes. Respects `-m` and your commitlint rules.
- `gitpt model`: pick or switch the model. Each provider keeps its own key.
- `gitpt setup` / `gitpt config` / `gitpt reset`: configure, show, or clear settings.
- `gitpt pr create`: draft a pull request title and description with the `gh` CLI (experimental).
- `gitpt hook install` / `gitpt hook uninstall`: use GitPT through a plain `git commit` via a `prepare-commit-msg` hook.

## Models

- **On-device**: Apple's Foundation Models on macOS 27 or later (no API key), or any OpenAI-compatible local server such as Ollama or LM Studio.
- **Remote**: OpenAI, Anthropic, OpenRouter. Bring an API key.

## Requests and bugs

Want a feature or hit a bug? [Open an issue](https://github.com/bartaxyz/GitPT/issues).

## License

MIT
