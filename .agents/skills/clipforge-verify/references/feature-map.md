# Clipforge feature-to-evidence map

| Customer journey | Code surfaces | Checks and blind spots |
|---|---|---|
| Signup, verification, password reset | `src/` auth/email, `alchemy.run.ts`, D1 auth migrations | Offline browser exercises fake email; staging binding acceptance recorded in README, **not real inbox delivery**. No open signup until owner-only restriction deliberately changed. |
| Subscription, TEST Checkout, invoices, minutes | `src/` billing/credit modules, `test/credits.test.ts`, `test/inference-budget.test.ts` | Offline ledger/idempotency; historic staging signed TEST invoice + source minutes, **not new HEAD** or real charges/renewals. |
| Upload, resumable chunks, admission, deletion | `src/` upload and media routes/workflows, `test/upload-admission.test.ts`, `test/media.test.ts`, `test/retention-sweep.test.ts`, `e2e/studio.spec.ts` | Local fake upload/job journey; authenticated tenant scoping and storage lifecycle require specific staging checks after deployment. |
| Transcription and suggestions | `src/` Workflow/inference, `test/native-transcription.test.ts`, `test/transcript.test.ts` | Offline Nova contract/chunk parsing; historic staging 43-second source and 99 timed words only. New inference costs require approval. |
| Edit captions/crop/cut | `src/` editor components, `renderer/captions.ts`, `renderer/captions.test.ts`, `e2e/studio.spec.ts` | Local browser + FFmpeg pixel comparison; look at editor controls for regressions. |
| Export/playback | `renderer/`, `src/` export Workflow and authenticated media routes, `renderer/overlap-render.test.ts`, `test/render-output.test.ts`, `e2e/studio.spec.ts` | Local FFmpeg and R2 contract; historic staged 20-second MP4, not the current HEAD. Check audio and video artifacts for render changes. |
| Deploy/release | `alchemy.run.ts`, `migrations/`, `drizzle/`, `docs/operations.md` | `bun run db:check`, `bun run build`, reviewed Alchemy plan, scoped staging journey only by explicit approval. No production deploy authorization. |

When adding a feature, add its code surfaces, deterministic regression and live boundary here. Report missing coverage honestly. Read `README.md` and `docs/operations.md` for the current published limitations and staging gates.
