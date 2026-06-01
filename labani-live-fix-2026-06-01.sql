-- Live LaBaNi payment sync fix for 2026-06-01.
-- Run this in the Supabase SQL Editor for project acqypknpiqxtavzjqhpo.

-- 1. Browser/API access needed by the PWA and Realtime.
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

-- 2. Keep bookings and ticket rows synced whenever a deposit lands.
create or replace function public.sync_labani_booking_payment(target_booking_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_record public.labani_bookings%rowtype;
  paid_total integer := 0;
  latest_transaction_id text := null;
  latest_session_id text := null;
  latest_raw_payload jsonb := '{}'::jsonb;
  latest_deposited_at timestamptz := null;
  next_status text := 'pending';
  is_paid boolean := false;
begin
  if nullif(target_booking_id, '') is null then
    return;
  end if;

  select *
  into booking_record
  from public.labani_bookings
  where booking_id = target_booking_id
  for update;

  if not found then
    return;
  end if;

  select
    coalesce(sum(amount), 0)::integer,
    (array_agg(transaction_id order by deposited_at desc nulls last))[1],
    (array_agg(session_id order by deposited_at desc nulls last))[1],
    coalesce((array_agg(raw_payload order by deposited_at desc nulls last))[1], '{}'::jsonb),
    max(deposited_at)
  into
    paid_total,
    latest_transaction_id,
    latest_session_id,
    latest_raw_payload,
    latest_deposited_at
  from public.labani_deposits
  where booking_id = target_booking_id;

  if paid_total >= booking_record.amount_expected then
    if paid_total > booking_record.amount_expected then
      next_status := 'overpaid';
    else
      next_status := 'paid';
    end if;
  elsif paid_total > 0 then
    next_status := 'partial';
  else
    next_status := 'pending';
  end if;

  is_paid := next_status in ('paid', 'overpaid');

  update public.labani_bookings
  set
    total_paid = paid_total,
    payment_status = next_status,
    paid_at = case when is_paid then latest_deposited_at else null end,
    last_transaction_id = latest_transaction_id,
    last_session_id = latest_session_id,
    raw_payment_payload = latest_raw_payload,
    tickets = coalesce((
      select jsonb_agg(ticket || jsonb_build_object(
        'paid', is_paid,
        'amountPaid', paid_total,
        'amountExpected', booking_record.amount_expected,
        'paymentAccountNumber', booking_record.wallet_account_number,
        'paymentAccountName', booking_record.account_name,
        'paymentStatus', next_status,
        'bookingId', booking_record.booking_id,
        'paidAt', case when is_paid then latest_deposited_at else null end,
        'paymentSessionId', latest_session_id,
        'rawPaymentPayload', latest_raw_payload
      ))
      from jsonb_array_elements(booking_record.tickets) as ticket
    ), '[]'::jsonb),
    updated_at = now()
  where booking_id = target_booking_id;

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
    booking_record.event_code,
    ticket->>'passId',
    coalesce(nullif(ticket->>'guestId', ''), ticket->>'passId'),
    ticket->>'name',
    regexp_replace(coalesce(ticket->>'phone', ''), '\D', '', 'g'),
    coalesce(nullif(ticket->>'isVip', '')::boolean, false),
    is_paid,
    coalesce(ticket->'zones', '[]'::jsonb),
    paid_total,
    booking_record.amount_expected,
    booking_record.wallet_account_number,
    booking_record.account_name,
    next_status,
    booking_record.booking_id,
    case when is_paid then latest_deposited_at else null end,
    latest_session_id,
    latest_raw_payload,
    coalesce(nullif(ticket->>'issuedAt', '')::timestamptz, now())
  from jsonb_array_elements(booking_record.tickets) as ticket
  where nullif(ticket->>'passId', '') is not null
    and nullif(ticket->>'name', '') is not null
  on conflict (pass_id) do update set
    paid = excluded.paid,
    amount_paid = excluded.amount_paid,
    amount_expected = excluded.amount_expected,
    payment_account_number = excluded.payment_account_number,
    payment_account_name = excluded.payment_account_name,
    payment_status = excluded.payment_status,
    booking_id = excluded.booking_id,
    paid_at = excluded.paid_at,
    payment_session_id = excluded.payment_session_id,
    raw_payment_payload = excluded.raw_payment_payload;
end;
$$;

create or replace function public.sync_labani_booking_payment_from_deposit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_labani_booking_payment(old.booking_id);
  else
    perform public.sync_labani_booking_payment(new.booking_id);
  end if;

  return null;
end;
$$;

drop trigger if exists trg_sync_labani_booking_payment on public.labani_deposits;
create trigger trg_sync_labani_booking_payment
after insert or update or delete on public.labani_deposits
for each row
execute function public.sync_labani_booking_payment_from_deposit();

do $$
declare
  booking_to_sync record;
begin
  for booking_to_sync in
    select distinct booking_id
    from public.labani_deposits
  loop
    perform public.sync_labani_booking_payment(booking_to_sync.booking_id);
  end loop;
end $$;

-- 3. Realtime must publish both ticket-row and booking-row changes.
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

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'labani_bookings'
    )
  then
    execute 'alter publication supabase_realtime add table public.labani_bookings';
  end if;
end $$;

select
  b.booking_id,
  b.wallet_account_number,
  b.amount_expected,
  b.total_paid,
  b.payment_status,
  b.paid_at,
  b.last_transaction_id,
  b.last_session_id
from public.labani_bookings b
where exists (
  select 1
  from public.labani_deposits d
  where d.booking_id = b.booking_id
)
order by b.updated_at desc;

