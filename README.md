# Perp Ledger

Paste a wallet and see its perp stats across Hyperliquid, Arcus, RISEx, QFEX, Variational and Ondo, and work out what each point cost. There are no dependencies and no build step.

## Run it

```
npm start     # http://localhost:3000
npm test
```

Needs Node 20 or newer.

## Deploy

**Vercel:** push this folder to GitHub, import it at vercel.com/new and deploy. No settings or keys are needed. `public/` is served as the site and `api/` becomes two server functions.

**Any Node host:** run `npm start`, with `PORT` set if needed.

The chart fonts load from Google Fonts. To avoid that, remove the two font links from `public/index.html`.

## What each DEX provides

| DEX | Input | Source | Coverage |
| --- | --- | --- | --- |
| Hyperliquid | EVM address | Public API, called from the browser | Account value, positions, PnL, volume, 30-day funding. Trading record uses the latest 2,000 fills. |
| Arcus | EVM address | Public API, called from the browser | Same as above, for sub-account 0 and up to 5,000 fills. Wallets Arcus has not approved return 403 and show as Unknown. |
| RISEx | EVM address | `/api/risex` reads its public API | Account value, positions, PnL, volume, lifetime fees and a trading record from up to 5,000 fills. Funding is left out until its sign is confirmed. |
| QFEX | Username | `/api/qfex` reads the public leaderboard | Top 100 only: PnL and equity. QFEX has no wallet lookup. |
| Variational | CSV upload | Parsed in the browser | PnL, funding, fees and volume for the dates in the export (up to 365 days and 10,000 rows per file). |
| Ondo | None | Not built | Account data needs the wallet owner to sign in. |

A DEX with no data stays out of the totals, and each total says how many DEXs it covers.

## Points

The points panel lists DEXs with a live program: Arcus, RISEx, Variational and Ondo. Hyperliquid has no live program and QFEX's docs don't mention one, so both are left out. Update `PROGRAMS` in `public/lib/points.js` when programs start or end.

No DEX publishes a wallet's points, so visitors copy theirs from each points page. RISEx has a points endpoint, but it needs the wallet owner's sign-in. Entries are saved in the visitor's browser for that wallet.

- **Cost per point:** loss after fees divided by points. A negative figure means the points were earned at a profit. If PnL is unknown, it falls back to fees divided by points and says so.
- **Arcus:** counts fills since Season 1 began on 1 October 2026, because its dashboard shows Season 1 points. PnL here is realized only and leaves out funding.
- **RISEx:** compares lifetime fees with total points.
- **Variational:** uses the dates in the CSVs, so export your full history. Older fees missing from the file make the cost per point look lower than it is.
- **Ondo:** needs fees and PnL typed in as well, and has no volume.

## Limits to know

- Hyperliquid and Arcus calls use each visitor's own IP, so visitors do not share a rate limit. Arcus allows 1,500 weight a minute per IP.
- RISEx calls share your server's IP, with a limit of 500 requests per 10 seconds. A lookup uses about 13 and is cached for a minute.
- PnL is net of fees in the trading record. PnL over time is what each DEX reports.
- Variational PnL includes funding. Check the sign of its `fee` rows against a real export: fees are shown as an absolute value.
- A QFEX username is whatever the visitor types, and nothing proves it belongs to the wallet.

## Adding Ondo

Ondo documents `GET /v1/perps/positions` and `GET /v1/perps/fills`, both behind Sign-In with Ethereum. To call them from the browser, ask builders@ondoperps.xyz to allowlist your domain, then add a `public/lib/ondo.js` loader that returns the same shape as `arcus.js`.
