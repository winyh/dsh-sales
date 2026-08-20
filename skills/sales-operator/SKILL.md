---
name: sales-operator
description: Use dsh-sales to audit sales readiness, qualify opportunities, analyze pipelines, review offers, forecast revenue and generate evidence-backed sales artifacts from local Markdown/CSV/JSON/JSONL.
---

# Sales Operator

Use the deterministic dsh-sales tools before making claims about deal quality, close probability or revenue. The default motion is B2B or high-ticket sales after an opportunity, product value or commercial context already exists. The plugin is local-first and planning-oriented: it does not write CRM records, contact prospects, submit quotes or approve commercial terms.

## Zero-threshold workflow

1. If the user asks what is missing, start with `sales_onboarding`.
2. If the user provides a handoff or one opportunity, use `sales_deal_review`; do not restart demand discovery.
3. If the user provides a pipeline dataset, use `sales_funnel_analyze` or `sales_forecast`.
4. If the user asks about price, packaging or margin, send calculation work to `dsh-business`, then use `sales_offer_review` for customer-side readiness.
5. If the user asks for communication, proposal, close plan or expansion review, use the smallest `sales_playbook_generate` artifact and the matching template.
6. Show evidence, assumptions, warnings and next actions before any artifact write.

## Routing to other local plugins

- Need demand evidence, ICP or JTBD discovery: refer to `dsh-idea`.
- Need product value proof, PMF or product readiness: refer to `dsh-product`.
- Need price, packaging, profitability or discount boundaries: refer to `dsh-business`.
- Need acquisition, retention, revenue analytics or growth experiments: refer to `dsh-growth`.

These are soft handoffs through source paths and artifacts. Do not assume another plugin is installed or call its tools from this plugin.

## Default stage sequence

`lead → qualified → discovery → solution → proposal → negotiation → closed-won / closed-lost → expansion`

Each transition needs a customer action, an owner, a date and evidence. If those fields are absent, return `validate` or `hold`; do not increase the close probability because a meeting or proposal occurred.

## Decision gates

Do not advance a deal because a framework field is filled. A gate passes only when the evidence, owner, date and decision rule are visible. “Interested”, “good meeting” and “send proposal” are not customer commitments without a measurable next action.

## Output order

Return: answer-first finding; evidence and sources; assumptions and warnings; current gate; next customer action; owner/date; and only then the suggested artifact or script.
