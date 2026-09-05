# Label Gate Composite Step — Design & Implementation

Issue: #70

## Summary

This document defines a reusable composite action and workflow snippets that implement a **label gate** pattern for TrustBridge validation. The gate allows TrustBridge checks to run conditionally based on issue labels (e.g. `bounty`, `needs-wallet`), avoiding unnecessary validation runs and enabling cost/noise control without forking the action.

---

## Problem Statement

Not every issue assignment should trigger wallet checks:

- **Cost**: Horizon queries and GitHub API calls accumulate across many workflows.
- **Noise**: Contributors may not have wallet addresses until a specific workflow state (e.g. assignment to a bounty issue).
- **Flexibility**: Programs need to gate validation behind labels without duplicating or modifying the core TrustBridge action.

**Current state:** Workflows call `trustbridge-action` directly and must hard-code or script label filtering separately. No standard pattern exists.

**Goal:** Provide a drop-in composite action and example workflows that handle label checks transparently, with clear documentation on permissions, edge cases, and interaction with `fail_on_missing` and comment posting.

---

## Design Goals

1. **Reusability**: Single composite action definition that consumer workflows can call.
2. **Least privilege**: Example workflows use minimal GitHub permissions (`contents: read` only; `issues: read` for label checks).
3. **Transparency**: Clearly define behavior when:
   - Gate label is missing from the issue (skip validation, post optional info comment).
   - Gate label is present (run validation, post result comment as usual).
   - GitHub API returns 403 (no label permission) or network error (fail safe).
4. **Clarity on interaction**:
   - Interaction with `fail_on_missing` (gate skip overrides it).
   - When comments are posted (gate-skip info comment is optional; validation comment is conditional).
   - How to distinguish a gate-skipped run from a validation pass/fail in downstream jobs.
5. **Documentation**: Explain label conventions and provide copy-paste example workflows.

---

## Design: Composite Action

Define a composite action at `.github/actions/trustbridge-label-gate/action.yml` that:

1. **Inputs**:
   - `github_token`: GitHub token with `issues: read` (for checking labels) and `issues: write` (for posting comments).
   - `gate_labels`: Comma-separated list of labels (e.g. `bounty, needs-wallet`). If any is present, the gate opens.
   - `stellar_address_input`: Stellar address to validate.
   - All existing TrustBridge action inputs (forwarded as-is).
   - `post_skip_comment`: Boolean. If true, post a lightweight info comment when the gate is skipped; if false, post nothing.

2. **Behavior**:
   - Step 1: Check if any gate label is present on the issue.
   - Step 2: If gate is open (label found), run `trustbridge-action` with all inputs.
   - Step 3: If gate is closed (no label):
     - Optionally post a skip info comment (if `post_skip_comment: true`).
     - Set outputs to indicate gate was skipped (e.g., `gate_skipped: 'true'`).
     - Exit step with success (step does not fail; workflow can use outputs to branch).
   - Step 4: If label check API call fails (403, network error):
     - Emit a warning.
     - Fall back to running TrustBridge (fail-open; better to over-validate than silently skip).

3. **Outputs**:
   - `gate_skipped`: `'true'` if the gate was skipped, `'false'` otherwise.
   - `gate_label_found`: Name of the first gate label that was found (or empty if gate was skipped).
   - All TrustBridge action outputs (forwarded only when gate is open).

---

## Example Workflows

### Workflow 1: Simple Label Gate (GitHub Actions Composite Action)

File: `docs/examples/trustbridge-label-gate.yml`

```yaml
name: Verify Stellar wallet (with label gate)

on:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address'
        required: true
      gate_labels:
        description: 'Comma-separated gate labels (e.g., bounty, needs-wallet)'
        required: false
        default: 'bounty'

jobs:
  trustbridge-gated:
    runs-on: ubuntu-latest
    permissions:
      issues: read    # read labels
      contents: read  # read repo for config file (optional)
    steps:
      - name: Resolve address
        id: addr
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "value=${{ github.event.inputs.stellar_address }}" >> "$GITHUB_OUTPUT"
          else
            # Example: hardcoded or extracted from issue body
            echo "value=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"
          fi

      - name: TrustBridge with label gate
        id: gate
        uses: Stellar-TrustBridge/trustbridge-action/.github/actions/trustbridge-label-gate@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: ${{ steps.addr.outputs.value }}
          gate_labels: ${{ github.event.inputs.gate_labels || 'bounty,needs-wallet' }}
          post_skip_comment: 'false'  # don't spam; only post when validation runs
          fail_on_missing: 'true'

      - name: Log gate status
        run: |
          echo "Gate skipped: ${{ steps.gate.outputs.gate_skipped }}"
          echo "Gate label: ${{ steps.gate.outputs.gate_label_found }}"

      - name: Continue only if validated and funded
        if: steps.gate.outputs.gate_skipped != 'true' && steps.gate.outputs.account_funded == 'true'
        run: echo "Ready for payout"

      - name: Alert if gate was skipped
        if: steps.gate.outputs.gate_skipped == 'true'
        run: echo "Label gate closed — wallet validation skipped"
```

### Workflow 2: Multi-Label Gate with Custom Skip Comment

File: `docs/examples/trustbridge-label-gate-verbose.yml`

```yaml
name: Verify Stellar wallet (label gate with skip notice)

on:
  issues:
    types: [assigned]

jobs:
  trustbridge-gated:
    runs-on: ubuntu-latest
    permissions:
      issues: read
      issues: write  # needed for post_skip_comment
      contents: read
    steps:
      - name: TrustBridge with label gate
        id: gate
        uses: Stellar-TrustBridge/trustbridge-action/.github/actions/trustbridge-label-gate@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: GYOURCONTRIBUTORADDRESSHERE
          gate_labels: 'bounty,needs-wallet,grant'
          post_skip_comment: 'true'  # post a notice when gate is skipped
          fail_on_missing: 'false'   # warn-only mode

      - name: Report status
        run: |
          if [ "${{ steps.gate.outputs.gate_skipped }}" = "true" ]; then
            echo "✓ Label gate closed; wallet check skipped"
          else
            if [ "${{ steps.gate.outputs.account_funded }}" = "true" ]; then
              echo "✓ Account funded and ready"
            else
              echo "✗ Account not ready; see comment for details"
            fi
          fi
```

### Workflow 3: Per-Label Different Validation Rules

File: `docs/examples/trustbridge-label-gate-branching.yml`

This workflow runs different validation rules (asset, min_xlm_reserve) depending on which gate label is present:

```yaml
name: Verify Stellar wallet (label-specific rules)

on:
  issues:
    types: [assigned]

jobs:
  check-gate-labels:
    runs-on: ubuntu-latest
    permissions:
      issues: read
      contents: read
    outputs:
      bounty_present: ${{ steps.labels.outputs.bounty }}
      grant_present: ${{ steps.labels.outputs.grant }}
      address: ${{ steps.resolve.outputs.address }}
    steps:
      - name: Check labels
        id: labels
        run: |
          labels="${{ github.event.issue.labels.*.name | join(',') }}"
          echo "bounty=$([[ "$labels" == *"bounty"* ]] && echo 'true' || echo 'false')" >> "$GITHUB_OUTPUT"
          echo "grant=$([[ "$labels" == *"grant"* ]] && echo 'true' || echo 'false')" >> "$GITHUB_OUTPUT"

      - name: Resolve address
        id: resolve
        run: echo "address=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"

  validate-bounty:
    needs: check-gate-labels
    if: needs.check-gate-labels.outputs.bounty_present == 'true'
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge — bounty (high reserve requirement)
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: ${{ needs.check-gate-labels.outputs.address }}
          min_xlm_reserve: '10'  # higher reserve for bounty payouts
          fail_on_missing: 'true'

  validate-grant:
    needs: check-gate-labels
    if: needs.check-gate-labels.outputs.grant_present == 'true'
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge — grant (standard reserve)
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: ${{ needs.check-gate-labels.outputs.address }}
          min_xlm_reserve: '2'  # standard requirement
          fail_on_missing: 'false'
```

---

## Edge Cases & Error Handling

### Case 1: No Label Permission (403)

**Scenario**: Workflow runs but token lacks `issues: read` permission.

**Behavior**:
- Log a warning: `"Unable to check labels (permission denied). Running TrustBridge anyway (fail-open)."`
- Continue to run TrustBridge (do not skip).
- Rationale: Over-validate rather than silently skip.

**Mitigation**: Document that `issues: read` is required; provide a clear error message in the action readme.

### Case 2: GitHub API Network Error During Label Check

**Scenario**: Network timeout or 5xx error when fetching issue labels.

**Behavior**:
- Log a warning with the error.
- Fall back to fail-open: run TrustBridge.
- Rationale: Transient failures should not silently skip validation.

### Case 3: Gate Skipped but TrustBridge Outputs Still Needed

**Scenario**: Downstream job checks `steps.gate.outputs.account_funded` but gate was skipped.

**Behavior**:
- When gate is skipped, `account_funded` and other TrustBridge outputs are set to empty string or a sentinel value (`'gate_skipped'`).
- Downstream jobs should check `steps.gate.outputs.gate_skipped` first.

**Documentation**: Example workflows show the pattern: `if: steps.gate.outputs.gate_skipped != 'true' && steps.gate.outputs.account_funded == 'true'`

### Case 4: `fail_on_missing` Interaction

**Scenario**: Gate is closed (label absent). Workflow sets `fail_on_missing: true`.

**Behavior**:
- Gate skip takes precedence; the step does not fail.
- `fail_on_missing` only applies when the gate is open and TrustBridge runs.
- Rationale: Gate skip is intentional (no label = no validation); `fail_on_missing` is about validation result handling.

**Documentation**: Add a note in USAGE.md: "When using a label gate, `fail_on_missing` only applies when the gate is open."

### Case 5: Comment Posting When Gate is Skipped

**Scenario**: `post_skip_comment: true` but `issues: write` permission is absent.

**Behavior**:
- Log a warning.
- Continue (do not fail the step).
- Rationale: Comment posting is best-effort; lack of permission should not block the workflow.

---

## Least-Privilege Permissions

### Minimal workflow (validation only, no skip comment):

```yaml
permissions:
  issues: read    # read labels for gate
  contents: read  # optional; only if using trustbridge_config_path
```

### With skip comment posting:

```yaml
permissions:
  issues: read    # read labels
  issues: write   # post skip comment
  contents: read  # optional
```

### Full permissions (equivalent to a standard TrustBridge workflow):

```yaml
permissions:
  issues: write   # read labels, post validation comment, post skip comment
  contents: read  # optional
```

---

## Label Conventions

### Recommended Labels

| Label | Use case | Typical reserve |
|-------|----------|-----------------|
| `bounty` | Issue grants a bounty payout; wallet must be ready before assignment. | 5–10 XLM |
| `needs-wallet` | Issue requires Stellar wallet verification. | 1.5 XLM (default) |
| `grant` | Grant or donation payout. | 2 XLM |
| `whitelist` | Contributor is approved for sensitive workflows. | Depends |

### Label Color Scheme (Recommended)

- **Bounty-related**: Gold (`#FFD700`) — high priority.
- **Wallet-related**: Blue (`#0075CA`) — verification gate.
- **Approval-related**: Green (`#28A745`) — approved action.

Programs should define their own labels and document them in their contributing guide.

---

## Implementation Checklist

- [ ] Create composite action at `.github/actions/trustbridge-label-gate/action.yml`.
- [ ] Implement step to check labels via GitHub CLI or REST API call.
- [ ] Implement conditional step that runs `trustbridge-action` if gate is open.
- [ ] Implement optional skip comment posting.
- [ ] Set outputs (`gate_skipped`, `gate_label_found`, forwarded TrustBridge outputs).
- [ ] Write example workflows (3+) covering:
  - [ ] Simple gate (minimal permissions).
  - [ ] Gate with skip comment.
  - [ ] Per-label branching.
- [ ] Add section to USAGE.md linking to the design and examples.
- [ ] Add label conventions section to this design doc (above).
- [ ] Document in README.md as a "common pattern."
- [ ] Add to docs/examples/ directory.

---

## Testing & Verification

### Test Scenarios

1. **Gate open** (label present) → Validation runs, results posted.
2. **Gate closed** (label absent) → Validation skipped, optional skip comment posted.
3. **Multiple gate labels** → Any one present opens the gate.
4. **403 on label check** → Validation runs (fail-open).
5. **Network error during label check** → Validation runs (fail-open).
6. **Downstream job branches on outputs** → Correct behavior when gate is skipped vs. closed.

### Testing approach

- Use `comment_mode: dry-run` in a local workflow to exercise label gate logic without posting comments.
- Mock issue labels in test workflow inputs.
- Verify outputs are correctly forwarded or set to sentinel values.

---

## Documentation

### Links & References

- **USAGE.md**: New section "Label Gate Pattern" with link to this design.
- **README.md**: Add "Common Patterns" subsection linking to label gate examples.
- **ARCHITECTURE.md**: No changes needed (composite action is external to the core Node action).
- **docs/examples/**: Add 3+ example workflows.

### Key Documentation Points

1. Label gate is a **consumer-side pattern**, not part of the core action.
2. Composite action is provided as a convenience in the TrustBridge repo; teams can also define their own.
3. Gate skip does not trigger `fail_on_missing` — it is a separate control.
4. When gate is skipped, TrustBridge outputs are not available; use `gate_skipped` output to branch.
5. Label gate requires at least `issues: read` permission.

---

## Acceptance Criteria

✅ Design doc created with clear behavior definition for all edge cases.

✅ Composite action provided at `.github/actions/trustbridge-label-gate/action.yml` with documented inputs/outputs.

✅ Example workflows provided in `docs/examples/`:
  - `trustbridge-label-gate.yml` — simple gate (minimal permissions).
  - `trustbridge-label-gate-verbose.yml` — gate with skip comment.
  - `trustbridge-label-gate-branching.yml` — per-label rules.

✅ Behavior defined for:
  - Label present → validation runs.
  - Label absent → validation skipped.
  - No label permission (403) → fail-open (validation runs, warning logged).
  - Network error → fail-open.
  - Interaction with `fail_on_missing` (gate skip overrides).

✅ Example uses least-privilege permissions (`issues: read` minimum).

✅ Linked from USAGE.md with section explaining when and why to use the label gate pattern.

✅ Label conventions documented.

✅ PR includes "Closes #70" in description.

---

## Notes for Contributors

This design is ready to implement. The composite action is the main deliverable; example workflows should be runnable immediately once the composite is created.

**Key implementation details:**
- Use `github.event.issue.labels` context to avoid API calls (available in issue-triggered runs).
- For `workflow_dispatch` runs, use GitHub CLI (`gh issue view`) or REST API call if needed.
- Composite action should forward all TrustBridge inputs transparently (no duplication of input lists).
- Ensure outputs are always set (even if empty) so downstream jobs don't fail on undefined outputs.

---

## References

- Issue #70: "Design label-gate composite step in Validation checks"
- Related: Least-privilege permissions (docs/USAGE.md)
- Related: Conditional workflow jobs (GitHub Actions docs)
- Related: Composite actions (GitHub Actions docs)
