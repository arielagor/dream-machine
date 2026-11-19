/**
 * The three model families.
 *
 * Each adapter turns a prompt into a {@link CouncilVote}. They never throw: a
 * provider outage, a timeout, a missing credential, or an empty response all
 * become an `unreachable` vote, which {@link tally} treats as a degraded panel
 * and therefore as no-merge. Failing loudly toward "do not merge" is the whole
 * point — a family that quietly drops out must not look like consent.
 *
 * Claude is called through the local `claude` CLI rather than the Anthropic
 * Messages API. In CI the workflow installs the CLI and supplies
 * `CLAUDE_CODE_OAUTH_TOKEN`; locally the developer's existing login is used.
 * Either way `ANTHROPIC_API_KEY` is stripped from the child environment, since
 * leaving it set silently reroutes the call to metered API billing. That choice
 * also keeps this package free of runtime dependencies, matching a workspace
 * whose CI proves the engine builds with no optional backends present.
 */

import { spawn } from 'node:child_process';
import { coerceVote, unreachableVote, type CouncilVote, type Family } from './schema.js';

export interface FamilyCallOptions {
  prompt: string;
  system: string;
  round: 1 | 2;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export type FamilyCaller = (opts: FamilyCallOptions) => Promise<CouncilVote>;

/** Model per family. Overridable so a run can be pinned without a code change. */
export function modelFor(family: Family, env: NodeJS.ProcessEnv = process.env): string {
  switch (family) {
    case 'claude':
      // The `opus` ALIAS, not a pinned id — the CLI resolves it to the newest
      // Opus at call time, so this line cannot go stale.
      return env.COUNCIL_CLAUDE_MODEL || 'opus';
    case 'gemini':
      // Frontier seat (2026-11-18): Gemini 4 Neon, AA v5.0.1 61, $3/$15 per 1M.
      return env.COUNCIL_GEMINI_MODEL || 'gemini-4-neon';
    case 'xai':
      return env.COUNCIL_XAI_MODEL || 'grok-4.5';
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: `unparseable response body: ${text.slice(0, 200)}` };
    }
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- claude ----------------------------------------------------------------

export const callClaude: FamilyCaller = async (opts) => {
  const env = { ...(opts.env ?? process.env) };
  const model = modelFor('claude', env);
  // Stripping the API key is not a tidiness choice: with it set, the CLI bills
  // the metered API instead of the subscription the OAuth token pays for.
  delete env.ANTHROPIC_API_KEY;

  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    // The council reads and judges; it must never be able to touch the checkout
    // it is judging.
    '--disallowedTools',
    'Bash,Edit,Write,NotebookEdit',
    '--append-system-prompt',
    opts.system,
  ];

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('claude', args, { env, shell: process.platform === 'win32' });
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: (e as Error).message, timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => (stdout += d));
      child.stderr?.on('data', (d: string) => (stderr += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: e.message, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });

      // Long prompts must go over stdin: an argv-borne prompt blows past the
      // Windows command-line cap, and stdin lets us force UTF-8 so em-dashes
      // and arrows survive a cp1252 console.
      child.stdin?.setDefaultEncoding('utf8');
      child.stdin?.end(opts.prompt, 'utf8');
    },
  );

  if (result.timedOut) {
    return unreachableVote('claude', model, opts.round, `claude CLI timed out after ${opts.timeoutMs}ms`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return unreachableVote('claude', model, opts.round, `claude CLI exit ${result.code}: ${detail || 'no output'}`);
  }

  // `--output-format json` wraps the answer; fall back to raw stdout if it did not.
  let text = result.stdout.trim();
  try {
    const wrapper = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['result', 'text', 'content', 'response']) {
      const v = wrapper[key];
      if (typeof v === 'string' && v.trim()) {
        text = v.trim();
        break;
      }
    }
  } catch {
    /* not the JSON wrapper — use stdout verbatim */
  }

  if (!text) return unreachableVote('claude', model, opts.round, 'claude CLI returned an empty response');
  return coerceVote({ family: 'claude', model, round: opts.round, raw: text });
};

// --- gemini ----------------------------------------------------------------

export const callGemini: FamilyCaller = async (opts) => {
  const env = opts.env ?? process.env;
  const model = modelFor('gemini', env);
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!key) return unreachableVote('gemini', model, opts.round, 'GEMINI_API_KEY unset');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    systemInstruction: { parts: [{ text: opts.system }] },
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: 'high' },
    },
  };

  let res = await postJson(url, body, {}, opts.timeoutMs);
  if (!res.ok && /thinking/i.test(res.error)) {
    // Older Gemini revisions reject thinkingConfig outright; retry without it
    // rather than losing the seat over a config the model does not need.
    delete (body.generationConfig as Record<string, unknown>).thinkingConfig;
    res = await postJson(url, body, {}, opts.timeoutMs);
  }
  if (!res.ok) return unreachableVote('gemini', model, opts.round, res.error);

  const parts: string[] = [];
  for (const candidate of res.data?.candidates ?? []) {
    for (const part of candidate?.content?.parts ?? []) {
      // Thought parts are the model's scratchpad, not its answer.
      if (!part?.thought && typeof part?.text === 'string') parts.push(part.text);
    }
  }
  const text = parts.join('').trim();
  if (!text) {
    const reason = res.data?.candidates?.[0]?.finishReason ?? 'unknown';
    return unreachableVote('gemini', model, opts.round, `empty response (finishReason=${reason})`);
  }
  return coerceVote({ family: 'gemini', model, round: opts.round, raw: text });
};

// --- xai / grok ------------------------------------------------------------

/** Pull visible text out of an OpenAI-Responses-shaped payload. */
function extractResponsesText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const out: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const c of item?.content ?? []) {
      if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') out.push(c.text);
    }
  }
  return out.join('').trim();
}

export const callXai: FamilyCaller = async (opts) => {
  const env = opts.env ?? process.env;
  const model = modelFor('xai', env);
  const key = env.XAI_API_KEY;
  if (!key) return unreachableVote('xai', model, opts.round, 'XAI_API_KEY unset');

  const effort = env.COUNCIL_REASONING_EFFORT || 'high';
  let cap = Number(env.COUNCIL_MAX_OUTPUT_TOKENS) || 32768;

  // A reasoning model can spend its entire output budget on hidden reasoning and
  // return 200 with no visible text. Retry once at double the cap, then report
  // WHY it was empty — the bare word "empty" reads like broken wiring and sends
  // the next reader hunting for a bug in the request instead of the budget.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await postJson(
      'https://api.x.ai/v1/responses',
      {
        model,
        input: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        reasoning: { effort },
        max_output_tokens: cap,
      },
      { Authorization: `Bearer ${key}` },
      opts.timeoutMs,
    );
    if (!res.ok) return unreachableVote('xai', model, opts.round, res.error);

    const text = extractResponsesText(res.data);
    if (text) return coerceVote({ family: 'xai', model, round: opts.round, raw: text });

    const reason = res.data?.incomplete_details?.reason ?? '';
    if (attempt === 1 && reason === 'max_output_tokens') {
      cap *= 2;
      continue;
    }
    const reasoningTokens = res.data?.usage?.output_tokens_details?.reasoning_tokens;
    return unreachableVote(
      'xai',
      model,
      opts.round,
      `empty response (status=${res.data?.status} cap=${cap}` +
        (reason ? ` incomplete_reason=${reason}` : '') +
        (reasoningTokens != null ? ` reasoning_tokens=${reasoningTokens}` : '') +
        ') — raise COUNCIL_MAX_OUTPUT_TOKENS or lower COUNCIL_REASONING_EFFORT',
    );
  }
  /* istanbul ignore next — the loop always returns */
  return unreachableVote('xai', model, opts.round, 'exhausted retries');
};

export const CALLERS: Record<Family, FamilyCaller> = {
  claude: callClaude,
  gemini: callGemini,
  xai: callXai,
};
