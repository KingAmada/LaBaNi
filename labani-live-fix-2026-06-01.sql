-- Live LaBaNi repair for 2026-06-01.
-- Run this in the Supabase SQL Editor for project acqypknpiqxtavzjqhpo.

-- 1. Restore browser/API access needed by the PWA and Realtime.
alter table public.tickets enable row level security;
alter table public.labani_bookings enable row level security;
alter table public.ticket_scans enable row level security;

drop policy if exists "public read tickets" on public.tickets;
drop policy if exists "public write tickets" on public.tickets;
drop policy if exists "public read labani bookings" on public.labani_bookings;
drop policy if exists "public read scans" on public.ticket_scans;
drop policy if exists "public write scans" on public.ticket_scans;

create policy "public read tickets" on public.tickets for select using (true);
create policy "public write tickets" on public.tickets for all using (true) with check (true);
create policy "public read labani bookings" on public.labani_bookings for select using (true);
create policy "public read scans" on public.ticket_scans for select using (true);
create policy "public write scans" on public.ticket_scans for insert with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.tickets to anon, authenticated;
grant select on public.labani_bookings to anon, authenticated;
grant select, insert on public.ticket_scans to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tickets'
    )
  then
    execute 'alter publication supabase_realtime add table public.tickets';
  end if;
end $$;

-- 2. Repair the Jonah Mamman booking that has a deposit but still shows pending.
with deposit_totals as (
  select
    b.booking_id,
    b.event_code,
    b.wallet_account_number,
    b.account_name,
    b.amount_expected,
    coalesce(sum(d.amount), 0)::int as paid_total,
    (array_agg(d.transaction_id order by d.deposited_at desc nulls last))[1] as latest_transaction_id,
    (array_agg(d.session_id order by d.deposited_at desc nulls last))[1] as latest_session_id,
    (array_agg(d.raw_payload order by d.deposited_at desc nulls last))[1] as latest_raw_payload,
    max(d.deposited_at) as latest_deposited_at
  from public.labani_bookings b
  left join public.labani_deposits d on d.booking_id = b.booking_id
  where b.booking_id = 'booking-1780316157198'
  group by b.booking_id
),
payment_state as (
  select
    *,
    case
      when paid_total >= amount_expected then case when paid_total > amount_expected then 'overpaid' else 'paid' end
      when paid_total > 0 then 'partial'
      else 'pending'
    end as next_status,
    paid_total >= amount_expected as is_paid
  from deposit_totals
),
patched as (
  update public.labani_bookings b
  set
    total_paid = p.paid_total,
    payment_status = p.next_status,
    paid_at = case when p.is_paid then p.latest_deposited_at else null end,
    last_transaction_id = p.latest_transaction_id,
    last_session_id = p.latest_session_id,
    raw_payment_payload = coalesce(p.latest_raw_payload, '{}'::jsonb),
    tickets = coalesce((
      select jsonb_agg(ticket || jsonb_build_object(
        'paid', p.is_paid,
        'amountPaid', p.paid_total,
        'amountExpected', p.amount_expected,
        'paymentAccountNumber', p.wallet_account_number,
        'paymentAccountName', p.account_name,
        'paymentStatus', p.next_status,
        'bookingId', p.booking_id,
        'paidAt', case when p.is_paid then p.latest_deposited_at else null end,
        'paymentSessionId', p.latest_session_id,
        'rawPaymentPayload', coalesce(p.latest_raw_payload, '{}'::jsonb)
      ))
      from jsonb_array_elements(b.tickets) as ticket
    ), '[]'::jsonb),
    updated_at = now()
  from payment_state p
  where b.booking_id = p.booking_id
  returning b.*
),
ticket_rows as (
  select p.*, ticket
  from patched p
  cross join lateral jsonb_array_elements(p.tickets) as ticket
),
upserted as (
  insert into public.tickets (
    event_code,
    pass_id,
    guest_id,
    guest_name,
    phone,
    is_vip,
    paid,
    zones,
    amount_paid,
    amount_expected,
    payment_account_number,
    payment_account_name,
    payment_status,
    booking_id,
    paid_at,
    payment_session_id,
    raw_payment_payload,
    issued_at
  )
  select
    event_code,
    ticket->>'passId',
    coalesce(nullif(ticket->>'guestId', ''), ticket->>'passId'),
    ticket->>'name',
    regexp_replace(coalesce(ticket->>'phone', ''), '\D', '', 'g'),
    coalesce((ticket->>'isVip')::boolean, false),
    payment_status in ('paid', 'overpaid'),
    coalesce(ticket->'zones', '[]'::jsonb),
    total_paid,
    amount_expected,
    wallet_account_number,
    account_name,
    payment_status,
    booking_id,
    paid_at,
    last_session_id,
    raw_payment_payload,
    coalesce(nullif(ticket->>'issuedAt', '')::timestamptz, now())
  from ticket_rows
  where ticket->>'passId' is not null
    and ticket->>'name' is not null
  on conflict (pass_id) do update set
    paid = excluded.paid,
    zones = excluded.zones,
    amount_paid = excluded.amount_paid,
    amount_expected = excluded.amount_expected,
    payment_account_number = excluded.payment_account_number,
    payment_account_name = excluded.payment_account_name,
    payment_status = excluded.payment_status,
    booking_id = excluded.booking_id,
    paid_at = excluded.paid_at,
    payment_session_id = excluded.payment_session_id,
    raw_payment_payload = excluded.raw_payment_payload
  returning pass_id, paid, payment_status, amount_paid
)
select
  p.booking_id,
  p.total_paid,
  p.payment_status,
  p.paid_at,
  p.last_transaction_id,
  p.last_session_id,
  coalesce(jsonb_agg(u.*) filter (where u.pass_id is not null), '[]'::jsonb) as tickets_upserted
from patched p
left join upserted u on true
group by
  p.booking_id,
  p.total_paid,
  p.payment_status,
  p.paid_at,
  p.last_transaction_id,
  p.last_session_id;

