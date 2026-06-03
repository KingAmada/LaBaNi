-- Merge paid zone-upgrade bookings into the original ticket row.
-- Run this in the Supabase SQL Editor for project acqypknpiqxtavzjqhpo.

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
  is_upgrade boolean := false;
begin
  if nullif(target_booking_id, '') is null then
    return;
  end if;

  is_upgrade := target_booking_id like 'upgrade-%';

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
        'amountExpected', case
          when is_upgrade then greatest(booking_record.amount_expected, coalesce(nullif(ticket->>'amountExpected', '')::integer, 0))
          else booking_record.amount_expected
        end,
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
    greatest(paid_total, coalesce(nullif(ticket->>'amountPaid', '')::integer, 0)),
    greatest(booking_record.amount_expected, coalesce(nullif(ticket->>'amountExpected', '')::integer, 0)),
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
    paid = public.tickets.paid or excluded.paid,
    zones = case
      when excluded.paid and target_booking_id like 'upgrade-%' then (
        select coalesce(jsonb_agg(distinct zone_value), '[]'::jsonb)
        from jsonb_array_elements(coalesce(public.tickets.zones, '[]'::jsonb) || coalesce(excluded.zones, '[]'::jsonb)) as zone_items(zone_value)
      )
      when excluded.paid then excluded.zones
      else public.tickets.zones
    end,
    amount_paid = case when excluded.paid then greatest(public.tickets.amount_paid, excluded.amount_paid) else public.tickets.amount_paid end,
    amount_expected = case when excluded.paid then greatest(public.tickets.amount_expected, excluded.amount_expected) else public.tickets.amount_expected end,
    payment_account_number = case
      when excluded.paid and target_booking_id like 'upgrade-%' and nullif(public.tickets.payment_account_number, '') is not null then public.tickets.payment_account_number
      when excluded.paid then excluded.payment_account_number
      else public.tickets.payment_account_number
    end,
    payment_account_name = case
      when excluded.paid and target_booking_id like 'upgrade-%' and nullif(public.tickets.payment_account_name, '') is not null then public.tickets.payment_account_name
      when excluded.paid then excluded.payment_account_name
      else public.tickets.payment_account_name
    end,
    payment_status = case when excluded.paid then excluded.payment_status else public.tickets.payment_status end,
    booking_id = case
      when excluded.paid and target_booking_id like 'upgrade-%' and coalesce(public.tickets.booking_id, '') not like 'upgrade-%' then public.tickets.booking_id
      when excluded.paid then excluded.booking_id
      else public.tickets.booking_id
    end,
    paid_at = case when excluded.paid then coalesce(public.tickets.paid_at, excluded.paid_at) else public.tickets.paid_at end,
    payment_session_id = case
      when excluded.paid and target_booking_id like 'upgrade-%' and nullif(public.tickets.payment_session_id, '') is not null then public.tickets.payment_session_id
      when excluded.paid then excluded.payment_session_id
      else public.tickets.payment_session_id
    end,
    raw_payment_payload = case
      when excluded.paid and target_booking_id like 'upgrade-%' and public.tickets.raw_payment_payload is not null then public.tickets.raw_payment_payload
      when excluded.paid then excluded.raw_payment_payload
      else public.tickets.raw_payment_payload
    end,
    upgraded_at = case
      when excluded.paid and target_booking_id like 'upgrade-%' then now()
      when excluded.paid then excluded.issued_at
      else public.tickets.upgraded_at
    end;
end;
$$;
