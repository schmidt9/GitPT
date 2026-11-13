#!/usr/bin/env node
/**
 * GitPT OpenAI-compatible server primary for SmartGit integration, 
 * but may be used by other clients that send data in the same format 
 * and expect OpenAI's chat.completion API.
 *
 * POST /v1/chat/completions
 *
 * Extracts the Git diff from the request body (for instance SmartGit sends it inside
 * messages[0].content), passes it to GitPT's internal diff‑preparation and
 * message‑generation pipeline, and returns the result in OpenAI format.
 */

import http from "http";
import { randomUUID } from "crypto";
import { getConfig } from "../../config.js";
import { prepareCommitContext } from "../commit/summarizeDiff.js";
import { generateCommitMessage } from "../commit/generateCommitMessage.js";
import { formatAsChangeList } from "../commit/index.js";
import { getProvider } from "../../llm/registry.js";

export interface ServerOptions {
    port: number;
    host: string;
    defaultModel: string;
}

const MAX_INFLIGHT = Number(process.env.GITPT_SERVE_CONCURRENCY ?? 2);
const REQUEST_TIMEOUT_MS = Number(process.env.GITPT_SERVE_TIMEOUT_MS ?? 60_000);
const GENERIC_SYSTEM_PROMPT = "You are a helpful assistant. Follow the user's instructions exactly.";

/* ----------------------------- concurrency ----------------------------- */

let inflight = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
    if (inflight < MAX_INFLIGHT) {
        inflight++;
        return Promise.resolve(releaseSlot);
    }
    return new Promise((resolve) => {
        waitQueue.push(() => {
            inflight++;
            resolve(releaseSlot);
        });
    });
}

function releaseSlot(): void {
    inflight--;
    const next = waitQueue.shift();
    if (next) next();
}

/* ------------------------------ parsing --------------------------- */

function lastUserMessage(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
            return m.content;
        }
    }
    return null;
}

function extractDiff(content: string): string | null {
    // Primary: first line-anchored "diff --git" / "diff --cc" (covers
    // additions, deletions, renames, copies, mode changes, binaries,
    // submodules, combined diffs).
    const match = content.search(/(^|\n)(diff --git |diff --cc )/);
    if (match !== -1) {
        const start = content[match] === "\n" ? match + 1 : match;
        return content.slice(start).trim() || null;
    }
    // Fallback for future / localized prompts that omit the git header.
    const marker = "Git Diff:";
    const idx = content.indexOf(marker);
    if (idx !== -1) return content.slice(idx + marker.length).trim() || null;
    return null;
}

/* ------------------------------ generation ----------------------------- */

async function generateForDiff(diff: string): Promise<string> {
    const context = await prepareCommitContext(diff);

    if (getConfig().skipFinalSummarization) {
        // Mirrors commitCommand (index.ts L38–L42)
        if (context.entries.length === 0) {
            throw new Error(
                "GitPT: cannot skip final summarization — no per-file summaries " +
                "were produced (context window unavailable or empty diff).",
            );
        }
        return formatAsChangeList(context.entries);
    }

    // Mirrors commitCommand (index.ts L49–L50)
    return generateCommitMessage(context.framed);
}

async function generateArbitraryResponse(userText: string): Promise<string> {
    const provider = getProvider();
    if (!provider) {
        throw new Error('GitPT is not configured. Run "gitpt setup" first.');
    }
    const answer = await provider.complete({
        system: GENERIC_SYSTEM_PROMPT,
        user: userText,
        maxTokens: provider.maxOutputTokens,
    });
    if (!answer) throw new Error("No response returned from LLM");
    return answer;
}

/* ------------------------------ responses ------------------------------ */

function sseWrite(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunkBase(id: string, model: string) {
    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        system_fingerprint: "gitpt",
    };
}

function streamCompletion(res: http.ServerResponse, message: string, model: string): void {
    const id = `chatcmpl-${randomUUID()}`;
    const base = chunkBase(id, model);

    sseWrite(res, {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    for (const part of message.match(/\S+\s*/g) ?? [message]) {
        sseWrite(res, {
            ...base,
            choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        });
    }

    sseWrite(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });

    sseWrite(res, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    res.write("data: [DONE]\n\n");
    res.end();
}

function sendNonStreaming(res: http.ServerResponse, message: string, model: string): void {
    const id = `chatcmpl-${randomUUID()}`;
    const body = {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        system_fingerprint: "gitpt",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: message },
                finish_reason: "stop",
            },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

/* ------------------------------ the server ----------------------------- */

export async function startServer(opts: ServerOptions): Promise<void> {
    const server = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            return res.end();
        }

        // client probes /v1/models during AI setup.
        if (req.method === "GET" && req.url === "/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
                JSON.stringify({
                    object: "list",
                    data: [
                        { id: opts.defaultModel, object: "model", owned_by: "gitpt" },
                    ],
                }),
            );
        }

        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "ok" }));
        }

        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(
                JSON.stringify({
                    error: { message: "Not found", type: "not_found" },
                }),
            );
        }

        // Read request body.
        let rawBody = "";
        try {
            for await (const chunk of req) rawBody += chunk;
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(
                JSON.stringify({
                    error: { message: "Invalid request body", type: "invalid_request" },
                }),
            );
        }

        // Parse payload.
        let model = opts.defaultModel;
        let stream = false;
        let diff: string | null = null;
        let messages: unknown = undefined;

        try {
            const parsed = JSON.parse(rawBody);
            model = parsed.model || model;
            stream = parsed.stream === true;
            messages = parsed.messages;

            const content = parsed.messages?.[0]?.content;
            if (typeof content === "string") {
                diff = extractDiff(content);
            }
        } catch {
            /* malformed JSON → validation below handles it */
        }

        // Decide mode: commit-message generation vs. generic chat.
        let promptForLlm: string | null = null;
        let isCommitMode = false;

        if (diff) {
            isCommitMode = true;
        } else {
            promptForLlm = lastUserMessage(messages);
            if (!promptForLlm) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(
                    JSON.stringify({
                        error: {
                            message:
                                "No Git diff or user message found in request payload.",
                            type: "invalid_request",
                        },
                    }),
                );
            }
        }

        // Throttle concurrent LLM calls.
        const release = await acquireSlot();
        try {
            let answer: string;

            if (isCommitMode) {
                // Existing commit-message pipeline (respects skipFinalSummarization).
                answer = await withTimeout(
                    generateForDiff(diff!),
                    REQUEST_TIMEOUT_MS,
                    "gitpt generation",
                );
            } else {
                // Generic chat: forward the user's message to the configured LLM.
                answer = await withTimeout(
                    generateArbitraryResponse(promptForLlm!),
                    REQUEST_TIMEOUT_MS,
                    "gitpt chat",
                );
            }

            if (stream) {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                });
                streamCompletion(res, answer, model);
            } else {
                sendNonStreaming(res, answer, model);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[GitPT serve] ${msg}`);

            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({ error: { message: msg, type: "gitpt_error" } }),
                );
            } else {
                // Mid-stream error: emit SSE error envelope and terminate cleanly.
                sseWrite(res, { error: { message: msg, type: "gitpt_error" } });
                res.write("data: [DONE]\n\n");
                res.end();
            }
        } finally {
            release();
        }
    });

    await new Promise<void>((resolve) =>
        server.listen(opts.port, opts.host, resolve),
    );

    const cfg = getConfig();
    console.log(`GitPT serve listening on http://${opts.host}:${opts.port}`);
    console.log(`Default model: ${opts.defaultModel}`);
    console.log(`Concurrency: ${MAX_INFLIGHT}`);
    console.log(`skipFinalSummarization: ${cfg.skipFinalSummarization}`);

    const shutdown = (signal: string) => {
        console.log(`\nReceived ${signal}, shutting down…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms),
        ),
    ]);
}