-- Rotate the platform deposit addresses (2026-10-28).
--
-- Every address seeded by 20260419000000 derives from a web-wallet seed that
-- leaked in the 2026-10-27 dev2 compromise. Deactivate those rows and seed the
-- new set (from INFERNET_TREASURY_MNEMONIC, logicsrc vault treasury--prod).
-- packages/config/deposit-addresses.js is the source of truth; keep in sync.

update public.platform_wallets set active = false
where address in (
  '1HvEHWHAYW53cP6aQxWEcNaPb35sZZKFwF',
  '17xz382FDrKZj25aFkkc5CZuFpQcbFAgur',
  '1GTB6S6UGn9rkrKSTGpcEhpHi8SzXzWx6q',
  '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
  '0xdDeef601c86C651DD20d6EE3FE4318fC4343D95f',
  'B3zn7yeoL6NP8JCpis9ikGX8U4uCbrybCu5QeFyqkKpr',
  '7tKgJsSWPQGKk3wSijwbLf4qL8Tno4GPXrwGvkmiz39g',
  'bitcoincash:qryu0va3022eafyv6dhmdd7kylxszm5myqncfxjkaj',
  'bitcoincash:qqppxsqwekrpsn5lk56sjjpvhpv424zetudh8szzx7',
  'bitcoincash:qpw9mk5gmalaj9mjnndjkyenjz3rxgtt8grllxcmvd',
  'DPsNhvoJT5h7FGyh9uiWLeFJLsyLh7f3Wf',
  'DSKkQtcPirS2H5kGyc5pU8PHSVqx6DdUyV',
  'r4MoVnbkHbeJGiDx7GyVCCCHyhSPoqXfHR',
  'rsmeBkmDYGPxtYmbad8iBxnikePABUEZJx',
  'rKduygNv5nAP9u7y952Fhs9EPHTzgHguUi',
  'addr1v9j4u56udhkav64gm9qrp48lsymvwu3qm649vq9s0hnmzrqumlavc',
  'addr1v9euqha76gav45zwne6tu06gdu9mf3c8hqxlnx07km6xfxc4u9pyl'
);

insert into public.platform_wallets (coin, network, address, label, active) values
  ('BTC', 'bitcoin', '1GgVNyRW3cXzB6WL6h7JkKSnXav4gPgp6P', 'treasury-1'),
  ('BTC', 'bitcoin', '16M4j1WZs8M4pAyqRHK5pJN3GHyYArZgzo', 'treasury-2'),
  ('BTC', 'bitcoin', '14uM1fkrQPx7GpAk53uEx73KKYjmvhhaWR', 'treasury-3'),
  ('ETH', 'ethereum', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'treasury-1'),
  ('ETH', 'ethereum', '0xaED143Dc3db189d014b90d30d7670D529D2457Cc', 'treasury-2'),
  ('SOL', 'solana', 'E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA', 'treasury-1'),
  ('SOL', 'solana', 'EQRrc1Hy1PzbZirAvb4yrq32ToNNjwrBFgMvR7wx9e69', 'treasury-2'),
  ('POL', 'polygon', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'treasury-1'),
  ('BCH', 'bitcoin-cash', 'bitcoincash:qre8fncc7s0hmqu06mn39zcwe8l7gnn3cgjfggtsrw', 'treasury-1'),
  ('BCH', 'bitcoin-cash', 'bitcoincash:qqd47dyq2tfv52dkghfn4d0ykltvf0fkqy694t67n9', 'treasury-2'),
  ('BCH', 'bitcoin-cash', 'bitcoincash:qz6ykagvtkjxccjr39k6rkd37lqjqmjmsu9y6ppsp9', 'treasury-3'),
  ('DOGE', 'dogecoin', 'DQWTRtCawtSjSYz4fa6WadERWFsjXMyQrw', 'treasury-1'),
  ('DOGE', 'dogecoin', 'DFmrtyvJiUqdVZXQoNAhnjzCUoUivLECTz', 'treasury-2'),
  ('XRP', 'ripple', 'rNXmN6FqeNursJ8ym44YPVU9kGsd3PV6VA', 'treasury-1'),
  ('XRP', 'ripple', 'rhYZrfMVrHMYW6ed8yB3ZsLpW2wtgxMyLo', 'treasury-2'),
  ('XRP', 'ripple', 'rG15CSH4CP4FGiYYQvnHXP5WaKrWGuckE4', 'treasury-3'),
  ('ADA', 'cardano', 'addr1vxa87c88rjnt00uhsmp99mdzz8293g3q8l9drhf3kk62p6cp5937y', 'treasury-1'),
  ('ADA', 'cardano', 'addr1v8dsrh8tvz455zzrmy43l3d0ac0vgtuytgxzatjk4es6q6gqw8z2w', 'treasury-2'),
  ('BNB', 'bsc', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'treasury-1'),
  ('USDT', 'ethereum', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'usdt-erc20'),
  ('USDT', 'polygon', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'usdt-polygon'),
  ('USDT', 'solana', 'E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA', 'usdt-spl'),
  ('USDC', 'ethereum', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'usdc-erc20'),
  ('USDC', 'polygon', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'usdc-polygon'),
  ('USDC', 'solana', 'E2m6WB1nrRBKLUY5ubbknFYPeg8FVS3MWFszhJDreRpA', 'usdc-spl'),
  ('USDC', 'base', '0xc3f4ff2925ecEE9B884E7FA118F10Fc221C7a141', 'usdc-base')
on conflict (coin, address) do update set network = excluded.network, label = excluded.label, active = true;
