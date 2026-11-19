# 2026-11-18 — Council Gemini seat: gemini-3.1-pro-preview -> gemini-4-neon

Ariel asked (2026-11-18) to move every Gemini call to the best-value model for its role.

- `packages/council/src/families.ts` `modelFor('gemini')` default: `gemini-3.1-pro-preview` -> `gemini-4-neon`. `COUNCIL_GEMINI_MODEL` still overrides it.
- Why: this is the council's frontier judgment seat (one of three votes that decide a merge). Neon is the top Gemini on Artificial Analysis Intelligence Index v5.0.1 (61) at $3/$15 per 1M. 3.1-pro-preview is a preview at $2/$12 with no v5 score; Argon/Carbon double to $4/$20 on 2026-12-01.
- Smoke 2026-11-18: a council-style JSON vote prompt on `gemini-4-neon` returned valid JSON (`modelVersion: gemini-4-neon`, 266 thought tokens, ~15 s). Neon accepts `thinkingLevel`, so the existing `thinkingConfig: high` path is used as before.
- Note: `maxOutputTokens: 8192` includes thinking tokens. Unchanged from the 3.1-pro-preview setup; raise it if Neon votes start arriving truncated.
