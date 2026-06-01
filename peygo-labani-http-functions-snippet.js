/*
Paste this into Peygo's Wix backend http-functions.js.

It assumes the existing file already imports wixData, fetch, getSecret, and
already defines apiCors(), toStr(), toNum(), normalizePhone(), and
findOneByFieldStrOrNum().
*/

const LABANI_EVENT_CODE = 'LABANI-KINTIK-2026';
const LABANI_BOOKINGS_COLLECTION = 'LabaniBookings';
const LABANI_DEPOSITS_COLLECTION = 'LabaniDeposits';

async function getLabaniSupabaseConfig() {
  const [url, serviceRoleKey] = await Promise.all([
    getSecret('LABANI_SUPABASE_URL').catch(() => getSecret('SUPABASE_URL')).catch(() => ''),
    getSecret('LABANI_SUPABASE_SERVICE_ROLE_KEY').catch(() => getSecret('SUPABASE_SERVICE_ROLE_KEY')).catch(() => '')
  ]);

  return {
    url: toStr(url).replace(/\/$/, ''),
    serviceRoleKey: toStr(serviceRoleKey)
  };
}

async function labaniSupabaseRequest(path, options = {}) {
  const { url, serviceRoleKey } = await getLabaniSupabaseConfig();
  if (!url || !serviceRoleKey) throw new Error('LaBaNi Supabase secrets are not configured.');

  const res = await fetch(`${url}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LaBaNi Supabase request failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function fetchLabaniBookingByWalletAccount(walletAccountNumber) {
  return findOneByFieldStrOrNum(LABANI_BOOKINGS_COLLECTION, 'walletAccountNumber', walletAccountNumber);
}

async function isLabaniVirtualAccountTaken(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return false;

  const booking = await fetchLabaniBookingByWalletAccount(acct);
  if (booking) return true;

  const rows = await labaniSupabaseRequest(
    `/rest/v1/tickets?event_code=eq.${encodeURIComponent(LABANI_EVENT_CODE)}&payment_account_number=eq.${encodeURIComponent(acct)}&select=pass_id&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function generateUniqueLabaniVirtualAccount(prefix = '5770', maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const account = `${prefix}${Math.floor(100000 + Math.random() * 900000)}`;
    if (!(await isLabaniVirtualAccountTaken(account))) return account;
  }
  throw new Error('Could not generate unique LaBaNi virtual account');
}

function labaniTicketRow(ticket, booking) {
  return {
    event_code: LABANI_EVENT_CODE,
    pass_id: toStr(ticket.passId),
    guest_id: toStr(ticket.guestId),
    guest_name: toStr(ticket.name),
    phone: normalizePhone(ticket.phone),
    is_vip: ticket.isVip === true,
    paid: booking.paymentStatus === 'paid' || booking.paymentStatus === 'overpaid',
    zones: Array.isArray(ticket.zones) ? ticket.zones : [],
    amount_paid: Math.max(0, toNum(booking.totalPaid, 0)),
    amount_expected: Math.max(0, toNum(booking.amountExpected, 0)),
    payment_account_number: toStr(booking.walletAccountNumber),
    payment_account_name: toStr(booking.accountName),
    payment_status: toStr(booking.paymentStatus) || 'pending',
    booking_id: toStr(booking.bookingId),
    paid_at: booking.paidAt || null,
    payment_session_id: toStr(booking.lastSessionId),
    raw_payment_payload: booking.rawPaymentPayload || null,
    issued_at: ticket.issuedAt || new Date().toISOString(),
    upgraded_at: ticket.upgradedAt || null
  };
}

async function upsertLabaniTicketsToSupabase(tickets, booking) {
  const rows = (Array.isArray(tickets) ? tickets : [])
    .map((ticket) => labaniTicketRow(ticket, booking))
    .filter((row) => row.pass_id && row.guest_name && row.phone);

  if (!rows.length) return [];

  return labaniSupabaseRequest('/rest/v1/tickets?on_conflict=pass_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
}

export async function post_apiLabaniCreateBooking(request) {
  try {
    const payload = await request.body.json();
    const bookingId = toStr(payload?.bookingId);
    const tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
    const amountExpected = Math.max(0, toNum(payload?.amountExpected, 0));
    const primaryGuestName = toStr(payload?.primaryGuestName);
    const primaryGuestPhone = normalizePhone(payload?.primaryGuestPhone || tickets[0]?.phone);

    if (!bookingId || !tickets.length || amountExpected <= 0 || !primaryGuestPhone) {
      return apiCors({ success: false, message: 'bookingId, tickets, primaryGuestPhone and amountExpected are required' }, 400);
    }

    const existing = await findOneByFieldStrOrNum(LABANI_BOOKINGS_COLLECTION, 'bookingId', bookingId);
    if (existing) {
      const status = await buildLabaniBookingStatus(existing);
      await upsertLabaniTicketsToSupabase(tickets, status);
      return apiCors({ success: true, existing: true, booking: status });
    }

    const walletAccountNumber = await generateUniqueLabaniVirtualAccount();
    const accountName = toStr(payload?.accountName) || `LaBaNi - ${primaryGuestName || 'Guest'}`;

    const booking = await wixData.insert(LABANI_BOOKINGS_COLLECTION, {
      bookingId,
      eventCode: LABANI_EVENT_CODE,
      walletAccountNumber,
      accountName,
      amountExpected,
      totalPaid: 0,
      paymentStatus: 'pending',
      primaryGuestName,
      primaryGuestPhone,
      ticketsJson: JSON.stringify(tickets),
      createdAt: new Date(),
      updatedAt: new Date()
    }, { suppressAuth: true });

    const status = await buildLabaniBookingStatus(booking);
    await upsertLabaniTicketsToSupabase(tickets, status);
    return apiCors({ success: true, existing: false, booking: status });
  } catch (err) {
    console.error('apiLabaniCreateBooking error:', err);
    return apiCors({ success: false, message: err.message }, 500);
  }
}

async function buildLabaniBookingStatus(booking) {
  return {
    bookingId: toStr(booking.bookingId),
    walletAccountNumber: toStr(booking.walletAccountNumber),
    accountName: toStr(booking.accountName) || 'LaBaNi Party',
    amountExpected: Math.max(0, toNum(booking.amountExpected, 0)),
    totalPaid: Math.max(0, toNum(booking.totalPaid, 0)),
    paymentStatus: toStr(booking.paymentStatus) || 'pending',
    paidAt: booking.paidAt || null,
    lastSessionId: toStr(booking.lastSessionId),
    rawPaymentPayload: booking.rawPaymentPayload ? JSON.parse(booking.rawPaymentPayload) : null
  };
}

export async function get_apiLabaniPaymentStatus(request) {
  try {
    const bookingId = toStr(request.query.bookingId);
    const walletAccountNumber = toStr(request.query.walletAccountNumber);
    const booking = bookingId
      ? await findOneByFieldStrOrNum(LABANI_BOOKINGS_COLLECTION, 'bookingId', bookingId)
      : await fetchLabaniBookingByWalletAccount(walletAccountNumber);

    if (!booking) return apiCors({ success: false, message: 'LaBaNi booking not found' }, 404);
    return apiCors({ success: true, booking: await buildLabaniBookingStatus(booking) });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

async function resolveLabaniNameEnquiry(accountNumber) {
  const booking = await fetchLabaniBookingByWalletAccount(accountNumber);
  if (!booking) return null;

  return {
    found: true,
    systemType: 'LaBaNi',
    matchedName: toStr(booking.accountName) || 'LaBaNi Party',
    matchedAccountNum: toStr(booking.walletAccountNumber)
  };
}

async function recordLabaniDeposit(tx) {
  const txId = toStr(tx.transactionReferenceId || tx.requestId || tx.sessionId);
  const walletAccountNumber = toStr(tx.customerAccountNumber);
  const amount = Math.max(0, toNum(tx.amount, 0));
  if (!txId || !walletAccountNumber || amount <= 0) {
    return { handled: false, reason: 'INVALID_TRANSACTION' };
  }

  const booking = await fetchLabaniBookingByWalletAccount(walletAccountNumber);
  if (!booking) return { handled: false, reason: 'ACCOUNT_NOT_FOUND' };

  const duplicate = await findOneByFieldStrOrNum(LABANI_DEPOSITS_COLLECTION, 'transactionId', txId);
  if (duplicate) return { handled: true, duplicate: true };

  await wixData.insert(LABANI_DEPOSITS_COLLECTION, {
    transactionId: txId,
    bookingId: toStr(booking.bookingId),
    walletAccountNumber,
    amount,
    senderName: toStr(tx.srcAcctName),
    sourceBank: toStr(tx.srcBank),
    sessionId: toStr(tx.sessionId),
    timestamp: new Date(tx.timestamp || Date.now()),
    rawPayload: JSON.stringify(tx)
  }, { suppressAuth: true });

  const deposits = await wixData.query(LABANI_DEPOSITS_COLLECTION)
    .eq('bookingId', toStr(booking.bookingId))
    .limit(1000)
    .find({ suppressAuth: true });
  const totalPaid = (deposits.items || []).reduce((sum, item) => sum + Math.max(0, toNum(item.amount, 0)), 0);
  const amountExpected = Math.max(0, toNum(booking.amountExpected, 0));
  const paymentStatus = totalPaid >= amountExpected
    ? (totalPaid > amountExpected ? 'overpaid' : 'paid')
    : 'partial';
  const paidAt = totalPaid >= amountExpected ? new Date(tx.timestamp || Date.now()) : null;

  booking.totalPaid = totalPaid;
  booking.paymentStatus = paymentStatus;
  booking.paidAt = paidAt;
  booking.lastTransactionId = txId;
  booking.lastSessionId = toStr(tx.sessionId);
  booking.rawPaymentPayload = JSON.stringify(tx);
  booking.updatedAt = new Date();
  await wixData.update(LABANI_BOOKINGS_COLLECTION, booking, { suppressAuth: true });

  const tickets = JSON.parse(booking.ticketsJson || '[]');
  await upsertLabaniTicketsToSupabase(tickets, await buildLabaniBookingStatus(booking));

  return {
    handled: true,
    bookingId: toStr(booking.bookingId),
    walletAccountNumber,
    amount,
    totalPaid,
    paymentStatus
  };
}

export function options_apiLabaniCreateBooking() { return apiCors(); }
export function options_apiLabaniPaymentStatus() { return apiCors(); }

/*
Add this lookup branch inside post_stanbicNameEnquiry before the final InternetUsers fallback:

const labaniBooking = await resolveLabaniNameEnquiry(acctStr);
if (labaniBooking) {
  user = labaniBooking;
  systemType = 'LaBaNi';
  matchedName = labaniBooking.matchedName;
  matchedAccountNum = labaniBooking.matchedAccountNum;
}

Add this processing branch inside post_stanbicNotifications before InternetUsers fallback:

let labaniResult = null;
try {
  labaniResult = await recordLabaniDeposit(tx);
} catch (err) {
  console.error('LaBaNi notification sync failed:', err);
}

if (labaniResult?.handled) {
  processed = true;
  statusMessage = 'Successful (LaBaNi Ticket Payment)';
} else {
  // continue to the existing InternetUsers fallback
}
*/
