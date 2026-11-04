# PERPDUEL

PERPDUEL is a React trading duel lobby and two-player paper-trading arena. The lobby follows the spacing, type, search/deposit control, and token list feel of [tokens.xyz](https://tokens.xyz/), with PERPDUEL branding, the supplied two-player join dialog, a dark purple terminal background, and the original trader rows.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```powershell
npm install
$env:PORT = '5173'
$env:HOST = '127.0.0.1'
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The server connects to Hyperliquid market data and runs the game's separate local EVM ledger. For a production bundle, run `npm run build`, then start the Node server with `npm start`.

## Lobby and room flow

- The lobby keeps the five original trader rows and their avatars, abbreviated addresses, sample win rates, token amounts, sides, and round lengths. They are explicitly marked **PREVIEW**; they are presentation examples, not active opponents or funded rooms.
- Trader and player avatars are local, deterministic 5×5 Blockies-style identicons derived from wallet addresses or stable preview IDs. They are decorative and do not prove wallet ownership.
- **Join duel** opens the two-player dialog. The room ID input accepts a real six-character invite code, loads the room, shows its creator and stake, and then lets the player join. **Join room** on the lobby opens the same dialog. The **PLAY BOT** button starts a no-stake practice round in a separate tab.
- Public rooms created by the app appear alongside the original preview rows after the host's test MON deposit has been confirmed. Invite-only rooms can be joined by their code.
- Creating a staked room requires a connected wallet on Monad testnet. Both players deposit the exact same native test MON amount directly into the room escrow. The host chooses a one-to-five-minute round; the shared timer starts only after both deposits and both ready actions are confirmed.
- The browser wallet signs a one-time login message. Room deposits and escrow claims are separate, explicit wallet transactions; there is no website balance or automatic transfer. Room owners may cancel an unjoined room for a refund, and expired rooms have an on-chain refund path.

## Monad testnet escrow setup

The room escrow is a native-MON Solidity contract, restricted to Monad testnet (chain ID 10143). It holds equal stakes, credits the winner after a signed result, refunds draws, and allows a timeout refund. Withdrawals use a pull-payment flow. Contract source is in `contracts/RoomEscrow.sol`; compile its checked-in deploy artifact with:

```powershell
npm run compile:escrow
```

The first operator can open **Testnet setup** in the app, connect a wallet on chain 10143, and approve deploying/registering the escrow. The app verifies the confirmed deployment and contract bytecode before enabling rooms. The backend creates a result-signing key on first start under `data/escrow-result-signer.json`; keep the `data/` directory backed up and private so the deployed contract continues to recognize results after restarts. Alternatively, configure `RESULT_SIGNER_PRIVATE_KEY` and `ESCROW_CONTRACT_ADDRESS` on the server. Never expose these values through `VITE_*` variables.

No testnet contract has been deployed by this project run. Staked rooms stay disabled until an operator approves escrow deployment in the local app or configures a matching contract. Monad testnet tokens are for testing and have no cash value.

## Trading and settlement boundary

Trading is paper trading: each player starts with $1,000 simulated equity and trades BTC, ETH, SOL, XRP, DOGE, and AVAX against live Hyperliquid reference prices. The app does not send exchange orders. The room-stake escrow is a separate contract from the game's optional on-chain ledger. Settlement uses a server-owned result signer, so the escrow relies on this server to report the match result correctly; this build is not trustless.

## Commands

```powershell
npm run build
npm run compile:escrow
npm run compile:contract
npm start
```

The app uses Inter Variable locally and includes the supplied React Bits FaultyTerminal component. License and attribution details are in `THIRD_PARTY_NOTICES.md`, `THIRD-PARTY-NOTICES.md`, and `REACT_BITS_LICENSE.md`.
