# Perp Ledger

Paste a wallet and see its perp stats across Hyperliquid, Arcus, RISEx, QFEX, Variational and Ondo, and work out what each point cost. There are no dependencies and no build step.

## Run it

```
npm start     # http://localhost:3000
npm test
```

Needs Node 20 or newer.

## Deploy

Push this folder to GitHub, import it into Vercel and deploy. Then add these under **Settings > Environment Variables** and redeploy:

| Name | Value |
| --- | --- |
| `SITE_PASSWORD` | The password for this site. Required, and the site stays locked without it. |
| `MY_WALLETS` | Your wallet addresses, separated by commas. |
| `ONDO_KEY_ID` | Ondo key ID, starting `ondoKeyId_`. |
| `ONDO_API_SECRET` | Ondo secret, starting `ondoApiSecret_`. |
| `QFEX_PUBLIC_KEY` | QFEX public key. |
| `QFEX_SECRET_KEY` | QFEX secret key. |

Use keys that can only view data. QFEX needs View orders, View positions and View balance. Never put keys in this code, GitHub or a chat.

Changing the password signs out every device. The page's code is public, but all RISEx, QFEX and Ondo data needs the password.

Server functions run in Frankfurt (`fra1`), because Ondo Perps isn't offered in the US.

## What each DEX provides

| DEX | Input | Source | Coverage |
| --- | --- | --- | --- |
| Hyperliquid | EVM address | Public API, called from the browser | Account value, positions, PnL, volume, 30-day funding. Trading record uses the latest 2,000 fills. |
| Arcus | EVM address | Public API, called from the browser | Same as above, for sub-account 0 and up to 5,000 fills. Wallets Arcus has not approved return 403 and show as Unknown. |
| RISEx | EVM address | `/api/risex` reads its public API | Account value, positions, PnL, volume, lifetime fees and a trading record from up to 5,000 fills. Funding is left out until its sign is confirmed. |
| Real Markets | Account ID, IOTA address or profile link | Public indexer, called from the browser | Account value, positions, realised PnL after fees and funding, volume, lifetime fees, 30-day funding and trades. No key needed. Reads up to 10,000 fills and funding payments per lookup. |
| QFEX | Your API key | `/api/private` | Equity, positions, PnL history, volume, fees and trades. Without a key it falls back to searching the top 100 by username. |
| Variational | CSV upload | Parsed in the browser | PnL, funding, fees and volume for the dates in the export (up to 365 days and 10,000 rows per file). |
| Ondo | Your API key | `/api/private` | Equity, positions, lifetime PnL and fees, volume and trades. |

A DEX with no data stays out of the totals, and each total says how many DEXs it covers.

## Average open interest

The average value of open positions over 7 days, 30 days and all time, with flat periods counted as zero. Every DEX is rebuilt the same way, by walking back from current positions through the fills, using fill prices. RISEx's own `market_exposure` isn't used, because it isn't comparable: it runs lower for wallets holding several positions and ignores flat time. A `~` means an estimate. QFEX's leaderboard mode has no OI.

## Points

The points panel lists DEXs with a live program: Arcus, RISEx, Variational and Ondo. Hyperliquid has no live program, and no program was found for QFEX or Real Markets, so all three are left out. Update `PROGRAMS` in `public/lib/points.js` when programs start or end.

No DEX publishes a wallet's points, so visitors copy theirs from each points page. RISEx has a points endpoint, but it needs the wallet owner's sign-in. Entries are saved in the visitor's browser for that wallet.

- **Cost per point:** loss after fees divided by points. A negative figure means the points were earned at a profit. If PnL is unknown, it falls back to fees divided by points and says so.
- **Arcus:** counts fills since Season 1 began on 1 October 2026, because its dashboard shows Season 1 points. PnL here is realized only and leaves out funding.
- **RISEx:** compares lifetime fees with total points.
- **Variational:** uses the dates in the CSVs, so export your full history. Older fees missing from the file make the cost per point look lower than it is.
- **Ondo:** uses lifetime fees and total PnL, which includes open positions and funding. Without a key, fees and PnL are typed in.

## Limits to know

- Hyperliquid and Arcus calls use each visitor's own IP, so visitors do not share a rate limit. Arcus allows 1,500 weight a minute per IP.
- RISEx calls share your server's IP, with a limit of 500 requests per 10 seconds. A lookup uses about 13 and is cached for a minute.
- PnL is net of fees in the trading record. PnL over time is what each DEX reports.
- Variational PnL includes funding. Check the sign of its `fee` rows against a real export: fees are shown as an absolute value.
- Private figures load only for wallets in `MY_WALLETS`, so looking up another wallet can't mix in your accounts.
- QFEX reads up to 10,000 fills per lookup, and past that its fees show Unknown. Ondo reads for up to 45 seconds, and if time runs out its all-time volume shows as "At least".
- QFEX's docs don't say whether `realised_pnl_change` is before fees. The code treats it as before fees.
