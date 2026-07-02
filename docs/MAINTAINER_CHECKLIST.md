# Maintainer Checklist

Use this checklist before enabling TrustBridge in a contributor workflow.

## Required setup

- Confirm the workflow grants `issues: write` so comments can be posted.
- Pass `github_token: ${{ secrets.GITHUB_TOKEN }}` unless a scoped token is required.
- Provide a real `stellar_address_input` from issue metadata, a form field, or a dispatch input.
- Keep `fail_on_missing` set to `true` for protected assignment and payout gates.

## Before rollout

- Test with one funded Stellar account that already has the expected trustline.
- Test with one unfunded G-address to confirm remediation text is clear.
- Verify maintainers understand that Horizon outages are treated as failed checks.
