import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EVENT_CODE = 'LABANI-KINTIK-2026';

function corsHeaders(extra: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, provider_id, provider_secret, x-stanbic-signature',
    'Access-Control-Max-Age': '86400',
    ...extra
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

function toStr(value: unknown) {
  return String(value ?? '').trim();
}

function toNum(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualText(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left[i] ^ right[i];
  return result === 0;
}

async function verifyStanbicSignature(rawBody: string, headerSignature: string, secret: string) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expectedHex = hex(signed);
  const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(signed)));
  const provided = headerSignature.replace(/^sha256=/i, '').trim();
  return timingSafeEqualText(provided, expectedHex) || timingSafeEqualText(provided, expectedBase64);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return json({});
  if (request.method !== 'POST') return json({ responseCode: '98', responseDescription: 'Method not allowed' }, 405);

  try {
    const rawBody = await request.text();
    const webhookSecret = toStr(Deno.env.get('STANBIC_WEBHOOK_KEY'));
    const headerSignature = toStr(request.headers.get('x-stanbic-signature'));

    if (!(await verifyStanbicSignature(rawBody, headerSignature, webhookSecret))) {
      return json({ responseCode: '01', responseDescription: 'Signature verification failed' }, 401);
    }

    const transactions = JSON.parse(rawBody);
    const list = Array.isArray(transactions) ? transactions : [transactions];

    const supabaseUrl = toStr(Deno.env.get('SUPABASE_URL'));
    const serviceRoleKey = toStr(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase service credentials are not configured.');

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const responseDetails = [];

    for (const tx of list) {
      const txId = toStr(tx.transactionReferenceId || tx.requestId || tx.sessionId);
      const accountNumber = toStr(tx.customerAccountNumber);
      const amount = Math.max(0, Math.round(toNum(tx.amount, 0)));

      if (!txId || !accountNumber || amount <= 0) {
        responseDetails.push({
          requestId: txId,
          accountNumber,
          responseMessage: 'Invalid Transaction',
          isSuccessful: false
        });
        continue;
      }

      const { data: existingTransaction, error: existingError } = await supabase
        .from('stanbic_transactions')
        .select('transaction_id')
        .eq('transaction_id', txId)
        .maybeSingle();
      if (existingError) throw existingError;

      if (existingTransaction) {
        responseDetails.push({
          requestId: txId,
          accountNumber,
          responseMessage: 'Duplicate Transaction',
          isSuccessful: false
        });
        continue;
      }

      const { data: tickets, error: ticketError } = await supabase
        .from('tickets')
        .select('*')
        .eq('event_code', EVENT_CODE)
        .eq('payment_account_number', accountNumber);
      if (ticketError) throw ticketError;

      if (!tickets?.length) {
        responseDetails.push({
          requestId: txId,
          accountNumber,
          responseMessage: 'Account Not Found',
          isSuccessful: false
        });
        continue;
      }

      const expectedAmount = Math.max(...tickets.map((ticket) => toNum(ticket.amount_expected || ticket.amount_paid, 0)));
      const { data: previousTransactions, error: previousTransactionsError } = await supabase
        .from('stanbic_transactions')
        .select('amount')
        .eq('event_code', EVENT_CODE)
        .eq('payment_account_number', accountNumber);
      if (previousTransactionsError) throw previousTransactionsError;

      const previousPaid = (previousTransactions || []).reduce((total, row) => total + Math.max(0, toNum(row.amount, 0)), 0);
      const nextPaid = previousPaid + amount;
      const paid = expectedAmount > 0 && nextPaid >= expectedAmount;
      const status = paid ? (nextPaid > expectedAmount ? 'overpaid' : 'paid') : 'partial';
      const paidAt = paid ? new Date(tx.timestamp || Date.now()).toISOString() : null;

      const { error: insertError } = await supabase.from('stanbic_transactions').insert({
        transaction_id: txId,
        event_code: EVENT_CODE,
        payment_account_number: accountNumber,
        amount,
        sender_name: toStr(tx.srcAcctName),
        source_bank: toStr(tx.srcBank),
        session_id: toStr(tx.sessionId),
        received_at: new Date(tx.timestamp || Date.now()).toISOString(),
        raw_payload: tx
      });
      if (insertError) throw insertError;

      const { error: updateError } = await supabase
        .from('tickets')
        .update({
          paid,
          payment_status: status,
          amount_paid: nextPaid,
          paid_at: paidAt,
          payment_session_id: toStr(tx.sessionId),
          raw_payment_payload: tx
        })
        .eq('event_code', EVENT_CODE)
        .eq('payment_account_number', accountNumber);
      if (updateError) throw updateError;

      responseDetails.push({
        requestId: txId,
        accountNumber,
        responseMessage: paid ? 'Successful (LaBaNi Tickets Activated)' : 'Partial Payment Recorded',
        isSuccessful: true
      });
    }

    const allSuccess = responseDetails.every((detail) => detail.isSuccessful);
    return json({
      responseCode: allSuccess ? '00' : '02',
      responseDescription: 'Processed',
      responseDetails
    });
  } catch (error) {
    console.error('[LaBaNi Stanbic notifications]', error);
    return json({ responseCode: '96', responseDescription: 'Internal Server Error' }, 500);
  }
});
