# Read-only Cloudflare Email Sending inventory — 2026-09-26

No DNS records, sender configuration, cloud resources, Stripe catalog, or paid inference were created or changed. An Alchemy local-state plan with **no resources** used the existing OAuth staging profile for account-matched Cloudflare **GET** requests only. The ignored transcript is `.local-dev/zone-inventory.log` (mode 0600); credentials were never copied into this repository.

| Owned zone | Zone status | Existing outbound Email Sending domains |
| --- | --- | --- |
| `brainrotai.app` | active | `brainrotai.app` apex enabled; **unrelated product—do not use or modify** |
| `odysseas.tech` | active | none |

**Proposed sender (requires explicit user approval):** onboard `staging.clipforge.odysseas.tech` as an independent Cloudflare Email Sending subdomain and send from `hello@staging.clipforge.odysseas.tech`. Alternative: `mail.clipforge.odysseas.tech`. This is still a change inside the existing `odysseas.tech` production-owned zone; neither name has been reserved or onboarded. Exact-name DNS GETs returned **no records** at either candidate, its `cf-bounce`, `cf-bounce._domainkey`, or `_dmarc` name. Wildcard GETs for `*.odysseas.tech` and `*.clipforge.odysseas.tech` and the `_dmarc.odysseas.tech` name also returned no records. These are point-in-time API reads, not a guarantee that a future Cloudflare onboarding plan will be conflict-free.

## Changes requiring approval before onboarding

In **Compute → Email Service → Email Sending → Onboard Domain**, Cloudflare treats a subdomain as a separate sending domain. For the recommended name, onboarding would create/manage:

- MX at `cf-bounce.staging.clipforge.odysseas.tech` pointing to Cloudflare's three bounce mail exchangers (Cloudflare assigns priorities).
- SPF TXT at `cf-bounce.staging.clipforge.odysseas.tech` (documented example `v=spf1 include:_spf.mx.cloudflare.net ~all`).
- DKIM TXT at `cf-bounce._domainkey.staging.clipforge.odysseas.tech` (Cloudflare supplies the public key).
- DMARC TXT at `_dmarc.staging.clipforge.odysseas.tech`; review the exact policy in the dashboard (Cloudflare documents `p=none` as a monitoring starting point).

No root-domain inbound MX/routing change is requested. Outbound sending-domain DNS records remain managed/locked during that domain configuration. Verify their configured status in **Email Sending → Settings** before any real signup email. Cloudflare's [`allowed_sender_addresses`](https://developers.cloudflare.com/email-service/configuration/send-bindings/) can restrict Clipforge's Worker binding to its single approved sender; our stack does so. Cloudflare Email Sending requires Workers Paid to send to arbitrary customers; [pricing](https://developers.cloudflare.com/email-service/platform/pricing/) currently lists 3,000 outbound emails/account/month included, then $0.35 per 1,000. [Limits](https://developers.cloudflare.com/email-service/platform/limits/) say before sending-domain onboarding only verified destination addresses can receive mail; after onboarding, any recipient can, subject to account-level daily limits. Paid-plan status, sending quota and deliverability for this account remain **unverified**.

`https://clipforge-staging-web.<account-subdomain>.workers.dev` is for the web app only. `workers.dev` is not an onboardable customer-owned sender zone. Keep staging undeployed until the exact sender/DNS change is approved, onboarding is verified, and the changed stack receives a fresh account-checked Alchemy plan with TEST Stripe and persistent secrets.

Sources: [domain onboarding/DNS](https://developers.cloudflare.com/email-service/configuration/domains/), [subdomain onboarding](https://developers.cloudflare.com/email-service/configuration/subdomains/), [Workers send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [limits](https://developers.cloudflare.com/email-service/platform/limits/).
