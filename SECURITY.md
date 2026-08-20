# Security

`dsh-sales` is local-first. It reads business notes and user-supplied sales datasets under the configured root and returns aggregates, evidence summaries and planning artifacts.

- Paths outside `defaultRoot` are rejected.
- File writes require a preview call followed by explicit `confirm: true`.
- Writes use an optional expected version guard when the host file system exposes one.
- Raw customer rows are not returned in aggregate funnel, forecast or onboarding results.
- The plugin does not connect to CRM, email, phone, calendar, payment or advertising systems.
- The plugin never sends outreach, submits a proposal, accepts terms, approves a discount or commits a price.
- Missing evidence remains missing; it is not converted into a pass, zero or forecast certainty.
- Do not store passwords, access tokens, cookies, payment data or unnecessary personal contact details in artifacts.
