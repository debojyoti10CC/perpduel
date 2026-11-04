import { useEffect, useState } from 'react';

// CoinGecko API IDs identify the assets without ambiguous ticker lookups.
// https://docs.coingecko.com/demo/reference/simple-price
const COIN_IDS = { MON: 'monad', SOL: 'solana', ETH: 'ethereum' };
const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price?ids=monad,solana,ethereum&vs_currencies=usd&include_last_updated_at=true';
const REFRESH_MS = 60_000;
const MAX_QUOTE_AGE_MS = 5 * 60_000;
let cache = null;
let inFlight = null;

function fetchQuotes() {
  if (inFlight) return inFlight;
  if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) return Promise.resolve(cache);

  inFlight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(ENDPOINT, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Price provider returned ${response.status}.`);
      const data = await response.json();
      const fetchedAt = Date.now();
      const quotes = {};
      for (const [asset, id] of Object.entries(COIN_IDS)) {
        const price = data?.[id]?.usd;
        const timestamp = data?.[id]?.last_updated_at;
        const updatedAt = typeof timestamp === 'number' ? timestamp * 1000 : NaN;
        if (typeof price === 'number' && Number.isFinite(price) && price > 0 &&
            Number.isFinite(updatedAt) && updatedAt > 0 &&
            fetchedAt - updatedAt <= MAX_QUOTE_AGE_MS && updatedAt <= fetchedAt + 60_000) {
          quotes[asset] = { price, updatedAt };
        }
      }
      cache = { quotes, fetchedAt, error: null };
    } catch (error) {
      // Clear obsolete prices instead of presenting a failed refresh as live data.
      cache = {
        quotes: {},
        fetchedAt: Date.now(),
        error: error?.name === 'AbortError' ? 'Live USD rate timed out.' : 'Live USD rate unavailable.',
      };
    } finally {
      clearTimeout(timeout);
      inFlight = null;
    }
    return cache;
  })();
  return inFlight;
}

/** USD unit price; updatedAt is the provider timestamp in Unix milliseconds. */
export default function useTokenUsd(asset) {
  const [snapshot, setSnapshot] = useState(() => cache);
  const [loading, setLoading] = useState(() => !cache || Date.now() - cache.fetchedAt >= REFRESH_MS);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      setLoading(true);
      const next = await fetchQuotes();
      if (active) {
        setSnapshot(next);
        setLoading(false);
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
      // The shared request may serve another mounted instance or StrictMode setup.
    };
  }, []);

  const supported = Object.hasOwn(COIN_IDS, asset);
  const quote = snapshot?.quotes[asset];
  const fresh = quote && Date.now() - quote.updatedAt <= MAX_QUOTE_AGE_MS;
  return {
    price: supported && fresh ? quote.price : null,
    loading: supported && loading,
    error: !supported ? 'Unsupported asset.' : snapshot?.error || (!fresh && !loading ? 'Live USD rate unavailable.' : null),
    updatedAt: supported && fresh ? quote.updatedAt : null,
  };
}
