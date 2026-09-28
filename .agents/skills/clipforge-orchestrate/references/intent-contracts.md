# Intent-specific starting messages

Each message must be **self-contained**. Replace brackets with the user's actual objective, branch, checkout, acceptance details and allowed actions. New Pi sessions receive this message and project context, **not** the orchestrator chat. Do not include secrets or copy the parent's entire transcript. Session names should expose purpose, e.g. `Clipforge PR: <slug>`, `Clipforge investigation: <topic>`, `Clipforge long-term: <area>`.

## PR implementation (`lifecycle: task`, dedicated worktree)

> You own **[exact user feature/bug objective]** through a shippable, independently reviewable PR. Work only in **[absolute checkout]** on **[branch]**, based on **[base SHA]**. Acceptance: **[observable behavior and relevant failure/tenant/billing cases]**. Non-goals: **[explicit exclusions]**. Follow `AGENTS.md` and `.agents/skills/clipforge-verify/SKILL.md`; reproduce or characterize the problem, add a regression, implement the complete behavior, inspect the resulting local UI/media as applicable, commit, run SHA-pinned verification, push the feature branch and open a PR with exact-SHA offline evidence and real limitations. Confirm GitHub CI for the same SHA; fix actionable failures and review your final diff. Do **not** stop after a first slice or imply fake-provider tests prove live staging. No staging deploy, real email/Stripe/inference, production changes, or paid calls without explicit approval. Choose reversible implementation details yourself. If genuinely blocked by external authorization, continue safe local work and hand off a precise blocker plus evidence. Reply with PR URL, SHA, checks and unresolved release gate(s), or an honest reason a PR could not be completed.

`pi_sessions` returning completed is not PR acceptance: the orchestrator verifies PR HEAD/CI and sends follow-ups to this **same session** if evidence is missing. Do not force-merge a worker's PR.

## Investigation / review (`lifecycle: task` unless requested persistent; read-only cwd)

> Investigate **[exact user question or PR/commit to review]** in **[absolute checkout]** at **[reference SHA]**. Read-only: do not edit code, provision infrastructure, run paid models, open a PR or alter another agent's worktree. Use code/official sources/tests as needed, clearly distinguish observations from hypotheses, and report concise findings with file/commit pointers and confidence. For a review, report only actionable defects tied to the pinned SHA; recheck the SHA if it changes. Reply with the answer or review findings and remaining uncertainties, not an implementation plan disguised as completed work.

If the investigation needs mutable fixtures, give it a separate throwaway checkout and explicit cleanup/evidence rules rather than running concurrently in another writer's checkout. Its answer may arrive while PR workers are still running.

## Long-term ownership (`lifecycle: persistent`, dedicated worktree if editing)

> Own long-term exploration of **[exact user area/refactor]** in **[absolute checkout]** on **[branch]**. First map current architecture, constraints, tests and risks; then perform useful local experiments or prototypes where appropriate, recording what was learned and any open design choice. Do not interpret this brief as permission or pressure to open a PR or deploy. Preserve work and context across days; present meaningful trade-offs for the user's decision and await a new instruction before committing to a major direction. You may commit clearly labelled local experiments on your own branch when useful, but do not merge, deploy, use paid/cloud services or discard another worktree. When you reach a natural checkpoint, respond with findings, evidence and suggested next step; remain available in this persistent session for follow-ups.

A persistent run settling at a checkpoint is **expected**, not a failure or PR-ready signal. User can talk directly to this session or have the orchestrator send a follow-up with exact mailbox receipt tracking.

## Orchestrator acceptance checklist

- Are objectives genuinely independent enough for separate writers? If not, sequence or give one owner; a review can stay read-only in parallel.
- Does each editing session have a unique clean checkout, approved local env, branch and no shared mutable test database/ports?
- Does each starting message say whether **a PR is requested or prohibited** and define only the corresponding evidence?
- Has `pi_sessions.create` confirmed a starting user entry, not merely opened an idle pane? Preserve the returned session ID.
- For follow-ups, was the exact mailbox `messageId` accepted and watched, not confused with the previous run?
- Before declaring a PR shippable, do PR HEAD, local report SHA, CI and reviewed diff all name the same commit? Are staging limitations explicit?
- Before closing, did the investigator answer without edits, and does the long-term session remain persistent rather than being auto-cleaned?
