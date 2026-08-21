# dsh-sales plan

## Current scope

- One focused motion: B2B or high-ticket opportunities after an opportunity/product/commercial handoff.
- Stage-based pipeline analysis with explicit definitions, conversion rates and evidence gaps.
- Deal qualification and next-step planning using a minimum evidence set.
- Offer and commercial-readiness review without inventing price or margin facts.
- Weighted pipeline forecast with visible probability assumptions and close-date caveats.
- Sales playbook and deal-review artifact generation with preview-before-write.
- Handoff references for `dsh-idea`, `dsh-product`, `dsh-business` and `dsh-growth`, without duplicating their core tools.
- Consume and validate the versioned product-to-sales handoff before qualification or commercial progression.

## Deliberate boundaries

- No CRM writes, lead imports, outbound messages, call recording, calendar actions or proposal submission.
- No external opportunity discovery or interview research; use `dsh-idea`.
- No product discovery, POC, MVP, PMF or product delivery; use `dsh-product`.
- No price architecture, channel price book or profitability calculation; use `dsh-business`.
- No CAC/LTV, retention cohorts, revenue bridge or growth experiment system; use `dsh-growth`.
- No pricing decision without an approved price floor, cost basis or `dsh-business` handoff.
- No claim of deal quality from a completed framework; evidence and decision rules remain visible.
- No automatic customer contact, discount approval or commercial commitment.
- No replacement for `dsh-growth` funnel and revenue analytics; this plugin owns the sales operating layer.

## Next iterations

1. Add adapters for user-approved CRM exports while preserving field lineage and redaction.
2. Add win/loss and stage-aging cohort analysis across segments, owners and sources.
3. Add win/loss feedback fields that can be handed back to `dsh-product` and `dsh-idea` without importing CRM state.
4. Add commercial approval matrices that can be reviewed by `dsh-business`.
