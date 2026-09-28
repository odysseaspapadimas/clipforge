# Local environment in multiple worktrees

Clipforge uses a **tracked, reviewed `.envrc`** to load two optional, data-only dotenv files:

1. `~/.config/project-env/clipforge/local.env` (or `$XDG_CONFIG_HOME/project-env/clipforge/local.env`) — shared local-development credentials/defaults, outside Git. Create its parent mode `0700`, file mode `0600`. Do not put staging/deploy/Stripe credentials here.
2. `<worktree>/.env.local` — ignored checkout-specific overrides, e.g. `CLIPFORGE_DEV_PORT`, `CLIPFORGE_RENDERER_PORT`, independent local database URLs for projects that need them. Each worktree has its own file; keep permissions `0600`.

The latter takes precedence for duplicate keys. Both are optional, so offline tests work on a clean clone without secrets. `.env.example` documents **staging** vars; it is not a local-dev env file. The `.envrc` watches both files, including when an optional file appears later. Do not source an arbitrary shell script as an env file.

Install direnv, enable its hook in the interactive shell, inspect `.envrc`, then **allow each checkout separately** using `direnv allow <checkout>`; never whitelist the whole worktree parent. For commands launched outside a hooked shell (Herdr agent launch, Neovim task, CI), use `direnv exec <checkout> <command>`. Merely changing Neovim's cwd does not update existing terminals/agents; create a new shell/agent in the checkout or run a command through `direnv exec`. An unapproved `.envrc` must fail closed, not silently run without the expected local secrets.

Example with no secret values in a shell history:

```sh
install -d -m 700 "$HOME/.config/project-env/clipforge"
test -e "$HOME/.config/project-env/clipforge/local.env" || install -m 600 /dev/null "$HOME/.config/project-env/clipforge/local.env"
# Edit the shared local.env securely; do not put it in a worktree.
cd /path/to/clipforge-worktree
printf 'CLIPFORGE_DEV_PORT=15173\nCLIPFORGE_RENDERER_PORT=18081\n' > .env.local
chmod 600 .env.local
direnv allow .
direnv exec . bun scripts/verify.ts local
```

Use unique ports and separate mutable databases for simultaneous worktrees. The browser E2E picks up both `CLIPFORGE_DEV_PORT` and `CLIPFORGE_RENDERER_PORT`. Vite and Bun can also load checkout-local `.env*` into the process: check precedence before defining the same key in both places. Cloudflare local Workers use `.dev.vars`/`.env` by their own rules; a project that needs them should generate an ignored **local-only** file for each checkout, not blindly copy deployed credentials.

**Staging is not local:** `ALCHEMY_STAGE`, `STRIPE_API_KEY`, `CLIPFORGE_AUTH_SECRET` and Cloudflare/Stripe identities must not be placed in the shared local-dev env or per-worktree `.env.local`. Load approved persistent staging secrets only for the explicitly authorized command, review the Alchemy plan and identity as described in [operations](operations.md). A checkout selection is not an authorization boundary; globally authenticated CLIs can still reach cloud resources.

Do not copy or link `.local-dev/`: it contains private evidence, media and potentially sensitive logs. It belongs to exactly one checkout and is never copied by worktree creation. A future automated creation hook should explicitly allowlist only genuinely required local files; never copy all ignored files.
