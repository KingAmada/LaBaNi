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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return json({});
  if (request.method !== 'POST') return json({ responseCode: '98', responseDescription: 'Method not allowed' }, 405);

  try {
    const providerId = toStr(request.headers.get('provider_id'));
    const providerSecret = toStr(request.headers.get('provider_secret'));
    const expectedProviderId = toStr(Deno.env.get('STANBIC_PROVIDER_ID'));
    const expectedProviderSecret = toStr(Deno.env.get('STANBIC_PROVIDER_SECRET'));

    if (!expectedProviderId || !expectedProviderSecret || providerId !== expectedProviderId || providerSecret !== expectedProviderSecret) {
      return json({ responseCode: '01', responseDescription: 'Invalid credentials' }, 401);
    }

    const payload = await request.json().catch(() => ({}));
    const accountNumber = toStr(payload.accountNumber);
    const requestId = toStr(payload.requestId);

    if (!accountNumber) {
      return json({ responseCode: '98', responseDescription: 'Missing accountNumber', requestId }, 400);
    }

    const supabaseUrl = toStr(Deno.env.get('SUPABASE_URL'));
    const serviceRoleKey = toStr(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase service credentials are not configured.');

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase
      .from('tickets')
      .select('payment_account_number,payment_account_name,booking_id')
      .eq('event_code', EVENT_CODE)
      .eq('payment_account_number', accountNumber)
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return json({
        accountNumber,
        accountName: '',
        responseCode: '07',
        responseDescription: 'Invalid Account',
        requestId
      });
    }

    return json({
      accountNumber,
      accountName: toStr(data.payment_account_name) || 'LaBaNi Party',
      responseCode: '00',
      responseDescription: 'Operation Successful',
      requestId
    });
  } catch (error) {
    console.error('[LaBaNi Stanbic name enquiry]', error);
    return json({ responseCode: '96', responseDescription: 'System Error' }, 500);
  }
});
