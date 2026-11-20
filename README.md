# Gift agent

A voice agent that buys real gift cards with USDC and emails them to your friends. You talk to it, it finds the card, tells you the exact price, and pays on Base over [x402](https://x402.org) only after you say "yes".

> "Send Sam a $5 Starbucks card, tell them happy birthday."
> "A $5 Starbucks USA card comes to 5.03 USDC. Should I buy it and email it to Sam?"
> "Yes."

Every API call the agent makes to Bitrefill is itself paid per request in USDC, and every limit that protects your money is enforced in code, not in the prompt.

Built for the University Blockchain Conference 2026, Agentic Payments and AI track (plus the ElevenLabs bounty).

## Proof it works

A real $5 Starbucks gift card bought by this code on Base mainnet: [payment on Basescan](https://basescan.org/tx/0x132fc3b5f2b2fcc76ab1962ad842ec5ad46d2020e4c853079e13c529d0199e4c). The card was delivered about 5 seconds after payment.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (one page)"]
    Mic["Mic, hands-free"] --> UI
    UI["Conversation, price slip with Yes/No,<br/>budget bar, wallet balance, orders,<br/>paid API calls, contacts"]
  end

  UI -- audio --> STT["/api/stt"] --> EL1["ElevenLabs<br/>speech-to-text"]
  UI -- text --> Chat["/api/chat"]
  Chat --> Agent
  UI -- reply text --> TTS["/api/tts"] --> EL2["ElevenLabs<br/>text-to-speech"]
  UI --> Budget["/api/budget<br/>(human only)"] --> Session
  UI --> Wallet["/api/wallet"] --> Base

  subgraph Server["Next.js server"]
    Agent["Agent loop<br/>Claude Opus 5.5 + tools"] --> Session["Session: budget, quotes,<br/>confirmation, payments"]
    Agent --> Client["x402 client<br/>(caps before signing)"]
    Agent --> Contacts["contacts.json"]
  end

  Client -- "HTTP 402, then signed USDC payment" --> Bitrefill["Bitrefill x402 API"]
  Client -. "EIP-3009 USDC transfer" .-> Base[("Base mainnet<br/>USDC")]
  Agent -- send_gift --> Resend["Resend email"]
```

| Piece | File |
|---|---|
| x402 client, caps, logging | [src/bitrefill.ts](src/bitrefill.ts) |
| Agent loop, tools, session, all checks | [src/agent.ts](src/agent.ts) |
| Contacts | [src/contacts.ts](src/contacts.ts) |
| Page | [app/page.tsx](app/page.tsx) |
| API routes | [app/api/](app/api/) |
| Free self-check (12 checks) | [src/check.ts](src/check.ts) |

## The agent's decision loop

Each user turn runs a tool loop on Claude (Messages API, up to 6 model calls). The model chooses the tools; the code decides whether money moves.

```mermaid
sequenceDiagram
  actor U as You
  participant P as Page
  participant A as Agent (Claude)
  participant C as Code checks
  participant B as Bitrefill (x402)
  participant Ch as Base

  U->>P: "Send Sam a $5 Starbucks card"
  P->>A: transcript
  A->>B: search_products (pays $0.002)
  A->>B: get_quote: product details ($0.001), create invoice ($0.002)
  C-->>C: package exists? price within session limit and per-card max?
  A->>P: "5.03 USDC. Buy it and email it to Sam?"
  P->>U: speaks it, shows price slip from server state
  U->>P: "Yes"
  P->>C: only an immediate, plain yes marks the quote confirmed
  A->>C: purchase(invoice)
  C-->>C: confirmed? not expired? within limit? wallet holds it (chain read)?
  C->>B: pay invoice, x402 capped at the exact price
  B->>Ch: USDC transfer settles
  A->>B: check delivery ($0.001 per poll)
  A->>C: send_gift(Sam)
  C-->>C: address said by you or saved as a contact?
  A->>P: "Done, I emailed it to Sam."
```

Tools: `search_products`, `get_quote`, `purchase`, `check_order`, `check_funds`, `send_gift`.

The system prompt keeps the agent on gift cards and tells it to state product and price before asking. Nothing that protects money relies on the prompt. If the model calls `purchase` without a yes, the code refuses.

## Safety limits

All enforced in code. `npm run check` tests them without moving funds.

| Limit | Default | How it's enforced |
|---|---|---|
| Human confirmation | Every purchase | `get_quote` marks the invoice pending. Only if your very next message is a plain affirmative ("yes", "yes please", "go ahead") does it become confirmed. "Yes but make it $10", a late yes or "I pre-approve" don't count. One yes pays once. |
| Per-card max | $10, editable up to $15 | You set it with **Edit limits**; the agent has no tool to change it. Above it sits a $15 hard ceiling in code, also enforced by the x402 client's spend control before anything is signed. |
| Exact-price payment | Invoice price | The pay call's x402 cap equals the quoted price, so a 402 asking for more is refused before signing. |
| Session spend limit | $15 | Set by you with **Edit limits** ($0 to $100). The agent has no tool to change it. Budget is reserved before paying, so a failed payment can't be retried past it. |
| Wallet balance | On-chain | `purchase` reads the wallet's USDC on Base and refuses if it can't cover the price. |
| Per-request fee cap | $0.05 | Every other x402 call is capped far above Bitrefill's $0.001 to $0.002 fees and far below anything harmful. |
| Host and network allowlist | api.bitrefill.com, Base | Off-host URLs (including from Bitrefill's `next_step`) are refused; the x402 client only registers Base (`eip155:8453`). |
| Recipient allowlist | Your words and contacts | `send_gift` only emails an address you said or typed ("alex at gmail dot com" counts) or saved under Contacts. |
| Exact package | Must exist | Asking for a value that doesn't exist is refused instead of quietly buying another. |
| Quote expiry | 30 min | Expired quotes can't be paid. |
| One turn at a time | Always | The server rejects a second request while one runs, so double-clicking "yes" can't race. |
| Claude spend cap | $1 per session | Estimated from token usage; the agent stops calling Claude after it. Also: 300-character messages, 6 model calls per turn, 2,048 output tokens. |
| Secrets in logs | Redacted | Every request and response is logged to `logs/`, with redemption codes and tokens redacted. |
| Test mode | `DRY_RUN=1` | Every check runs; the card itself is never paid (fees only). |

## How the x402 + Bitrefill flow works

1. The agent calls a Bitrefill route such as `GET /x402/gift-cards/search`.
2. Bitrefill answers **HTTP 402** with payment requirements: amount, USDC on Base, payee.
3. The official `@x402/fetch` client checks the amount against our cap, signs an **EIP-3009** USDC transfer authorization with the server wallet, and retries with the payment header.
4. Bitrefill settles the transfer on Base and returns the data, plus a `payment-response` header with the transaction hash.
5. A purchase is the same pattern: `POST /x402/invoice/create` returns an invoice and price, and `POST /x402/invoice/pay` is a 402 for exactly that price.
6. The agent follows Bitrefill's `next_step` URLs between steps rather than hard-coding the flow, with its own parameters and the host allowlist applied.

| Route | Fee |
|---|---|
| search | $0.002 |
| product details | $0.001 |
| create invoice | $0.002 |
| order status | $0.001 |
| pay invoice | the card price |

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env   # then fill it in
npm run check          # free self-check, moves no funds
DRY_RUN=1 npm run dev  # http://localhost:3000, test mode
```

`.env` needs:

- `AGENT_PRIVATE_KEY`: a **burner** wallet holding a little USDC on Base (about $20).
- `ANTHROPIC_API_KEY`: Claude API key.
- `ELEVENLABS_API_KEY`: with Speech to Text and Text to Speech permissions.
- `RESEND_API_KEY`: for gift emails. Without a verified domain, Resend only delivers to your own Resend account email.

Optional settings are documented in [.env.example](.env.example). For real purchases, run without `DRY_RUN` (`npm run build && npm start`).

Other commands:

- `npm run chat`: the agent in the terminal.
- `npm run spike -- starbucks 5 US --dry`: the raw purchase flow, stopping before payment.

Run it on your own machine or a long-running server (Railway, Render, Fly.io). Serverless hosts don't fit, because the session lives in memory and a purchase can take up to 40 seconds.

## Known limits and what's next

- **No auth.** Anyone who can reach the page uses one shared session and wallet. Next: sign-in and per-user budgets in a database.
- **The private key sits on the server.** The code caps are only as strong as the server. Next: a smart wallet with on-chain spend permissions, so the limits hold even if the server is compromised.
- **Browsing costs fees.** Next: Bitrefill's SIWX sign-in, which makes search, quotes and status free and leaves only the card payment on x402.
- **Failure handling.** A payment that fails before signing still uses up its budget reservation (the safe direction). Paid-but-undelivered orders need a manual follow-up with Bitrefill.
- **Gift email needs a verified domain** to reach anyone other than the Resend account owner.
