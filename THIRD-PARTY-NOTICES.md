# Third-party notices

## Solana Foundation Tokens interface

Trading Duel's light interface adapts the layout, typography, color hierarchy, rounded panels, search, and market-table patterns of [solana-foundation/tokens](https://github.com/solana-foundation/tokens), pinned at revision `dc51f2f3220b99c0f4a47f31ee9c668b9be37fa0`. Source references include `apps/web/src/components/header.tsx`, `apps/web/src/components/home/token-table.tsx`, `apps/web/src/components/home/token-table-cells.tsx`, and the published design-system palette used by the web application. The source software is copyright (c) 2026 Solana Foundation, MIT licensed. The complete notice is included in `LICENSES/solana-foundation-tokens.txt`.

Locally served token identifiers adapted from the repository are documented in `public/token-icons/SOURCES.md`. Third-party token logos remain their owners' property and identify the corresponding assets only. No affiliation with or endorsement by Solana Foundation or those token projects is implied. The interface uses Inter through Google Fonts; no proprietary font binaries were copied.

## Liveline 0.0.7

Liveline is copyright (c) 2025-2026 Benji Taylor and is MIT licensed. Its license is included at `LICENSES/liveline.txt`. Trading Duel uses the chart library and small documented patches from Tokens.xyz' pinned implementation to render actual Hyperliquid mark observations over short time windows.

## Other dependencies

The package lock identifies the exact installed dependency tree. React, React DOM, Vite, TypeScript, tsx, ethers, Ganache, solc, ws, dotenv, Lucide React, and their transitive dependencies retain their respective copyright notices and licenses in `node_modules`. Docker builds install these dependencies with those license files intact.

Hyperliquid supplies market data through its public API. Trading Duel is an independent paper-trading game and is not affiliated with Hyperliquid or Liveline.
