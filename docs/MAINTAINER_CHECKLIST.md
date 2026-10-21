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

## Wave freeze labeling

Run these steps in order before a Drips Wave opens so every repository in the org freezes the same way:

1. **Label** — apply the Wave label (e.g. `wave`) plus the complexity/points labels to every eligible issue, and confirm `pass_label` / `fail_label` (or `ready_pass_label` / `ready_fail_label`) match the labels your [label gate](LABEL_GATE_DESIGN.md) filters on.
2. **Snooze** — set `snooze_window_minutes` so repeated re-runs during the Wave do not spam contributors; outputs still update while snoozed. See [USAGE](USAGE.md).
3. **Freeze** — stop merging changes to the TrustBridge workflow and pin the action to a release tag for the duration of the Wave. Remove or add Wave labels only through the checklist, never ad hoc.
4. **Unfreeze** — after the Wave closes, reset `snooze_window_minutes`, use `force_comment: true` once if contributors need a fresh comment, and remove the Wave label from unfinished issues.

Contributors who ask why their comment did not update during a Wave should be pointed to the [FAQ](FAQ.md).
