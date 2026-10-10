-- Managed-endpoint pricing (docs/prd/16-managed-endpoints.md, "Pricing"):
-- the GPU class a reservation was priced from, and its one-off setup fee.
alter table public.reservations
    add column if not exists gpu_class text
        check (gpu_class is null or gpu_class in ('l40s', 'a100', 'h100', 'h100x2')),
    add column if not exists setup_fee numeric(14, 4)
        check (setup_fee is null or setup_fee >= 0);
