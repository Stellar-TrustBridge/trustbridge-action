# Asset decimal precision and balance parsing

How **trustbridge-action** handles Stellar balance strings, XLM stroops,
and safe numeric comparisons for release scripts and downstream CI.

Related docs: [Usage](USAGE.md) · [Error handling](ERROR_HANDLING.md) · [README](../README.md)

---

## Why balances are strings

Horizon returns every balance — native XLM and all credit assets — as a
**decimal string**, for example:

```json
{
  "asset_type": "native",
  "balance": "14.9999700"
}
```

The string representation always has exactly **7 decimal places** for XLM
(one stroop = 0.0000001 XLM). Credit-asset balances follow the same format.
Horizon never emits raw stroop integers or JavaScript `Number` values in the
account endpoint.

**Why strings?** Stellar amounts can be as large as 2^63−1 stroops
(≈ 922 trillion XLM). That exceeds IEEE 754 double-precision safe-integer
range (~9 × 10^15), so using JavaScript `number` for the raw stroop integer
would silently lose precision. By returning a decimal string, Horizon lets
consumers choose the right numeric type for their context.

---

## XLM precision: stroops vs decimal XLM

| Unit | Scale | Example |
|------|-------|---------|
| 1 XLM | 10,000,000 stroops | `"1.0000000"` |
| 1 stroop | 0.0000001 XLM | `"0.0000001"` |
| Typical reserve | 1–2 XLM | `"1.5000000"` |

The action always works in **decimal XLM** (7 d.p. string ↔ JavaScript
`number`). It never exposes raw stroop integers externally. The `xlm_balance`
output value is the raw string from Horizon (e.g. `"14.9999700"`), not a
stroop integer.

---

## How the action parses balances internally

`parseHorizonBalance` in `src/horizon.ts` converts the Horizon balance string
to a JavaScript `number`:

```ts
export function parseHorizonBalance(balance: string): number {
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

This is safe for the XLM reserve comparison because the values involved
(typically 1–20 XLM) are far below the 53-bit safe-integer boundary
(~9 × 10^15). For large credit-asset amounts the action only tests for the
**presence** of a trustline (binary yes/no) — it never does arithmetic on
credit-asset balances — so `parseHorizonBalance` is not called on those values.

---

## `min_xlm_reserve` parsing rules

The `min_xlm_reserve` input is validated by `parseMinXlmReserve` in
`src/checks.ts`:

1. The raw string is trimmed of leading/trailing whitespace.
2. It is converted with `Number()`.
3. The result must be a **finite, non-negative** number; otherwise the run
   fails immediately with a clear error message.
4. Acceptable forms: `"1.5"`, `"1.50"`, `"2"`, `"0"`, `"1.0000001"`.
5. Rejected: `""`, `"abc"`, `"-1"`, `"Infinity"`, `"NaN"`, `"1e308"`.

The comparison `actualXlm >= minXlmReserve` uses JavaScript `>=` on two
`number` values. For reserve amounts in the normal range (0–600 XLM) this is
exact to 7 decimal places and introduces no rounding error.

---

## The `xlm_balance` output

The `xlm_balance` action output is the **raw Horizon string** for the native
balance, e.g. `"14.9999700"`. When the account is not funded the value is
`"0"`; when Horizon is unreachable it is `"unknown"`.

```yaml
- id: bridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Use balance in downstream step
  run: echo "Balance is ${{ steps.bridge.outputs.xlm_balance }}"
```

---

## Safe parsing in consumer CI / release scripts

### ✅ Safe — use `parseFloat` for display or threshold checks up to ~10 trillion XLM

For typical amounts (< 10 million XLM) `parseFloat` is exact to 7 d.p. and
is the simplest correct choice:

```js
const balance = parseFloat(steps.bridge.outputs.xlm_balance);
if (balance >= 1.5) { /* safe */ }
```

### ✅ Safe — integer stroop arithmetic for payment amounts

Convert to stroops (integer) to avoid any floating-point concern:

```js
// 1 XLM = 10_000_000 stroops
function toStroops(xlmString) {
  // round is defensive; Horizon always gives exactly 7 d.p.
  return Math.round(parseFloat(xlmString) * 10_000_000);
}

const balance = toStroops("14.9999700"); // 149999700 — safe integer arithmetic
const threshold = toStroops("1.5");      // 15000000
if (balance >= threshold) { /* pass */ }
```

### ✅ Safe — BigInt stroop arithmetic for maximum precision

For auditable release automation where any rounding must be impossible:

```js
function toStropsBigInt(xlmString) {
  const [whole, frac = ''] = xlmString.split('.');
  const fracPadded = frac.padEnd(7, '0').slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

const balance   = toStropsBigInt("14.9999700"); // 149999700n
const threshold = toStropsBigInt("1.5000000");  // 15000000n
if (balance >= threshold) { /* pass */ }
```

### ❌ Unsafe — naive multiplication before rounding

```js
// DO NOT DO THIS — floating-point drift for large amounts
const stroops = parseFloat(balance) * 10_000_000; // may not be an integer
if (stroops > 15_000_000) { ... }                  // risky for exact equality checks
```

### ❌ Unsafe — treating `xlm_balance` as an integer

The `xlm_balance` output is never a stroop integer. Do not multiply by 10,000,000
and expect the result to be correct without first removing the decimal point.

---

## Credit-asset balance format

Credit-asset balances (e.g. USDC) follow the same 7-decimal-place string
format as native XLM. Since Issue #246 the action **exposes** the configured asset’s balance as `asset_balance` (and in the comment’s `### Balances` section alongside `xlm_balance`/`native_balance`) so you can distinguish “has USDC but no XLM” from the inverse:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    asset_code: USDC
    asset_issuer: GA5Z...
- run: |
    echo "Native: ${{ steps.bridge.outputs.native_balance }} XLM"
    echo "USDC: ${{ steps.bridge.outputs.asset_balance }} USDC"
    echo "Trustline: ${{ steps.bridge.outputs.trustline_exists }}"
```

- **Missing trustline** → `asset_balance` is `"0"` and the comment shows `— no trustline configured`.
- **Trustline with 0 balance** → `asset_balance` is `"0.0000000"` and the comment shows `` `0.0000000 USDC` `` (distinct from missing).
- **Horizon error** → `asset_balance` is `"unknown"` (same as `xlm_balance`).

The same safe-parsing rules (parseFloat for thresholds <10M, stroops/BigInt for payment math) apply to `asset_balance`. If your release script needs to inspect a credit-asset balance, use `asset_balance` directly — you no longer need to fetch from Horizon separately.

### Split display (Issue #246)

The comment now renders both balances:

```md
### Balances
- **Native XLM balance:** `10.0000000 XLM`
- **Minimum required (XLM reserve):** `1.5 XLM` (...)
- **USDC trustline balance:** `100.0000000 USDC` (limit `1000.0000000 USDC`)
```

This split is covered by snapshot tests (`__tests__/comment.test.ts`) and output tests (`__tests__/outputs.test.ts`). Rounding is never changed — Horizon strings are preserved verbatim (7 decimals).

---

## Notes for release scripts

- Always treat `xlm_balance` as a **string** until you have explicitly parsed
  it. Do not assume it is a `number` or integer.
- `"unknown"` is a valid value (Horizon unreachable). Guard against it:
  ```js
  const raw = process.env.XLM_BALANCE;
  if (raw === 'unknown' || raw === undefined) { throw new Error('balance unavailable'); }
  ```
- `"0"` means the account was not funded; it does not mean the account has
  exactly zero balance (a funded account with an exact zero native balance
  cannot exist on Stellar because the minimum reserve is 1 XLM).
- When comparing to `min_xlm_reserve`, use the same value the action used —
  read it from the action inputs or `.trustbridge.yml` rather than hard-coding
  it in the release script, so the two values stay in sync.

---

## Cross-references

- `src/horizon.ts` — `parseHorizonBalance`, `getNativeBalance`, `HorizonBalance` types
- `src/checks.ts` — `parseMinXlmReserve`, `buildReserveRequirement`, `formatXlmDeficit`
- [USAGE.md — Outputs in downstream jobs](USAGE.md#outputs-in-downstream-jobs)
- [ERROR_HANDLING.md — Validation failures (200 OK)](ERROR_HANDLING.md#validation-failures-200-ok)
- [Stellar documentation — Lumens](https://developers.stellar.org/docs/learn/fundamentals/lumens)
- [Horizon docs — Account balances](https://developers.stellar.org/docs/data/apis/horizon/resources/accounts)

---

[← Back to README](../README.md)
