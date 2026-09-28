---
name: clipforge-verify
description: Verify Clipforge changes with SHA-pinned local evidence, map affected product journeys, and report exact limits of offline vs live checks before opening a PR.
---

# Clipforge verification

Read [feature map](references/feature-map.md) before choosing tests. Do not describe fake providers as live staging validation.

1. Commit the candidate. Run `bun scripts/verify.ts local` from repository root (needs Bun 1.3.14, FFmpeg/ffprobe, and Playwright Chromium installed). This runs migration synchronization, types, unit/renderer tests, build, and the fake-provider browser journey. The script creates private mode-0700 `.local-dev/verification/<sha>-<timestamp>/report.json` with mode-0600 individual logs; `.local-dev` is ignored. If working uncommitted, `--allow-dirty` is allowed for debugging **only**; its report explicitly says `shaPinned:false` and is not PR acceptance evidence. Do not paste logs, fixture media, authentication details, or credentials into a PR.
2. Review the report: `gitSha`, `dirty:false`, `shaPinned:true`, `outcome:passed`, and all five checks passed. Re-run if HEAD changes. Report the SHA, check names/results, and **offline** scope in the PR. CI must be green for the same commit (or document why and repair CI).
3. For a UI change, inspect the rendered behavior in the local browser journey, or add a targeted Playwright assertion; for backend/schema/billing changes add a deterministic regression that catches the prior failure. For renderer changes verify FFmpeg output, framing and audio where applicable. Local tests do not establish real inbox delivery, TEST Stripe Checkout/webhooks, Nova ASR or Container render on staging.
4. Staging validation is a separate, explicitly authorized operation: read `docs/operations.md` and Alchemy's plan before mutations. A public 200/health response is **not** authentication or a product journey. No unapproved inference, deployment, DNS, Stripe charges, or production operations. Record historic staging evidence against its original deployed SHA; do not transfer it to a newer commit.
5. Review a pinned SHA, then amend/re-review on any changes. In the PR include the unresolved **material** risks, not speculative checklists. Do not block an offline PR merely because paid/provider acceptance needs separate authorization: label the scope clearly and leave product release gated.

Promote repeated reviewer findings into a test, type check or static guard. Never commit `.local-dev`, `.env`, private user media, logs or tokens. If CI or a contract fails, fix the cause and rerun rather than declaring success in prose.
