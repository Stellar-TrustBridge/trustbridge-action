# Usage

This guide covers installing and running the TrustBridge action, including
configuration for GitHub Enterprise Server (GHES) deployments.

## Quick start

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    network: testnet
    secret-key: ${{ secrets.STELLAR_SECRET_KEY }}
```

## Configuration

| Input | Description | Default |
| --- | --- | --- |
| `network` | Stellar network to target (`testnet`, `mainnet`, or a custom passphrase) | `testnet` |
| `horizon-url` | Horizon endpoint to use | network default |
| `friendbot-url` | Friendbot endpoint used to fund test accounts | network default |
| `secret-key` | Stellar secret key used to sign transactions | — |

## GHES deployments

When running on GitHub Enterprise Server, the runner must be able to reach the
Stellar services used by this action. If your GHES instance sits behind a
restrictive firewall or proxy, allow egress to the hosts and ports listed in
[GHES_COMPATIBILITY.md](./GHES_COMPATIBILITY.md) before enabling the action.

At minimum, GHES operators typically need egress to:

- **Horizon** — `horizon.stellar.org:443` (mainnet) or
  `horizon-testnet.stellar.org:443` (testnet)
- **Friendbot** — `friendbot.stellar.org:443` (testnet only)
- **Federation / SEP endpoints** — the federation server host configured for
  your assets, on port `443`

If the action fails with connection timeouts, DNS resolution errors, or TLS
handshake failures, the cause is usually a missing egress rule. See
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for symptom-to-cause guidance.

> Never commit secret keys, tokens, or credentials to your workflow files.
> Always reference them through GitHub Actions secrets.

## Custom networks

For custom or private Stellar networks, set `horizon-url` and `friendbot-url`
explicitly and ensure the corresponding hosts are reachable from the runner.
