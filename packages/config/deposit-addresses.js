/**
 * Canonical Infernet platform deposit addresses — the single source of truth.
 *
 * These are the wallets the platform receives inference payments into.
 * They are mirrored into Supabase by the `platform_wallets` migration seed
 * so both the CLI (which imports this module) and the web app (which reads
 * the table) stay in sync.
 *
 * DO NOT modify without direct instruction — these are treasury addresses.
 *
 * Rotated 2026-10-28: the previous set derived from a leaked web-wallet seed.
 * The new set derives from INFERNET_TREASURY_MNEMONIC (logicsrc vault
 * treasury--prod, never in app.env): BIP44 index N per coin = treasury-(N+1);
 * EVM/token rows use the ETH index-0 address.
 */

export const DEPOSIT_ADDRESSES = [
  { coin: "BTC",  network: "bitcoin",      address: "1GgVNyRW3cXzB6WL6h7JkKSnXav4gPgp6P",                                     label: "treasury-1"    },
  { coin: "BTC",  network: "bitcoin",      address: "16M4j1WZs8M4pAyqRHK5pJN3GHyYArZgzo",                                     label: "treasury-2"    },
  { coin: "BTC",  network: "bitcoin",      address: "14uM1fkrQPx7GpAk53uEx73KKYjmvhhaWR",                                     label: "treasury-3"    },
  { coin: "ETH",  network: "ethereum",     address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "treasury-1"    },
  { coin: "ETH",  network: "ethereum",     address: "0xaED143Dc3db189d014b90d30d7670D529D2457Cc",                             label: "treasury-2"    },
  { coin: "SOL",  network: "solana",       address: "E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA",                           label: "treasury-1"    },
  { coin: "SOL",  network: "solana",       address: "EQRrc1Hy1PzbZirAvb4yrq32ToNNjwrBFgMvR7wx9e69",                           label: "treasury-2"    },
  { coin: "POL",  network: "polygon",      address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "treasury-1"    },
  { coin: "BCH",  network: "bitcoin-cash", address: "bitcoincash:qre8fncc7s0hmqu06mn39zcwe8l7gnn3cgjfggtsrw",                 label: "treasury-1"    },
  { coin: "BCH",  network: "bitcoin-cash", address: "bitcoincash:qqd47dyq2tfv52dkghfn4d0ykltvf0fkqy694t67n9",                 label: "treasury-2"    },
  { coin: "BCH",  network: "bitcoin-cash", address: "bitcoincash:qz6ykagvtkjxccjr39k6rkd37lqjqmjmsu9y6ppsp9",                 label: "treasury-3"    },
  { coin: "DOGE", network: "dogecoin",     address: "DQWTRtCawtSjSYz4fa6WadERWFsjXMyQrw",                                     label: "treasury-1"    },
  { coin: "DOGE", network: "dogecoin",     address: "DFmrtyvJiUqdVZXQoNAhnjzCUoUivLECTz",                                     label: "treasury-2"    },
  { coin: "XRP",  network: "ripple",       address: "rNXmN6FqeNursJ8ym44YPVU9kGsd3PV6VA",                                     label: "treasury-1"    },
  { coin: "XRP",  network: "ripple",       address: "rhYZrfMVrHMYW6ed8yB3ZsLpW2wtgxMyLo",                                     label: "treasury-2"    },
  { coin: "XRP",  network: "ripple",       address: "rG15CSH4CP4FGiYYQvnHXP5WaKrWGuckE4",                                     label: "treasury-3"    },
  { coin: "ADA",  network: "cardano",      address: "addr1vxa87c88rjnt00uhsmp99mdzz8293g3q8l9drhf3kk62p6cp5937y",             label: "treasury-1"    },
  { coin: "ADA",  network: "cardano",      address: "addr1v8dsrh8tvz455zzrmy43l3d0ac0vgtuytgxzatjk4es6q6gqw8z2w",             label: "treasury-2"    },
  { coin: "BNB",  network: "bsc",          address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "treasury-1"    },
  { coin: "USDT", network: "ethereum",     address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "usdt-erc20"    },
  { coin: "USDT", network: "polygon",      address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "usdt-polygon"  },
  { coin: "USDT", network: "solana",       address: "E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA",                           label: "usdt-spl"      },
  { coin: "USDC", network: "ethereum",     address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "usdc-erc20"    },
  { coin: "USDC", network: "polygon",      address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "usdc-polygon"  },
  { coin: "USDC", network: "solana",       address: "E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA",                           label: "usdc-spl"      },
  { coin: "USDC", network: "base",         address: "0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141",                             label: "usdc-base"     }
];

export function getAddressesFor(coin, network) {
  const upper = String(coin).toUpperCase();
  return DEPOSIT_ADDRESSES.filter(
    (a) => a.coin === upper && (!network || a.network === network)
  );
}

export function pickAddress(coin, network) {
  const options = getAddressesFor(coin, network);
  if (options.length === 0) return null;
  return options[Math.floor(Math.random() * options.length)];
}
