import wixData from 'wix-data';
import { fetch } from 'wix-fetch';
import { publish } from 'wix-realtime-backend';
import { mediaManager } from 'wix-media-backend';
import { getSecret } from 'wix-secrets-backend';
import { ok, badRequest, serverError, response } from 'wix-http-functions';
import { verifyStanbicSignature, verifyStanbicProviderHeaders } from 'backend/stanbicAuth.jsw';
import { createUser, loginUser, getUpdates, processWithdrawal, checkUserExists } from 'backend/wedly';

/* ------------------------ Helpers ------------------------ */

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, provider_id, provider_secret, x-stanbic-signature",
    "Access-Control-Max-Age": "86400",
    ...extra
  };
}

function apiCors(body = {}, status = 200, extraHeaders = {}) {
  return response({
    status,
    headers: corsHeaders(extraHeaders),
    body
  });
}

function corsOk({ origin = '*', allowHeaders = '', body = {} } = {}) {
  return ok({
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': allowHeaders || 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    },
    body
  });
}

function unauthorized({ headers = {}, body = {} } = {}) {
  return response({ status: 401, headers: { ...corsHeaders(), ...headers }, body });
}

function toStr(v) { return String(v ?? '').trim(); }
function sanitizePublicText(v, maxLen = 120) {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}
function toNum(v, dflt = 0) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function normalizeMac(mac) { return toStr(mac).replace(/-/g, ':').toUpperCase(); }
function normalizePhone(v) { return String(v || '').replace(/\D/g, ''); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function generateOpaqueToken() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 12)).join('');
}
function createSupabaseRequestError(status, responseBody) {
  return {
    name: 'DuesilySupabaseRequestError',
    message: `Duesily Supabase request failed: ${status} ${responseBody}`,
    status,
    responseBody
  };
}
function getErrorStatus(error) {
  return Number.isFinite(Number(error?.status)) ? Number(error.status) : 0;
}

async function findOneByFieldStrOrNum(collectionName, field, value, options = {}) {
  const raw = toStr(value);
  if (!raw) return null;
  const num = Number(raw);
  const q = wixData.query(collectionName);
  let query = q.eq(field, raw);
  if (Number.isFinite(num)) query = query.or(q.eq(field, num));
  const res = await query.limit(1).find({ suppressAuth: true, ...options });
  return res.items?.[0] || null;
}

function queryByFieldStrOrNum(collectionName, field, value) {
  const raw = toStr(value);
  const num = Number(raw);
  const q = wixData.query(collectionName);
  let query = q.eq(field, raw);
  if (Number.isFinite(num)) query = query.or(q.eq(field, num));
  return query;
}

async function getPoolilySupabaseConfig() {
  const [url, serviceRoleKey, gatewayUrl] = await Promise.all([
    getSecret('SUPABASE_URL'),
    getSecret('SUPABASE_SERVICE_ROLE_KEY'),
    getSecret('POOLILY_GATEWAY_URL')
  ]);

  return {
    url: toStr(url).replace(/\/$/, ''),
    serviceRoleKey: toStr(serviceRoleKey),
    gatewayUrl: toStr(gatewayUrl)
  };
}

async function fetchPoolilyUserByWalletAccount(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return null;

  const { url, serviceRoleKey } = await getPoolilySupabaseConfig();
  if (!url || !serviceRoleKey) {
    throw new Error('Poolily Supabase secrets are not configured.');
  }

  const endpoint = `${url}/rest/v1/poolily_users?wallet_account_number=eq.${encodeURIComponent(acct)}&select=id,full_name,wallet_account_number&limit=1`;
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Poolily user lookup failed: ${res.status} ${text}`);
  }

  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function recordPoolilyDeposit(tx) {
  const { gatewayUrl } = await getPoolilySupabaseConfig();
  if (!gatewayUrl) throw new Error('POOLILY_GATEWAY_URL secret is not configured.');

  const txId = toStr(tx.transactionReferenceId || tx.requestId);
  const acctStr = toStr(tx.customerAccountNumber);
  const amount = Math.max(0, toNum(tx.amount, 0));

  const res = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordDeposit',
      payload: {
        transactionId: txId,
        walletAccountNumber: acctStr,
        amount,
        senderName: toStr(tx.srcAcctName),
        sourceBank: toStr(tx.srcBank),
        sessionId: toStr(tx.sessionId),
        depositedAt: new Date(tx.timestamp || Date.now()).toISOString(),
        rawStanbicPayload: tx
      }
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'Poolily deposit sync failed');
  }
  return data;
}

/* ------------------------ Duesily helpers ------------------------ */

async function getDuesilySupabaseConfig() {
  const [duesilyUrl, sharedUrl, duesilyServiceRoleKey, sharedServiceRoleKey] = await Promise.all([
    getSecret('DUESILY_SUPABASE_URL').catch(() => ''),
    getSecret('SUPABASE_URL').catch(() => ''),
    getSecret('DUESILY_SUPABASE_SERVICE_ROLE_KEY').catch(() => ''),
    getSecret('SUPABASE_SERVICE_ROLE_KEY').catch(() => '')
  ]);

  return {
    url: toStr(duesilyUrl || sharedUrl).replace(/\/$/, ''),
    serviceRoleKey: toStr(duesilyServiceRoleKey || sharedServiceRoleKey)
  };
}

async function duesilySupabaseRequest(path, options = {}) {
  const { url, serviceRoleKey } = await getDuesilySupabaseConfig();
  if (!url || !serviceRoleKey) {
    throw new Error('Duesily Supabase secrets are not configured.');
  }

  const maxAttempts = 3;
  const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
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
        const error = createSupabaseRequestError(res.status, text);
        if (attempt < maxAttempts && retryableStatuses.has(res.status)) {
          lastError = error;
          await sleep(1000);
          continue;
        }
        throw error;
      }

      if (res.status === 204) return null;
      return res.json();
    } catch (error) {
      const errorStatus = getErrorStatus(error);
      if (attempt < maxAttempts && (!errorStatus || retryableStatuses.has(errorStatus))) {
        lastError = error;
        await sleep(1000);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Duesily Supabase request failed after retries');
}

async function upsertDuesilyIncomeRecord(payload) {
  return duesilySupabaseRequest('/rest/v1/duesily_incomes?on_conflict=transactionId', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload)
  });
}

async function fetchDuesilyEstateByWalletAccount(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_estate_signups?walletAccountNumber=eq.${encodeURIComponent(acct)}&select=id,estateName,walletAccountNumber,walletStatus,accountName&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchDuesilyEstateById(estateId) {
  const id = toStr(estateId);
  if (!id) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_estate_signups?id=eq.${encodeURIComponent(id)}&select=id,estateName,email,phone,walletAccountNumber,walletStatus,accountName&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchDuesilyResidentByWalletAccount(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_residents?walletAccountNumber=eq.${encodeURIComponent(acct)}&select=id,name,email,phone,estateId,walletAccountNumber,walletStatus,accountName,paymentStatus&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchDuesilyResidentById(residentId) {
  const id = toStr(residentId);
  if (!id) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_residents?id=eq.${encodeURIComponent(id)}&select=id,name,email,phone,estateId,walletAccountNumber,walletStatus,accountName,paymentStatus&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchDuesilyCampaignById(campaignId) {
  const id = toStr(campaignId);
  if (!id) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_campaigns?id=eq.${encodeURIComponent(id)}&select=id,title,description,targetAmount,raisedAmount,contributors,status,ends,estateId&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchDuesilyCampaignContributionByWalletAccount(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_campaign_contributions?walletAccountNumber=eq.${encodeURIComponent(acct)}&select=id,campaignId,residentId,estateId,walletAccountNumber,walletStatus,accountName,status,amountPaid,transactionCount,lastTransactionId,lastPaidAt&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchOpenDuesilyCampaignContribution(residentId, campaignId) {
  const resident = toStr(residentId);
  const campaign = toStr(campaignId);
  if (!resident || !campaign) return null;

  const rows = await duesilySupabaseRequest(
    `/rest/v1/duesily_campaign_contributions?residentId=eq.${encodeURIComponent(resident)}&campaignId=eq.${encodeURIComponent(campaign)}&status=eq.active&select=id,campaignId,residentId,estateId,walletAccountNumber,walletStatus,accountName,status,amountPaid,transactionCount,lastTransactionId,lastPaidAt&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function isDuesilyWalletAccountTaken(walletAccountNumber) {
  const acct = toStr(walletAccountNumber);
  if (!acct) return false;

  const [estate, resident] = await Promise.all([
    fetchDuesilyEstateByWalletAccount(acct),
    fetchDuesilyResidentByWalletAccount(acct)
  ]);

  if (estate || resident) return true;

  const contribution = await fetchDuesilyCampaignContributionByWalletAccount(acct);

  return !!contribution;
}

async function generateUniqueDuesilyVirtualAccount(prefix = '5770', maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const seed = Math.floor(100000 + Math.random() * 900000);
    const account = `${prefix}${seed}`;
    const existing = await isDuesilyWalletAccountTaken(account);
    if (!existing) return account;
  }
  throw new Error('Could not generate unique Duesily virtual account');
}

async function ensureDuesilyVirtualAccountActive(walletAccountNumber) {
  const estate = await fetchDuesilyEstateByWalletAccount(walletAccountNumber);
  if (!estate) return null;

  if (toStr(estate.walletStatus).toLowerCase() === 'active') {
    return estate;
  }

  const updatedRows = await duesilySupabaseRequest(
    `/rest/v1/duesily_estate_signups?id=eq.${encodeURIComponent(estate.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        walletStatus: 'active',
        updatedAt: new Date().toISOString()
      })
    }
  );

  return Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : { ...estate, walletStatus: 'active' };
}

async function ensureDuesilyResidentVirtualAccountActive(walletAccountNumber) {
  const resident = await fetchDuesilyResidentByWalletAccount(walletAccountNumber);
  if (!resident) return null;

  if (toStr(resident.walletStatus).toLowerCase() === 'active') {
    return resident;
  }

  const updatedRows = await duesilySupabaseRequest(
    `/rest/v1/duesily_residents?id=eq.${encodeURIComponent(resident.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        walletStatus: 'active',
        updatedAt: new Date().toISOString()
      })
    }
  );

  return Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : { ...resident, walletStatus: 'active' };
}

async function recordDuesilyDeposit(tx) {
  const txId = toStr(tx.transactionReferenceId || tx.requestId);
  const walletAccountNumber = toStr(tx.customerAccountNumber);
  const amount = Math.max(0, toNum(tx.amount, 0));
  if (!txId || amount <= 0) {
    return { handled: false, reason: 'INVALID_TRANSACTION' };
  }

  const existing = await duesilySupabaseRequest(
    `/rest/v1/duesily_incomes?transactionId=eq.${encodeURIComponent(txId)}&select=id,transactionId&limit=1`
  );
  if (Array.isArray(existing) && existing.length) {
    return { handled: true, duplicate: true };
  }

  const contribution = await fetchDuesilyCampaignContributionByWalletAccount(tx.customerAccountNumber);
  if (contribution) {
    const [resident, campaign] = await Promise.all([
      fetchDuesilyResidentById(contribution.residentId),
      fetchDuesilyCampaignById(contribution.campaignId)
    ]);

    const residentName = toStr(resident?.name) || 'Resident Contribution';
    const nextRaisedAmount = Math.max(0, toNum(campaign?.raisedAmount, 0)) + amount;
    const targetAmount = Math.max(0, toNum(campaign?.targetAmount, 0));
    const nextContributors = Math.max(0, toNum(campaign?.contributors, 0)) + 1;
    const nextStatus = targetAmount > 0 && nextRaisedAmount >= targetAmount ? 'completed' : (toStr(campaign?.status) || 'active');
    const nextEnds = nextStatus === 'completed' ? 'Closed' : campaign?.ends;

    await upsertDuesilyIncomeRecord({
      id: txId,
      transactionId: txId,
      walletAccountNumber,
      estateId: toStr(contribution.estateId),
      residentId: toStr(contribution.residentId),
      title: residentName,
      category: 'Project Fee',
      amount,
      date: new Date(tx.timestamp || Date.now()).toISOString(),
      icon: 'briefcase',
      color: 'bg-emerald-500',
      from: toStr(tx.srcAcctName) || toStr(tx.accountName) || 'Bank transfer',
      status: 'completed'
    });

    if (campaign?.id) {
      await duesilySupabaseRequest(
        `/rest/v1/duesily_campaigns?id=eq.${encodeURIComponent(campaign.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            raisedAmount: nextRaisedAmount,
            contributors: nextContributors,
            status: nextStatus,
            ends: nextEnds
          })
        }
      );
    }

    await duesilySupabaseRequest(
      `/rest/v1/duesily_campaign_contributions?id=eq.${encodeURIComponent(contribution.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          walletStatus: 'active',
          status: 'active',
          amountPaid: Math.max(0, toNum(contribution.amountPaid, 0)) + amount,
          transactionCount: Math.max(0, toNum(contribution.transactionCount, 0)) + 1,
          lastTransactionId: txId,
          lastPaidAt: new Date(tx.timestamp || Date.now()).toISOString(),
          updatedAt: new Date().toISOString()
        })
      }
    );

    return {
      handled: true,
      estateId: toStr(contribution.estateId),
      residentId: toStr(contribution.residentId),
      campaignId: toStr(contribution.campaignId),
      residentName,
      campaignTitle: toStr(campaign?.title),
      walletAccountNumber: toStr(contribution.walletAccountNumber),
      amount
    };
  }

  const resident = await ensureDuesilyResidentVirtualAccountActive(tx.customerAccountNumber);
  if (resident) {
    const estate = await fetchDuesilyEstateById(resident.estateId);
    const residentName = toStr(resident.name) || 'Resident Payment';

    await upsertDuesilyIncomeRecord({
      id: txId,
      transactionId: txId,
      walletAccountNumber,
      estateId: toStr(resident.estateId),
      residentId: toStr(resident.id),
      title: residentName,
      category: 'Estate Dues',
      amount,
      date: new Date(tx.timestamp || Date.now()).toISOString(),
      icon: 'home',
      color: 'bg-indigo-500',
      from: toStr(tx.srcAcctName) || toStr(tx.accountName) || 'Bank transfer',
      status: 'completed'
    });

    await duesilySupabaseRequest(
      `/rest/v1/duesily_residents?id=eq.${encodeURIComponent(resident.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          paymentStatus: 'Paid',
          updatedAt: new Date().toISOString()
        })
      }
    );

    return {
      handled: true,
      estateId: toStr(resident.estateId),
      residentId: toStr(resident.id),
      residentName,
      estateName: toStr(estate?.estateName),
      walletAccountNumber: toStr(resident.walletAccountNumber),
      amount
    };
  }

  const estate = await ensureDuesilyVirtualAccountActive(tx.customerAccountNumber);
  if (!estate) return { handled: false, reason: 'ACCOUNT_NOT_FOUND' };

  await upsertDuesilyIncomeRecord({
    id: txId,
    transactionId: txId,
    walletAccountNumber,
    estateId: estate.id,
    residentId: 0,
    title: toStr(estate.estateName) || 'Estate Funding',
    category: 'Estate Dues',
    amount,
    date: new Date(tx.timestamp || Date.now()).toISOString(),
    icon: 'building-2',
    color: 'bg-indigo-500',
    from: toStr(tx.srcAcctName) || toStr(tx.accountName) || 'Bank transfer',
    status: 'completed'
  });

  return {
    handled: true,
    estateId: estate.id,
    walletAccountNumber: toStr(estate.walletAccountNumber),
    amount
  };
}

async function resolveDuesilyNameEnquiry(accountNumber) {
  const contribution = await fetchDuesilyCampaignContributionByWalletAccount(accountNumber);
  if (contribution) {
    const [resident, campaign] = await Promise.all([
      fetchDuesilyResidentById(contribution.residentId),
      fetchDuesilyCampaignById(contribution.campaignId)
    ]);

    const residentName = toStr(contribution.accountName)
      || toStr(resident?.name)
      || 'Duesily Contribution';
    const campaignTitle = toStr(campaign?.title);

    return {
      found: true,
      systemType: 'DuesilyContribution',
      matchedName: campaignTitle ? `${residentName} - ${campaignTitle}` : residentName,
      matchedAccountNum: toStr(contribution.walletAccountNumber)
    };
  }

  const resident = await fetchDuesilyResidentByWalletAccount(accountNumber);
  if (resident) {
    const estate = await fetchDuesilyEstateById(resident.estateId);
    const residentName = toStr(resident.accountName) || toStr(resident.name) || 'Duesily Resident';
    return {
      found: true,
      systemType: 'DuesilyResident',
      matchedName: estate ? `${residentName} - ${toStr(estate.estateName)}` : residentName,
      matchedAccountNum: toStr(resident.walletAccountNumber)
    };
  }

  const estate = await fetchDuesilyEstateByWalletAccount(accountNumber);
  if (!estate) return null;

  return {
    found: true,
    systemType: 'Duesily',
    matchedName: toStr(estate.accountName) || `Duesily - ${toStr(estate.estateName)}`,
    matchedAccountNum: toStr(estate.walletAccountNumber)
  };
}

/* ------------------------ LaBaNi / Peygo helpers ------------------------ */

const LABANI_EVENT_CODE = 'LABANI-KINTIK-2026';
const LABANI_SUPABASE_URL = 'https://acqypknpiqxtavzjqhpo.supabase.co';

async function getLabaniSupabaseConfig() {
  const [labaniUrl, labaniServiceRoleKey] = await Promise.all([
    getSecret('LABANI_SUPABASE_URL').catch(() => LABANI_SUPABASE_URL),
    getSecret('LABANI_SUPABASE_SERVICE_ROLE_KEY').catch(() => '')
  ]);

  return {
    url: toStr(labaniUrl || LABANI_SUPABASE_URL).replace(/\/$/, ''),
    serviceRoleKey: toStr(labaniServiceRoleKey)
  };
}

async function labaniSupabaseRequest(path, options = {}) {
  const { url, serviceRoleKey } = await getLabaniSupabaseConfig();
  if (!url || !serviceRoleKey) {
    throw new Error('LaBaNi Supabase secrets are not configured.');
  }

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
  const acct = toStr(walletAccountNumber);
  if (!acct) return null;
  const rows = await labaniSupabaseRequest(
    `/rest/v1/labani_bookings?event_code=eq.${encodeURIComponent(LABANI_EVENT_CODE)}&wallet_account_number=eq.${encodeURIComponent(acct)}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchLabaniBookingById(bookingId) {
  const id = toStr(bookingId);
  if (!id) return null;
  const rows = await labaniSupabaseRequest(
    `/rest/v1/labani_bookings?event_code=eq.${encodeURIComponent(LABANI_EVENT_CODE)}&booking_id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
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

function parseLabaniJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function labaniTicketRow(ticket, booking) {
  const bookingTotalPaid = Math.max(0, toNum(booking.totalPaid, 0));
  const ticketAmountPaid = Math.max(0, toNum(ticket.amountPaid, 0));
  const amountPaid = ticketAmountPaid > bookingTotalPaid ? ticketAmountPaid : bookingTotalPaid;
  const bookingAmountExpected = Math.max(0, toNum(booking.amountExpected, 0));
  const ticketAmountExpected = Math.max(0, toNum(ticket.amountExpected, 0));
  return {
    event_code: LABANI_EVENT_CODE,
    pass_id: toStr(ticket.passId),
    guest_id: toStr(ticket.guestId),
    guest_name: toStr(ticket.name),
    phone: normalizePhone(ticket.phone),
    is_vip: ticket.isVip === true,
    paid: booking.paymentStatus === 'paid' || booking.paymentStatus === 'overpaid',
    zones: Array.isArray(ticket.zones) ? ticket.zones : [],
    amount_paid: amountPaid,
    amount_expected: ticketAmountExpected > bookingAmountExpected ? ticketAmountExpected : bookingAmountExpected,
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

async function buildLabaniBookingStatus(booking) {
  const rawPaymentPayload = booking.rawPaymentPayload ?? booking.raw_payment_payload;
  return {
    bookingId: toStr(booking.bookingId ?? booking.booking_id),
    walletAccountNumber: toStr(booking.walletAccountNumber ?? booking.wallet_account_number),
    accountName: toStr(booking.accountName ?? booking.account_name) || 'LaBaNi Party',
    amountExpected: Math.max(0, toNum(booking.amountExpected ?? booking.amount_expected, 0)),
    totalPaid: Math.max(0, toNum(booking.totalPaid ?? booking.total_paid, 0)),
    paymentStatus: toStr(booking.paymentStatus ?? booking.payment_status) || 'pending',
    paidAt: booking.paidAt || booking.paid_at || null,
    lastSessionId: toStr(booking.lastSessionId ?? booking.last_session_id),
    rawPaymentPayload: typeof rawPaymentPayload === 'string' ? parseLabaniJson(rawPaymentPayload, null) : (rawPaymentPayload || null)
  };
}

async function resolveLabaniNameEnquiry(accountNumber) {
  const booking = await fetchLabaniBookingByWalletAccount(accountNumber);
  if (!booking) return null;

  return {
    found: true,
    systemType: 'LaBaNi',
    matchedName: toStr(booking.account_name) || 'LaBaNi Party',
    matchedAccountNum: toStr(booking.wallet_account_number)
  };
}

async function syncLabaniBookingPayment(booking, { txId = '', tx = null } = {}) {
  const bookingId = toStr(booking?.booking_id);
  if (!bookingId) throw new Error('LaBaNi booking is missing booking_id');

  const deposits = await labaniSupabaseRequest(
    `/rest/v1/labani_deposits?booking_id=eq.${encodeURIComponent(bookingId)}&select=transaction_id,amount,deposited_at,session_id,raw_payload&order=deposited_at.asc`
  );
  const depositRows = Array.isArray(deposits) ? deposits : [];
  const totalPaid = depositRows.reduce((sum, item) => sum + Math.max(0, toNum(item.amount, 0)), 0);
  const amountExpected = Math.max(0, toNum(booking.amount_expected, 0));
  const paymentStatus = totalPaid >= amountExpected
    ? (totalPaid > amountExpected ? 'overpaid' : 'paid')
    : (totalPaid > 0 ? 'partial' : 'pending');
  const isPaid = paymentStatus === 'paid' || paymentStatus === 'overpaid';
  const latestDeposit = depositRows[depositRows.length - 1] || null;
  const paidAt = isPaid ? (latestDeposit?.deposited_at || new Date().toISOString()) : null;
  const lastTransactionId = txId || toStr(latestDeposit?.transaction_id) || toStr(booking.last_transaction_id);
  const lastSessionId = toStr(tx?.sessionId) || toStr(latestDeposit?.session_id) || toStr(booking.last_session_id);
  const rawPaymentPayload = tx || latestDeposit?.raw_payload || booking.raw_payment_payload || null;
  const paymentAccountNumber = toStr(booking.wallet_account_number);
  const paymentAccountName = toStr(booking.account_name) || 'LaBaNi Party';
  const bookingTickets = Array.isArray(booking.tickets) ? booking.tickets : [];
  const updatedTickets = bookingTickets.map((ticket) => ({
    ...ticket,
    paid: isPaid,
    amountPaid: totalPaid,
    amountExpected,
    paymentAccountNumber,
    paymentAccountName,
    paymentStatus,
    bookingId,
    paidAt,
    paymentSessionId: lastSessionId,
    rawPaymentPayload
  }));

  const updatedRows = await labaniSupabaseRequest(
    `/rest/v1/labani_bookings?booking_id=eq.${encodeURIComponent(bookingId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        total_paid: totalPaid,
        payment_status: paymentStatus,
        paid_at: paidAt,
        last_transaction_id: lastTransactionId,
        last_session_id: lastSessionId,
        raw_payment_payload: rawPaymentPayload,
        tickets: updatedTickets,
        updated_at: new Date().toISOString()
      })
    }
  );

  const updatedBooking = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : {
    ...booking,
    total_paid: totalPaid,
    payment_status: paymentStatus,
    paid_at: paidAt,
    last_transaction_id: lastTransactionId,
    last_session_id: lastSessionId,
    raw_payment_payload: rawPaymentPayload,
    tickets: updatedTickets
  };

  if (!bookingId.startsWith('upgrade-') || isPaid) {
    await upsertLabaniTicketsToSupabase(updatedTickets, await buildLabaniBookingStatus(updatedBooking));
  }

  return {
    booking: updatedBooking,
    totalPaid,
    amountExpected,
    paymentStatus,
    paidAt,
    lastTransactionId,
    lastSessionId
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

  const duplicate = await labaniSupabaseRequest(
    `/rest/v1/labani_deposits?transaction_id=eq.${encodeURIComponent(txId)}&select=transaction_id&limit=1`
  );

  const bookingId = toStr(booking.booking_id);
  const isDuplicate = Array.isArray(duplicate) && duplicate.length > 0;
  if (!isDuplicate) {
    await labaniSupabaseRequest('/rest/v1/labani_deposits', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        transaction_id: txId,
        booking_id: bookingId,
        event_code: LABANI_EVENT_CODE,
        wallet_account_number: walletAccountNumber,
        amount,
        sender_name: toStr(tx.srcAcctName),
        source_bank: toStr(tx.srcBank),
        session_id: toStr(tx.sessionId),
        deposited_at: new Date(tx.timestamp || Date.now()).toISOString(),
        raw_payload: tx
      })
    });
  }

  const synced = await syncLabaniBookingPayment(booking, { txId, tx });

  return {
    handled: true,
    duplicate: isDuplicate,
    bookingId,
    walletAccountNumber,
    amount,
    totalPaid: synced.totalPaid,
    paymentStatus: synced.paymentStatus
  };
}

/* ------------------------ SafeMeet pricing ------------------------ */

const SAFE_MEET_MIN = {
  BASIC: 500,
  STANDARD: 1000,
  CONFIDENCE_PLUS: 2500,
  DAILY_STANDARD: 3000,
  DAILY_PLUS: 5000,
  WEEKLY_STANDARD: 10000,
  WEEKLY_PLUS: 12000
};

function normalizeSafeMeetPackage(pkg) {
  const p = toStr(pkg).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (p === 'weekly plus') return 'Weekly Plus';
  if (p === 'weekly standard') return 'Weekly Standard';
  if (p === 'daily plus') return 'Daily Plus';
  if (p === 'daily standard') return 'Daily Standard';
  if (p === 'confidence plus' || p === 'confidence_plus' || p === 'confidenceplus') return 'Confidence Plus';
  if (p === 'standard') return 'Standard';
  return 'Basic';
}

function requiredAmountForPackage(pkg) {
  const p = normalizeSafeMeetPackage(pkg);
  if (p === 'Weekly Plus') return SAFE_MEET_MIN.WEEKLY_PLUS;
  if (p === 'Weekly Standard') return SAFE_MEET_MIN.WEEKLY_STANDARD;
  if (p === 'Daily Plus') return SAFE_MEET_MIN.DAILY_PLUS;
  if (p === 'Daily Standard') return SAFE_MEET_MIN.DAILY_STANDARD;
  if (p === 'Confidence Plus') return SAFE_MEET_MIN.CONFIDENCE_PLUS;
  if (p === 'Standard') return SAFE_MEET_MIN.STANDARD;
  return SAFE_MEET_MIN.BASIC;
}

function getSafeMeetPackageByAmount(amountPaid) {
  const t = toNum(amountPaid, 0);
  if (t >= SAFE_MEET_MIN.WEEKLY_PLUS) return "Weekly Plus";
  if (t >= SAFE_MEET_MIN.WEEKLY_STANDARD) return "Weekly Standard";
  if (t >= SAFE_MEET_MIN.DAILY_PLUS) return "Daily Plus";
  if (t >= SAFE_MEET_MIN.DAILY_STANDARD) return "Daily Standard";
  if (t >= SAFE_MEET_MIN.CONFIDENCE_PLUS) return "Confidence Plus";
  if (t >= SAFE_MEET_MIN.STANDARD) return "Standard";
  if (t >= SAFE_MEET_MIN.BASIC) return "Basic";
  return "Free";
}

function isSafeMeetPaid(totalPaid) {
  return toNum(totalPaid, 0) >= SAFE_MEET_MIN.BASIC;
}

function isPassPackage(pkg) {
  const p = normalizeSafeMeetPackage(pkg);
  return p === "Daily Standard" || p === "Daily Plus" || p === "Weekly Standard" || p === "Weekly Plus";
}

function getPassDurationMs(pkg) {
  const p = normalizeSafeMeetPackage(pkg);
  if (p === "Daily Standard" || p === "Daily Plus") return 24 * 60 * 60 * 1000;
  if (p === "Weekly Standard" || p === "Weekly Plus") return 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function packageRank(pkg) {
  const p = normalizeSafeMeetPackage(pkg);
  if (p === "Weekly Plus" || p === "Daily Plus" || p === "Confidence Plus") return 3;
  if (p === "Weekly Standard" || p === "Daily Standard" || p === "Standard") return 2;
  return 1;
}

function packageCovers(currentPkg, requiredPkg) {
  return packageRank(currentPkg) >= packageRank(requiredPkg);
}

function clampMinutes(value, fallback, min = 1, max = 10080) {
  const n = Math.round(toNum(value, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function tryParseJson(value, fallback = []) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function usedTxIdsFromLogs(logs = []) {
  const out = new Set();
  for (const log of logs) {
    const single = toStr(log?.paymentTxId);
    if (single) out.add(single);
    const multi = tryParseJson(log?.paymentTxIdsJson, []);
    if (Array.isArray(multi)) {
      multi.forEach((tx) => {
        const id = toStr(tx);
        if (id) out.add(id);
      });
    }
  }
  return out;
}

function latestDepositByTimestamp(items = []) {
  let latest = null;
  let latestMs = 0;
  for (const d of items) {
    const ms = new Date(d?.timestamp || d?._createdDate || 0).getTime();
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (!latest || ms >= latestMs) {
      latest = d;
      latestMs = ms;
    }
  }
  return latest;
}

async function getSafeMeetDepositsForAccount(virtualAccountNumber, { recentSince = null, limit = 200 } = {}) {
  const acctStr = toStr(virtualAccountNumber);
  const hardLimit = Math.min(500, Math.max(1, toNum(limit, 200)));
  if (!acctStr) return [];

  const runQuery = async (value) => {
    let q = wixData.query("SafeMeetDeposits").eq("virtualAccountNumber", value);
    if (recentSince instanceof Date && Number.isFinite(recentSince.getTime())) {
      q = q.ge("timestamp", recentSince);
    }
    const res = await q
      .descending("timestamp")
      .limit(hardLimit)
      .find({ suppressAuth: true });
    return res.items || [];
  };

  const stringItems = await runQuery(acctStr);
  if (stringItems.length) return stringItems;

  const asNum = Number(acctStr);
  if (!Number.isFinite(asNum)) return [];
  return runQuery(asNum);
}

async function getSafeMeetEligibilityForPackage(cleanPhone, selectedPackage) {
  const normalizedPackage = normalizeSafeMeetPackage(selectedPackage || "Basic");
  const requiredAmount = requiredAmountForPackage(normalizedPackage);

  const userRes = await wixData.query("SafeMeetUsers")
    .eq("phone", cleanPhone)
    .limit(1)
    .find({ suppressAuth: true });

  if (!userRes.items.length) {
    return { ok: false, status: 404, code: "USER_NOT_FOUND", message: "User not found" };
  }

  const user = userRes.items[0];
  const virtualAccountNumber = toStr(user.virtualAccountNumber);
  if (!virtualAccountNumber) {
    return { ok: false, status: 400, code: "NO_VIRTUAL_ACCOUNT", message: "Virtual account missing for user" };
  }

  const active = await wixData.query("SafeMeetLogs")
    .eq("userPhone", cleanPhone)
    .eq("status", "ACTIVE_WATCH")
    .descending("_createdDate")
    .limit(1)
    .find({ suppressAuth: true });

  if (active.items.length) {
    return {
      ok: false,
      status: 409,
      code: "ACTIVE_MEETUP_EXISTS",
      message: "You already have an active meetup.",
      meetupId: active.items[0]._id
    };
  }

  if (isPassPackage(normalizedPackage)) {
    const passDurationMs = getPassDurationMs(normalizedPackage);
    const nowMs = Date.now();
    const deposits = await getSafeMeetDepositsForAccount(virtualAccountNumber, {
      recentSince: new Date(nowMs - passDurationMs),
      limit: 120
    });
    const passDeposit = deposits.find((d) => {
      const amount = toNum(d.amount, 0);
      const tx = toStr(d.transactionId);
      const ts = new Date(d.timestamp || d._createdDate || Date.now()).getTime();
      if (!tx || amount < requiredAmount || !Number.isFinite(ts)) return false;
      if (!packageCovers(getSafeMeetPackageByAmount(amount), normalizedPackage)) return false;
      return nowMs <= (ts + passDurationMs);
    });
    if (!passDeposit) {
      return {
        ok: false,
        status: 402,
        code: "PAYMENT_REQUIRED",
        message: `Active ${normalizedPackage} pass not found. Make a new payment.`,
        package: normalizedPackage,
        requiredAmount,
        virtualAccountNumber
      };
    }
    return {
      ok: true,
      status: 200,
      package: normalizedPackage,
      virtualAccountNumber,
      paymentTxIds: [toStr(passDeposit.transactionId)],
      paymentAmount: toNum(passDeposit.amount, 0),
      paymentAt: passDeposit.timestamp || passDeposit._createdDate || new Date()
    };
  }

  const [logsRes, deposits] = await Promise.all([
    wixData.query("SafeMeetLogs")
      .eq("userPhone", cleanPhone)
      .descending("_createdDate")
      .limit(300)
      .find({ suppressAuth: true }),
    getSafeMeetDepositsForAccount(virtualAccountNumber, { limit: 400 })
  ]);
  const usedTxIds = usedTxIdsFromLogs(logsRes.items || []);

  const unusedDeposits = deposits.filter((d) => {
    const tx = toStr(d.transactionId);
    return tx && !usedTxIds.has(tx);
  });
  const selectedDeposits = [];
  let runningTotal = 0;
  for (const dep of unusedDeposits) {
    selectedDeposits.push(dep);
    runningTotal += Math.max(0, toNum(dep.amount, 0));
    if (runningTotal >= requiredAmount) break;
  }

  if (runningTotal < requiredAmount || !selectedDeposits.length) {
    return {
      ok: false,
      status: 402,
      code: "PAYMENT_REQUIRED",
      message: `Fresh payment required for ${normalizedPackage}.`,
      package: normalizedPackage,
      requiredAmount,
      virtualAccountNumber
    };
  }

  return {
    ok: true,
    status: 200,
    package: normalizedPackage,
    virtualAccountNumber,
    paymentTxIds: selectedDeposits.map((d) => toStr(d.transactionId)).filter(Boolean),
    paymentAmount: runningTotal,
    paymentAt: selectedDeposits[0]?.timestamp || selectedDeposits[0]?._createdDate || new Date()
  };
}

async function generateUniqueSafeMeetVirtualAccount(prefix = "5770", maxAttempts = 24) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const seed = Math.floor(100000 + Math.random() * 900000);
    const account = `${prefix}${seed}`;
    const exists = await wixData.query("SafeMeetUsers")
      .eq("virtualAccountNumber", account)
      .limit(1)
      .find({ suppressAuth: true });
    if (!exists.items.length) return account;
  }
  throw new Error("Could not generate unique virtual account");
}

/* ------------------------ Poll Influencer Helpers ------------------------ */

const POLL_INFLUENCER_COLLECTION = "PollInfluencerSignups";
const POLL_INFLUENCER_DEPOSITS_COLLECTION = "PollInfluencerDeposits";
function normalizeComboKey(value) {
  return toStr(value).replace(/\s+/g, ' ').trim();
}
function normalizeStateKey(value) {
  return toStr(value).replace(/[^A-Za-z]/g, '').toUpperCase();
}
function getPollReferralPrefix(state) {
  const normalized = normalizeStateKey(state);
  return (normalized || 'POL').slice(0, 3).padEnd(3, 'X');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const POLL_CANDIDATE_IMAGE_MAP = {
  "Bola Tinubu": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/Bola_Tinubu_portrait.jpg/1200px-Bola_Tinubu_portrait.jpg",
  "Kashim Shettima": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTYTAojx7fgjFx49kdn8eEN4GfOrJtc8_ocuRxI0uTTCZ11Ug4W1NG67JsEs2acSXr77BucEZFTu5eS50YqGpYXA8TogvE-ft48gb8mOA&s=10",
  "Nasir El-Rufai": "https://d1jcea4y7xhp7l.cloudfront.net/2018/10/Kaduna_state_Governor.jpg",
  "Peter Obi": "https://todayafrica.co/wp-content/uploads/2024/04/Blue-Simple-Dad-Appreciation-Facebook-Post-1200-%C3%97-720-px-10-2.png",
  "Rabiu Kwankwaso": "https://thetop10magazine.com.ng/wp-content/uploads/2022/09/Rabiu-Musa-Kwankwaso-NNPP.jpg",
  "Atiku Abubakar": "https://miro.medium.com/v2/resize:fit:2400/0*AZFse8ApInmJg7xf.jpg",
  "Yakubu Dogara": "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEjuBvZJoVkod1KbQdOKCSxKVqt9dk7zP6M26tKuy320OLGSuke9AuduxgF8j1G6f7OthrtlQr3MYW12RX8869PyIQQm8c_9EolExIJTu4y2q5JduhahRcnBA_6fCF0F5wDTlARpFAZuVz-L2_RBD-mVTnBcj01I-faMqKBx33v-H4cez3fPk0IdBrvF3uo/s600/Dogara.jpg",
  "Yemi Osinbajo": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRg8Lf5k-amv-09x0qKf60WXtzfSxibqI7JD9zw4bwxMkCKdMQZga3SwYfkb1KeFF3DqWZ2ugTc7pDI9Jyv3NBkMaTZUrgjgFPqU7aDJCk&s=10",
  "Nyesom Wike": "https://dailypost.ng/wp-content/uploads/2024/01/wike.jpg",
  "Godswill Akpabio": "https://www.citypost.ng/wp-content/uploads/2024/08/IMG-20240827-WA0043.jpg",
  "Bukola Saraki": "https://leadership.ng/wp-content/uploads/2023/12/Bukola-Saraki-jpg.webp",
  "Rotimi Amaechi": "https://cdn.vanguardngr.com/wp-content/uploads/2022/04/Rt-Hon.-Chibuike-Rotimi-Amaechi-Image-2022-04-28-at-7.05.36-PM.jpeg",
  "Aminu Tambuwal": "https://csn-prod-profile-images.s3.amazonaws.com/kHNmjl177dtFve7iYeHvx",
  "Goodluck Jonathan": "https://upload.wikimedia.org/wikipedia/commons/4/42/Goodluck_Jonathan_World_Economic_Forum_2013.jpg",
  "Sanusi Lamido": "https://www.itvradiong.com/wp-content/uploads/2024/05/image-208.webp"
};

async function getPollInfluencerFee() {
  const fromSecret = await getSecret('POLL_INFLUENCER_FEE').catch(() => '');
  const amount = toNum(fromSecret, 100);
  return amount > 0 ? amount : 100;
}

async function getPollBaseUrl() {
  const fromSecret = await getSecret('POLL_BASE_URL').catch(() => '');
  return toStr(fromSecret) || 'https://kingamada.github.io/Polls/';
}

function getPollPreviewImageUrl(comboKey, pollBaseUrl) {
  const [presidentName] = normalizeComboKey(comboKey).split('&').map((part) => part.trim());
  return POLL_CANDIDATE_IMAGE_MAP[presidentName] || `${pollBaseUrl.replace(/\/?$/, '/')}Poll-og.png?v=20260405-2`;
}

async function fetchPollInfluencerSignupByPhone(phone) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;
  const res = await wixData.query(POLL_INFLUENCER_COLLECTION)
    .eq('phone', cleanPhone)
    .descending('_createdDate')
    .limit(1)
    .find({ suppressAuth: true });
  return res.items?.[0] || null;
}

async function fetchPollInfluencerSignupByPhoneAndCombo(phone, comboKey) {
  const cleanPhone = normalizePhone(phone);
  const normalizedComboKey = normalizeComboKey(comboKey);
  if (!cleanPhone || !normalizedComboKey) return null;
  const res = await wixData.query(POLL_INFLUENCER_COLLECTION)
    .eq('phone', cleanPhone)
    .eq('comboKey', normalizedComboKey)
    .descending('_createdDate')
    .limit(1)
    .find({ suppressAuth: true });
  return res.items?.[0] || null;
}

async function fetchPollInfluencerSignupById(signupId) {
  const id = toStr(signupId);
  if (!id) return null;
  try {
    return await wixData.get(POLL_INFLUENCER_COLLECTION, id, { suppressAuth: true });
  } catch (_) {
    return null;
  }
}

async function fetchPollInfluencerSignupsByReferralCodes(referralCodes) {
  const codes = Array.from(new Set((referralCodes || [])
    .map((code) => toStr(code).toUpperCase())
    .filter(Boolean)));
  if (!codes.length) return [];
  const res = await wixData.query(POLL_INFLUENCER_COLLECTION)
    .hasSome('referralCode', codes)
    .limit(Math.min(codes.length, 1000))
    .find({ suppressAuth: true });
  return res.items || [];
}

async function fetchPollInfluencerSignupByVirtualAccount(accountNumber) {
  const acct = toStr(accountNumber);
  if (!acct) return null;
  const res = await queryByFieldStrOrNum(POLL_INFLUENCER_COLLECTION, 'virtualAccountNumber', acct)
    .limit(1)
    .find({ suppressAuth: true });
  return res.items?.[0] || null;
}

async function isPollInfluencerVirtualAccountTaken(accountNumber) {
  const acct = toStr(accountNumber);
  if (!acct) return false;
  const existing = await fetchPollInfluencerSignupByVirtualAccount(acct);
  return !!existing;
}

async function generateUniquePollInfluencerVirtualAccount(prefix = '5770', maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const seed = Math.floor(100000 + Math.random() * 900000);
    const account = `${prefix}${seed}`;
    const exists = await isPollInfluencerVirtualAccountTaken(account);
    if (!exists) return account;
  }
  throw new Error('Could not generate unique influencer virtual account');
}

async function isPollInfluencerReferralCodeTaken(referralCode) {
  const code = toStr(referralCode).toUpperCase();
  if (!code) return false;
  const res = await wixData.query(POLL_INFLUENCER_COLLECTION)
    .eq('referralCode', code)
    .limit(1)
    .find({ suppressAuth: true });
  return !!res.items?.length;
}

async function generateUniquePollInfluencerReferralCode(state, maxAttempts = 500) {
  const prefix = getPollReferralPrefix(state);

  for (let i = 0; i < maxAttempts; i += 1) {
    const code = `${prefix}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const exists = await isPollInfluencerReferralCodeTaken(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate unique influencer referral code');
}

async function findPollInfluencerDepositByTransactionId(transactionId) {
  const txId = toStr(transactionId);
  if (!txId) return null;
  const res = await wixData.query(POLL_INFLUENCER_DEPOSITS_COLLECTION)
    .eq('transactionId', txId)
    .limit(1)
    .find({ suppressAuth: true });
  return res.items?.[0] || null;
}

async function getPollInfluencerTotalPaid(signupId) {
  const normalizedSignupId = toStr(signupId);
  if (!normalizedSignupId) return 0;
  const res = await wixData.query(POLL_INFLUENCER_DEPOSITS_COLLECTION)
    .eq('signupId', normalizedSignupId)
    .limit(1000)
    .find({ suppressAuth: true });
  return (res.items || []).reduce((sum, item) => sum + Math.max(0, toNum(item.amount, 0)), 0);
}

async function buildPollInfluencerStatusPayload(signup) {
  if (!signup) return null;
  const pollBaseUrl = await getPollBaseUrl();
  const comboKey = normalizeComboKey(signup.comboKey);
  const referralCode = toStr(signup.referralCode).toUpperCase();
  const shareLink = toStr(signup.shareLink) || (
    referralCode && comboKey
      ? `${pollBaseUrl}${pollBaseUrl.includes('?') ? '&' : '?'}combo=${encodeURIComponent(comboKey)}&ref=${encodeURIComponent(referralCode)}#voteSection`
      : ''
  );
  return {
    signupId: signup._id,
    statusToken: toStr(signup.statusToken),
    fullName: toStr(signup.fullName),
    phone: normalizePhone(signup.phone),
    state: toStr(signup.state),
    city: toStr(signup.city),
    comboKey,
    virtualAccountNumber: toStr(signup.virtualAccountNumber),
    accountName: toStr(signup.accountName) || `Poll Influencer - ${toStr(signup.fullName)}`,
    expectedAmount: toNum(signup.expectedAmount, 0),
    totalPaid: toNum(signup.totalPaid, 0),
    paymentStatus: toStr(signup.paymentStatus) || 'pending',
    activationStatus: toStr(signup.activationStatus) || 'pending',
    referralCode,
    shareLink,
    paidAt: signup.paidAt || null,
    activatedAt: signup.activatedAt || null,
    createdAt: signup._createdDate || signup.createdAt || null
  };
}

function parseDataUrl(dataUrl) {
  const raw = toStr(dataUrl);
  const match = raw.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const base64 = match[2];
  if (!base64) return null;
  const ext = mimeType.split('/')[1] || 'jpg';
  return { mimeType, base64, ext };
}

function toPublicWixImageUrl(url) {
  const raw = toStr(url);
  if (!raw) return "";
  if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname.toLowerCase() === "static.wixstatic.com" && parsed.pathname.startsWith("/media/")) {
        const mediaPath = parsed.pathname.replace(/^\/media\//, "");
        const mediaId = mediaPath.split("/").filter(Boolean)[0] || "";
        if (mediaId) return `https://static.wixstatic.com/media/${mediaId}`;
      }
      return raw;
    } catch (_) {
      return raw;
    }
  }
  if (raw.startsWith("wix:image://v1/")) {
    try {
      const noScheme = raw.replace(/^wix:image:\/\/v1\//, "");
      const [pathPart] = noScheme.split("#");
      const [mediaId] = pathPart.split("/");
      if (!mediaId) return raw;
      return `https://static.wixstatic.com/media/${mediaId}`;
    } catch (_) {
      return raw;
    }
  }
  return raw;
}

async function uploadBase64ImageToWix(dataUrl, folderPath, namePrefix) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return "";
  const buffer = Buffer.from(parsed.base64, 'base64');
  const filename = `${namePrefix}_${Date.now()}.${parsed.ext}`;
  const uploaded = await mediaManager.upload(folderPath, buffer, filename, {
    mediaOptions: {
      mimeType: parsed.mimeType,
      mediaType: "image"
    },
    metadataOptions: {
      isPrivate: false,
      isVisitorUpload: false
    }
  });
  const fileUrl =
    uploaded?.["fileUrl"] ||
    uploaded?.["originalFileUrl"] ||
    uploaded?.["mediaUrl"] ||
    uploaded?.["url"] ||
    uploaded?.["file"]?.["url"] ||
    "";
  return toPublicWixImageUrl(fileUrl);
}

async function uploadImageListToUrls(images, folderPath, namePrefix, maxCount = 4) {
  const list = Array.isArray(images) ? images.slice(0, maxCount) : [];
  const uploadPromises = list.map((base64Str, i) =>
    uploadBase64ImageToWix(base64Str, folderPath, `${namePrefix}_${i + 1}`)
      .catch((err) => {
        console.error("SafeMeet image upload failed:", err);
        return "";
      })
  );
  const urls = await Promise.all(uploadPromises);
  return urls.filter((url) => !!toStr(url));
}

/* --- Reimbursement Helpers (For Employee Logic) --- */
function getCycleFromDate(dateLike) {
  const d = new Date(dateLike || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/* ------------------------ Logging ------------------------ */

async function logStanbicEvent(type, payload) {
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const sessionId = toStr(parsed?.sessionId);

    if (sessionId) {
      const existing = await wixData.query('StanBicLogs')
        .eq('type', type)
        .eq('sessionId', sessionId)
        .find({ suppressAuth: true });

      if (existing.items.length) return { duplicate: true };
    }

    const log = {
      timestamp: new Date(),
      type,
      accountName: toStr(parsed?.accountName || parsed?.srcAcctName),
      amount: toNum(parsed?.amount),
      srcAcct: toStr(parsed?.srcAcct),
      rawPayload: JSON.stringify(parsed)
    };

    await wixData.insert('StanBicLogs', log, { suppressAuth: true });
    return { logged: true };
  } catch (err) {
    console.error('Failed to log Stanbic event:', err);
    return { error: true };
  }
}

/* ------------------------ Health Check ------------------------ */
export function get_ping() {
  return apiCors({ status: 200, message: 'pong' });
}

export async function get_pollShare(request) {
  try {
    const comboKey = normalizeComboKey(request.query.combo);
    const referralCode = toStr(request.query.ref).toUpperCase();
    const pollBaseUrl = await getPollBaseUrl();
    const landingUrl = new URL(pollBaseUrl);
    if (comboKey) landingUrl.searchParams.set('combo', comboKey);
    if (referralCode) landingUrl.searchParams.set('ref', referralCode);
    landingUrl.hash = 'voteSection';

    const previewTitle = comboKey
      ? `${comboKey} | 2027 Nigeria Election Permutation Poll`
      : '2027 Nigeria Election Permutation Poll';
    const previewDescription = comboKey
      ? `Vote for ${comboKey} in the 2027 Nigeria Election Poll. ${referralCode ? `Use referral code ${referralCode} to support the mobilizer for this combo.` : 'Track live results and state-by-state momentum.'}`
      : 'Vote live, compare presidential and vice-presidential combinations, and track poll momentum across Nigeria.';
    const previewImage = getPollPreviewImageUrl(comboKey, pollBaseUrl);
    const escapedTitle = escapeHtml(previewTitle);
    const escapedDescription = escapeHtml(previewDescription);
    const escapedImage = escapeHtml(previewImage);
    const escapedUrl = escapeHtml(landingUrl.toString());
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapedTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta http-equiv="refresh" content="0;url=${escapedUrl}">
  <link rel="canonical" href="${escapedUrl}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapedTitle}">
  <meta property="og:description" content="${escapedDescription}">
  <meta property="og:url" content="${escapedUrl}">
  <meta property="og:image" content="${escapedImage}">
  <meta property="og:image:secure_url" content="${escapedImage}">
  <meta property="og:image:alt" content="${escapedTitle}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapedTitle}">
  <meta name="twitter:description" content="${escapedDescription}">
  <meta name="twitter:image" content="${escapedImage}">
  <script>window.location.replace(${JSON.stringify(landingUrl.toString())});</script>
  <style>
    body { font-family: Arial, sans-serif; background:#f4f8f5; color:#173825; display:grid; place-items:center; min-height:100vh; margin:0; }
    .card { max-width:640px; padding:24px; border-radius:18px; background:#fff; box-shadow:0 20px 40px rgba(0,0,0,0.08); text-align:center; }
    img { width:100%; max-width:340px; border-radius:16px; object-fit:cover; }
    a { color:#0d5c2f; }
  </style>
</head>
<body>
  <div class="card">
    <img src="${escapedImage}" alt="${escapedTitle}">
    <h1>${escapedTitle}</h1>
    <p>${escapedDescription}</p>
    <p>Redirecting to the poll...</p>
    <p><a href="${escapedUrl}">Continue if you are not redirected</a></p>
  </div>
</body>
</html>`;

    return response({
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      },
      body: html
    });
  } catch (err) {
    return response({
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: `Share preview error: ${err.message}`
    });
  }
}

/* ------------------------ CORS OPTIONS ------------------------ */
export function options_stanbicNameEnquiry(request) {
  const reqHeaders = request.headers['access-control-request-headers'] || '';
  return corsOk({ allowHeaders: reqHeaders || 'Content-Type, provider_id, provider_secret' });
}

export function options_stanbicNotifications(request) {
  const reqHeaders = request.headers['access-control-request-headers'] || '';
  return corsOk({ allowHeaders: reqHeaders || 'Content-Type, x-stanbic-signature' });
}

export function options_apiDuesilyCreateAccount() { return apiCors(); }
export function options_apiDuesilyCreateResidentAccount() { return apiCors(); }
export function options_apiDuesilyCreateCampaignContributionAccount() { return apiCors(); }
export function options_apiLabaniCreateBooking() { return apiCors(); }
export function options_apiLabaniPaymentStatus() { return apiCors(); }

/* ------------------------ 1. Name Enquiry ------------------------ */
export async function post_stanbicNameEnquiry(request) {
  const NAME_ENQUIRY_COLL = 'nameEnquiry';

  try {
    const providerId = toStr(request.headers['provider_id']);
    const providerSecret = toStr(request.headers['provider_secret']);

    if (!(await verifyStanbicProviderHeaders(providerId, providerSecret))) {
      return unauthorized({ body: { responseCode: '01', responseDescription: 'Invalid credentials' } });
    }

    const { requestId, accountNumber } = await request.body.json();
    const acctStr = toStr(accountNumber);

    if (!acctStr) {
      return badRequest({
        headers: corsHeaders(),
        body: { responseCode: '98', responseDescription: 'Missing accountNumber' }
      });
    }

    await logStanbicEvent('nameEnquiry', { requestId, accountNumber: acctStr });

    let user = null;
    let systemType = 'None';
    let matchedName = '';
    let matchedAccountNum = '';

    const employeeQuery = wixData.query('Employees');
    const employee = await employeeQuery
      .eq('peygoIssuedAccountNumber', Number(acctStr))
      .or(employeeQuery.eq('peygoIssuedAccountNumber', acctStr))
      .limit(1)
      .find({ suppressAuth: true })
      .then(r => r.items[0]);

    if (employee) {
      user = employee;
      systemType = 'Corporate';
      matchedName = employee.fullName;
      matchedAccountNum = employee.peygoIssuedAccountNumber;
    } else {
      const wedlyQuery = wixData.query('WedlyUsers');
      const wedly = await wedlyQuery
        .eq('wedlyAccountNum', acctStr)
        .or(wedlyQuery.eq('wedlyAccountNum', Number(acctStr)))
        .limit(1)
        .find({ suppressAuth: true })
        .then(r => r.items[0]);

      if (wedly) {
        user = wedly;
        systemType = 'Wedly';
        matchedName = wedly.accountName;
        matchedAccountNum = wedly.wedlyAccountNum;
      } else {
        const safeUser = await findOneByFieldStrOrNum('SafeMeetUsers', 'virtualAccountNumber', acctStr);

        if (safeUser) {
          user = safeUser;
          systemType = 'SafeMeet';
          matchedName = `Meetily: ${safeUser.fullName}`;
          matchedAccountNum = safeUser.virtualAccountNumber;
        } else {
          const influencerSignup = await fetchPollInfluencerSignupByVirtualAccount(acctStr);

          if (influencerSignup) {
            user = influencerSignup;
            systemType = 'PollInfluencer';
            matchedName = toStr(influencerSignup.accountName) || `Poll Influencer - ${toStr(influencerSignup.fullName)}`;
            matchedAccountNum = toStr(influencerSignup.virtualAccountNumber);
          } else {
            let poolilyUser = null;
            try {
              poolilyUser = await fetchPoolilyUserByWalletAccount(acctStr);
            } catch (err) {
              console.error('Poolily name enquiry lookup failed:', err);
            }

            if (poolilyUser) {
              user = poolilyUser;
              systemType = 'Poolily';
              matchedName = `Poolily - ${toStr(poolilyUser.full_name)}`;
              matchedAccountNum = toStr(poolilyUser.wallet_account_number);
            } else {
              let duesilyEstate = null;
              try {
                duesilyEstate = await resolveDuesilyNameEnquiry(acctStr);
              } catch (err) {
                console.error('Duesily name enquiry lookup failed:', err);
              }

              if (duesilyEstate) {
                user = duesilyEstate;
                systemType = 'Duesily';
                matchedName = duesilyEstate.matchedName;
                matchedAccountNum = duesilyEstate.matchedAccountNum;
              } else {
                let labaniBooking = null;
                try {
                  labaniBooking = await resolveLabaniNameEnquiry(acctStr);
                } catch (err) {
                  console.error('LaBaNi name enquiry lookup failed:', err);
                }

                if (labaniBooking) {
                  user = labaniBooking;
                  systemType = 'LaBaNi';
                  matchedName = labaniBooking.matchedName;
                  matchedAccountNum = labaniBooking.matchedAccountNum;
                } else {
                  const internetUser = await wixData.query('InternetUsers')
                    .eq('virtualAccountNumber', acctStr)
                    .limit(1)
                    .find({ suppressAuth: true })
                    .then(r => r.items[0]);

                  if (internetUser) {
                    user = internetUser;
                    systemType = 'Internet';
                    matchedName = internetUser.accountName || 'A3 Internet User';
                    matchedAccountNum = internetUser.virtualAccountNumber;
                  }
                }
              }
            }
          }
        }
      }
    }

    await wixData.insert(NAME_ENQUIRY_COLL, {
      timestamp: new Date(),
      requestId: toStr(requestId),
      accountNumber: acctStr,
      found: !!user,
      matchedAccountName: matchedName,
      systemType,
      responseCode: user ? '00' : '07',
      responseDescription: user ? 'Operation Successful' : 'Invalid Account'
    }, { suppressAuth: true });

    return apiCors(
      user
        ? {
            accountNumber: String(matchedAccountNum),
            accountName: matchedName,
            responseCode: '00',
            responseDescription: 'Operation Successful',
            requestId: toStr(requestId)
          }
        : {
            accountNumber: acctStr,
            accountName: '',
            responseCode: '07',
            responseDescription: 'Invalid Account',
            requestId: toStr(requestId)
          }
    );
  } catch (err) {
    console.error('[Name Enquiry Error]', err);
    return apiCors({ responseCode: '96', responseDescription: 'System Error' }, 500);
  }
}

/* ------------------------ 2. Notifications (Webhook) ------------------------ */
export async function post_stanbicNotifications(request) {
  try {
    const secret = await getSecret('STANBIC_WEBHOOK_KEY');
    const headerSig = toStr(request.headers['x-stanbic-signature']);
    const rawBody = await request.body.text();

    if (!verifyStanbicSignature(rawBody, headerSig, secret)) {
      return unauthorized({ body: { responseCode: '01', responseDescription: 'Signature verification failed' } });
    }

    const transactions = JSON.parse(rawBody);
    const responseDetails = [];

    for (const tx of transactions) {
      const txId = toStr(tx.transactionReferenceId || tx.requestId);
      const acctStr = toStr(tx.customerAccountNumber);
      const amount = toNum(tx.amount);

      const logResult = await logStanbicEvent('notification', tx);
      if (logResult?.duplicate) {
        responseDetails.push({
          requestId: txId,
          accountNumber: acctStr,
          responseMessage: 'Duplicate Transaction',
          isSuccessful: false
        });
        continue;
      }

      let processed = false;
      let statusMessage = 'Account Not Found';

      const employeeQuery = wixData.query('Employees');
      const employee = await employeeQuery
        .eq('peygoIssuedAccountNumber', Number(acctStr))
        .or(employeeQuery.eq('peygoIssuedAccountNumber', acctStr))
        .limit(1)
        .find({ suppressAuth: true })
        .then(r => r.items[0]);

      if (employee) {
        const existing = await wixData.query('Deposits')
          .eq('transactionId', txId)
          .limit(1)
          .find({ suppressAuth: true });

        if (existing.totalCount === 0) {
          await wixData.insert('Deposits', {
            timestamp: new Date(tx.timestamp || Date.now()),
            transactionId: txId,
            customerAccount: acctStr,
            customerName: toStr(tx.accountName),
            amountDeposited: amount,
            charge: toNum(tx.bankCharge),
            senderName: toStr(tx.srcAcctName),
            sessionId: toStr(tx.sessionId),
            systemType: 'Corporate'
          }, { suppressAuth: true });
        }
        processed = true;
        statusMessage = 'Successful (Reimbursement)';
      } else {
        const wedlyQuery = wixData.query('WedlyUsers');
        const wedlyUser = await wedlyQuery
          .eq('wedlyAccountNum', acctStr)
          .or(wedlyQuery.eq('wedlyAccountNum', Number(acctStr)))
          .limit(1)
          .find({ suppressAuth: true })
          .then(r => r.items[0]);

        if (wedlyUser) {
          const existing = await wixData.query('wedlyDeposit')
            .eq('transactionId', txId)
            .limit(1)
            .find({ suppressAuth: true });

          if (existing.totalCount === 0) {
            const newBalance = toNum(wedlyUser.balance) + amount;
            wedlyUser.balance = newBalance;
            await wixData.update('WedlyUsers', wedlyUser, { suppressAuth: true });

            await wixData.insert('wedlyDeposit', {
              timestamp: new Date(tx.timestamp || Date.now()),
              transactionId: txId,
              wedlyAccountNum: acctStr,
              customerName: wedlyUser.accountName,
              amountDeposited: amount,
              senderName: toStr(tx.srcAcctName),
              sessionId: toStr(tx.sessionId),
              status: 'Success'
            }, { suppressAuth: true });

            const payload = {
              type: 'deposit',
              amount,
              newBalance,
              senderName: toStr(tx.srcAcctName),
              title: toStr(tx.srcAcctName) || 'Guest Gift',
              accountName: wedlyUser.accountName,
              date: new Date()
            };
            try {
              await publish({ name: 'wedly-updates', resourceId: wedlyUser.title }, payload);
              await publish({ name: 'wedly-updates', resourceId: 'admin-feed' }, payload);
            } catch (e) {
              console.error('Realtime publish failed', e);
            }
          }
          processed = true;
          statusMessage = 'Successful (Wedly Balance)';
        } else {
          const safeUser = await findOneByFieldStrOrNum('SafeMeetUsers', 'virtualAccountNumber', acctStr);

          if (safeUser) {
            const existing = await wixData.query('SafeMeetDeposits')
              .eq('transactionId', txId)
              .limit(1)
              .find({ suppressAuth: true });

            if (existing.totalCount === 0) {
              await wixData.insert('SafeMeetDeposits', {
                timestamp: new Date(tx.timestamp || Date.now()),
                transactionId: txId,
                virtualAccountNumber: acctStr,
                amount,
                senderName: toStr(tx.srcAcctName),
                sourceBank: toStr(tx.srcBank)
              }, { suppressAuth: true });

              const previousTotal = toNum(safeUser.paidTotal, 0);
              const nextTotal = previousTotal + Math.max(0, amount);

              safeUser.paidTotal = nextTotal;
              safeUser.lastPaymentAmount = amount;
              safeUser.lastPaymentDate = new Date(tx.timestamp || Date.now());
              safeUser.isPaid = isSafeMeetPaid(nextTotal);
              safeUser.package = getSafeMeetPackageByAmount(amount);

              await wixData.update('SafeMeetUsers', safeUser, { suppressAuth: true });
            }

            processed = true;
            statusMessage = 'Successful (SafeMeet Unlock)';
          } else {
            const influencerSignup = await fetchPollInfluencerSignupByVirtualAccount(acctStr);

            if (influencerSignup) {
              const duplicate = await findPollInfluencerDepositByTransactionId(txId);
              if (!duplicate) {
                const influencerFee = await getPollInfluencerFee();
                const paidAt = new Date(tx.timestamp || Date.now());
                await wixData.insert(POLL_INFLUENCER_DEPOSITS_COLLECTION, {
                  transactionId: txId,
                  signupId: influencerSignup._id,
                  phone: normalizePhone(influencerSignup.phone),
                  comboKey: normalizeComboKey(influencerSignup.comboKey),
                  virtualAccountNumber: acctStr,
                  amount,
                  senderName: toStr(tx.srcAcctName),
                  sourceBank: toStr(tx.srcBank),
                  sessionId: toStr(tx.sessionId),
                  timestamp: paidAt,
                  rawPayload: JSON.stringify(tx)
                }, { suppressAuth: true });

                const totalPaid = await getPollInfluencerTotalPaid(influencerSignup._id);
                influencerSignup.totalPaid = totalPaid;
                influencerSignup.lastTransactionId = txId;
                influencerSignup.lastPaymentAmount = amount;
                influencerSignup.updatedAt = new Date();

                if (totalPaid >= influencerFee) {
                  const referralCode = toStr(influencerSignup.referralCode).toUpperCase()
                    || await generateUniquePollInfluencerReferralCode(influencerSignup.state);
                  const pollBaseUrl = await getPollBaseUrl();
                  const comboKey = normalizeComboKey(influencerSignup.comboKey);
                  const shareLink = `${pollBaseUrl}${pollBaseUrl.includes('?') ? '&' : '?'}combo=${encodeURIComponent(comboKey)}&ref=${encodeURIComponent(referralCode)}#voteSection`;

                  influencerSignup.paymentStatus = 'paid';
                  influencerSignup.activationStatus = 'activated';
                  influencerSignup.paidAt = influencerSignup.paidAt || paidAt;
                  influencerSignup.activatedAt = influencerSignup.activatedAt || new Date();
                  influencerSignup.referralCode = referralCode;
                  influencerSignup.shareLink = shareLink;

                  await wixData.update(POLL_INFLUENCER_COLLECTION, influencerSignup, { suppressAuth: true });
                } else {
                  influencerSignup.paymentStatus = 'underpaid';
                  influencerSignup.activationStatus = 'pending';
                  await wixData.update(POLL_INFLUENCER_COLLECTION, influencerSignup, { suppressAuth: true });
                }
              }
              processed = true;
              statusMessage = 'Successful (Poll Influencer Payment)';
            } else {
              let poolilyUser = null;
              try {
                poolilyUser = await fetchPoolilyUserByWalletAccount(acctStr);
              } catch (err) {
                console.error('Poolily notification lookup failed:', err);
              }

              if (poolilyUser) {
                try {
                  await recordPoolilyDeposit(tx);
                  processed = true;
                  statusMessage = 'Successful (Poolily Wallet Funding)';
                } catch (err) {
                  console.error('Poolily notification sync failed:', err);
                }
              } else {
                let duesilyResult = null;
                try {
                  duesilyResult = await recordDuesilyDeposit(tx);
                } catch (err) {
                  console.error('Duesily notification sync failed:', err);
                }

                if (duesilyResult?.handled) {
                  processed = true;
                  statusMessage = 'Successful (Duesily Estate Funding)';
                } else {
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
                    const internetUser = await wixData.query('InternetUsers')
                      .eq('virtualAccountNumber', acctStr)
                      .limit(1)
                      .find({ suppressAuth: true })
                      .then(r => r.items[0]);

                    if (internetUser) {
                      const existing = await wixData.query('InternetDeposits')
                        .eq('transactionId', txId)
                        .limit(1)
                        .find({ suppressAuth: true });

                      if (existing.totalCount === 0) {
                        const paidAt = new Date(tx.timestamp || Date.now());
                        const userMac = normalizeMac(internetUser.title);

                        await wixData.insert('InternetDeposits', {
                          transactionId: txId,
                          amount,
                          macAddress: userMac,
                          timestamp: paidAt,
                          senderName: toStr(tx.srcAcctName),
                          bankDetails: toStr(tx.sessionId)
                        }, { suppressAuth: true });

                        internetUser.title = userMac;
                        internetUser.lastPaymentDate = paidAt;
                        internetUser.routerSynced = false;
                        internetUser.lastPaymentAmount = amount;
                        internetUser.lastTransactionId = txId;

                        await wixData.update('InternetUsers', internetUser, { suppressAuth: true });
                      }
                      processed = true;
                      statusMessage = 'Successful (Internet Topup)';
                    }
                  }
                }
              }
            }
          }
        }
      }

      responseDetails.push({
        requestId: txId,
        accountNumber: acctStr,
        responseMessage: statusMessage,
        isSuccessful: amount > 0 && processed
      });
    }

    const allSuccess = responseDetails.every(r => r.isSuccessful);
    return apiCors({
      responseCode: allSuccess ? '00' : '02',
      responseDescription: 'Processed',
      responseDetails
    });
  } catch (err) {
    console.error('[Notifications] Error:', err);
    return serverError({
      headers: corsHeaders(),
      body: { responseCode: '96', responseDescription: 'Internal Server Error' }
    });
  }
}

/* ------------------------ Duesily account API ------------------------ */

export async function post_apiDuesilyCreateAccount(request) {
  try {
    const payload = await request.body.json();
    const estateId = toStr(payload?.estateId);

    if (!estateId) {
      return apiCors({ success: false, message: 'estateId is required' }, 400);
    }

    const estate = await fetchDuesilyEstateById(estateId);
    if (!estate) {
      return apiCors({ success: false, message: 'Estate not found' }, 404);
    }

    if (toStr(estate.walletAccountNumber)) {
      return apiCors({
        success: true,
        estateId: estate.id,
        walletAccountNumber: toStr(estate.walletAccountNumber),
        walletStatus: toStr(estate.walletStatus) || 'active',
        accountName: toStr(estate.accountName) || `Duesily - ${toStr(estate.estateName)}`
      });
    }

    const walletAccountNumber = await generateUniqueDuesilyVirtualAccount();
    const accountName = toStr(estate.accountName) || `Duesily - ${toStr(estate.estateName)}`;

    const updatedRows = await duesilySupabaseRequest(
      `/rest/v1/duesily_estate_signups?id=eq.${encodeURIComponent(estate.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          walletAccountNumber,
          walletStatus: 'active',
          accountProvider: 'Stanbic',
          accountName,
          updatedAt: new Date().toISOString()
        })
      }
    );

    return apiCors({
      success: true,
      estateId: estate.id,
      walletAccountNumber,
      walletStatus: 'active',
      accountName: updatedRows?.[0]?.accountName || accountName
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function post_apiDuesilyCreateResidentAccount(request) {
  try {
    const payload = await request.body.json();
    const residentId = toStr(payload?.residentId);

    if (!residentId) {
      return apiCors({ success: false, message: 'residentId is required' }, 400);
    }

    const resident = await fetchDuesilyResidentById(residentId);
    if (!resident) {
      return apiCors({ success: false, message: 'Resident not found' }, 404);
    }

    if (toStr(resident.walletAccountNumber)) {
      return apiCors({
        success: true,
        residentId: toStr(resident.id),
        estateId: toStr(resident.estateId),
        walletAccountNumber: toStr(resident.walletAccountNumber),
        walletStatus: toStr(resident.walletStatus) || 'active',
        accountName: toStr(resident.accountName) || toStr(resident.name) || 'Resident Account'
      });
    }

    const estate = await fetchDuesilyEstateById(resident.estateId);
    const walletAccountNumber = await generateUniqueDuesilyVirtualAccount();
    const accountName = toStr(resident.accountName) || toStr(resident.name) || 'Resident Account';

    const updatedRows = await duesilySupabaseRequest(
      `/rest/v1/duesily_residents?id=eq.${encodeURIComponent(resident.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          walletAccountNumber,
          walletStatus: 'active',
          accountProvider: 'Stanbic',
          accountName,
          updatedAt: new Date().toISOString()
        })
      }
    );

    return apiCors({
      success: true,
      residentId: toStr(resident.id),
      estateId: toStr(resident.estateId),
      estateName: toStr(estate?.estateName),
      walletAccountNumber,
      walletStatus: 'active',
      accountName: updatedRows?.[0]?.accountName || accountName
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function post_apiDuesilyCreateCampaignContributionAccount(request) {
  try {
    const payload = await request.body.json();
    const residentId = toStr(payload?.residentId);
    const campaignId = toStr(payload?.campaignId);

    if (!residentId || !campaignId) {
      return apiCors({ success: false, message: 'residentId and campaignId are required' }, 400);
    }

    const [resident, campaign, existingContribution] = await Promise.all([
      fetchDuesilyResidentById(residentId),
      fetchDuesilyCampaignById(campaignId),
      fetchOpenDuesilyCampaignContribution(residentId, campaignId)
    ]);

    if (!resident) {
      return apiCors({ success: false, message: 'Resident not found' }, 404);
    }

    if (!campaign) {
      return apiCors({ success: false, message: 'Campaign not found' }, 404);
    }

    if (existingContribution && toStr(existingContribution.walletAccountNumber)) {
      return apiCors({
        success: true,
        contributionId: toStr(existingContribution.id),
        residentId: toStr(resident.id),
        campaignId: toStr(campaign.id),
        estateId: toStr(resident.estateId),
        walletAccountNumber: toStr(existingContribution.walletAccountNumber),
        walletStatus: toStr(existingContribution.walletStatus) || 'active',
        accountName: toStr(existingContribution.accountName) || `${toStr(resident.name)} Contribution`
      });
    }

    const walletAccountNumber = await generateUniqueDuesilyVirtualAccount();
    const accountName = `${toStr(resident.name) || 'Resident'} Contribution`;
    const contributionId = `contrib-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const createdRows = await duesilySupabaseRequest('/rest/v1/duesily_campaign_contributions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: contributionId,
        campaignId: toStr(campaign.id),
        residentId: toStr(resident.id),
        estateId: toStr(resident.estateId),
        walletAccountNumber,
        walletStatus: 'active',
        accountProvider: 'Stanbic',
        accountName,
        status: 'active',
        amountPaid: 0,
        transactionCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    });

    return apiCors({
      success: true,
      contributionId: toStr(createdRows?.[0]?.id || contributionId),
      residentId: toStr(resident.id),
      campaignId: toStr(campaign.id),
      estateId: toStr(resident.estateId),
      walletAccountNumber,
      walletStatus: 'active',
      accountName
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

/* ------------------------ LABANI BOOKING API ------------------------ */

export async function post_apiLabaniCreateBooking(request) {
  try {
    const payload = await request.body.json();
    const bookingId = toStr(payload?.bookingId);
    const tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
    const amountExpected = Math.max(0, toNum(payload?.amountExpected, 0));
    const deferTicketUpsertUntilPaid = payload?.deferTicketUpsertUntilPaid === true;
    const primaryGuestName = sanitizePublicText(payload?.primaryGuestName, 80);
    const primaryGuestPhone = normalizePhone(payload?.primaryGuestPhone || tickets[0]?.phone);

    if (!bookingId || !tickets.length || amountExpected <= 0 || !primaryGuestPhone) {
      return apiCors({ success: false, message: 'bookingId, tickets, primaryGuestPhone and amountExpected are required' }, 400);
    }

    const existing = await fetchLabaniBookingById(bookingId);
    if (existing) {
      const status = await buildLabaniBookingStatus(existing);
      if (!deferTicketUpsertUntilPaid) {
        await upsertLabaniTicketsToSupabase(tickets, status);
      }
      return apiCors({ success: true, existing: true, booking: status });
    }

    const walletAccountNumber = await generateUniqueLabaniVirtualAccount();
    const accountName = sanitizePublicText(payload?.accountName, 80) || `LaBaNi - ${primaryGuestName || 'Guest'}`;

    const createdRows = await labaniSupabaseRequest('/rest/v1/labani_bookings', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        booking_id: bookingId,
        event_code: LABANI_EVENT_CODE,
        wallet_account_number: walletAccountNumber,
        account_name: accountName,
        amount_expected: amountExpected,
        total_paid: 0,
        payment_status: 'pending',
        primary_guest_name: primaryGuestName,
        primary_guest_phone: primaryGuestPhone,
        tickets,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    const booking = Array.isArray(createdRows) && createdRows.length ? createdRows[0] : await fetchLabaniBookingById(bookingId);
    const status = await buildLabaniBookingStatus(booking);
    if (!deferTicketUpsertUntilPaid) {
      await upsertLabaniTicketsToSupabase(tickets, status);
    }
    return apiCors({ success: true, existing: false, booking: status });
  } catch (err) {
    console.error('apiLabaniCreateBooking error:', err);
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function get_apiLabaniPaymentStatus(request) {
  try {
    const bookingId = toStr(request.query.bookingId);
    const walletAccountNumber = toStr(request.query.walletAccountNumber);
    const booking = bookingId
      ? await fetchLabaniBookingById(bookingId)
      : await fetchLabaniBookingByWalletAccount(walletAccountNumber);

    if (!booking) return apiCors({ success: false, message: 'LaBaNi booking not found' }, 404);
    return apiCors({ success: true, booking: await buildLabaniBookingStatus(booking) });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

/* ------------------------ SAFEMEET USER APIs ------------------------ */

export async function post_apiSafeMeetSignup(request) {
  try {
    const data = await request.body.json();
    const { name, phone, pin } = data;
    const cleanPhone = normalizePhone(phone);

    if (!name || !cleanPhone || !pin) {
      return apiCors({ status: "error", message: "Missing fields" }, 400);
    }

    const existing = await wixData.query("SafeMeetUsers")
      .eq("phone", cleanPhone)
      .find({ suppressAuth: true });

    if (existing.items.length > 0) {
      return apiCors({
        status: "success",
        isNew: false,
        message: "User already exists. Please sign in."
      });
    }

    const virtualAccountNumber = await generateUniqueSafeMeetVirtualAccount("5770");

    const newUser = {
      phone: cleanPhone,
      pin,
      fullName: name,
      virtualAccountNumber,
      isPaid: false,
      package: "Free",
      paidTotal: 0,
      fpcName: "",
      fpcPhone: "",
      fpcRelation: "",
      fpcPriority: "",
      createdDate: new Date()
    };

    await wixData.insert("SafeMeetUsers", newUser, { suppressAuth: true });

    return apiCors({
      status: "success",
      isNew: true,
      user: {
        phone: newUser.phone,
        name: newUser.fullName,
        virtualAccountNumber: newUser.virtualAccountNumber,
        isPaid: false,
        package: "Free",
        paidTotal: 0,
        fpcName: "",
        fpcPhone: "",
        fpcRelation: "",
        fpcPriority: ""
      }
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

/* ------------------------ Poll Influencer APIs ------------------------ */

export async function post_apiPollInfluencerSignup(request) {
  try {
    const payload = await request.body.json();
    const fullName = sanitizePublicText(payload?.fullName || payload?.name, 80);
    const phone = normalizePhone(payload?.phone);
    const comboKey = normalizeComboKey(sanitizePublicText(payload?.comboKey || payload?.combo, 120));
    const state = sanitizePublicText(payload?.state, 60);
    const city = sanitizePublicText(payload?.city, 60);
    const acceptedTerms = payload?.acceptedTerms === true;
    const acceptedPrivacy = payload?.acceptedPrivacy === true;

    if (!fullName || !phone || !comboKey || !state || !city) {
      return apiCors({ success: false, message: 'fullName, phone, state, city, and comboKey are required' }, 400);
    }
    if (phone.length !== 11) {
      return apiCors({ success: false, message: 'A valid 11-digit phone number is required' }, 400);
    }
    if (!acceptedTerms || !acceptedPrivacy) {
      return apiCors({ success: false, message: 'Terms and privacy consent are required' }, 400);
    }

    const expectedAmount = await getPollInfluencerFee();
    const existing = await fetchPollInfluencerSignupByPhoneAndCombo(phone, comboKey);
    if (existing) {
      let recordToReturn = existing;
      if (!toStr(existing.virtualAccountNumber)) {
        existing.virtualAccountNumber = await generateUniquePollInfluencerVirtualAccount();
      }
      if (!toStr(existing.statusToken)) {
        existing.statusToken = generateOpaqueToken();
      }
      existing.accountName = `Poll Influencer - ${fullName}`;
      existing.comboKey = comboKey;
      existing.fullName = fullName;
      existing.state = state;
      existing.city = city;
      existing.expectedAmount = expectedAmount;
      existing.totalPaid = toNum(existing.totalPaid, 0);
      existing.paymentStatus = toStr(existing.paymentStatus) || 'pending';
      existing.activationStatus = toStr(existing.activationStatus) || 'pending';
      existing.acceptedTerms = true;
      existing.acceptedPrivacy = true;
      existing.consentAcceptedAt = existing.consentAcceptedAt || new Date();
      existing.updatedAt = new Date();
      recordToReturn = await wixData.update(POLL_INFLUENCER_COLLECTION, existing, { suppressAuth: true });
      return apiCors({
        success: true,
        existing: true,
        signup: await buildPollInfluencerStatusPayload(recordToReturn)
      });
    }

    const virtualAccountNumber = await generateUniquePollInfluencerVirtualAccount();
    const created = await wixData.insert(POLL_INFLUENCER_COLLECTION, {
      fullName,
      phone,
      state,
      city,
      comboKey,
      expectedAmount,
      totalPaid: 0,
      virtualAccountNumber,
      statusToken: generateOpaqueToken(),
      accountName: `Poll Influencer - ${fullName}`,
      paymentStatus: 'pending',
      activationStatus: 'pending',
      acceptedTerms: true,
      acceptedPrivacy: true,
      consentAcceptedAt: new Date(),
      accountProvider: 'Stanbic',
      createdAt: new Date(),
      updatedAt: new Date()
    }, { suppressAuth: true });

    return apiCors({
      success: true,
      existing: false,
      signup: await buildPollInfluencerStatusPayload(created)
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function get_apiPollInfluencerStatus(request) {
  try {
    const signupId = toStr(request.query.signupId);
    const statusToken = toStr(request.query.statusToken);
    if (!signupId || !statusToken) {
      return apiCors({ success: false, message: 'signupId and statusToken are required' }, 400);
    }

    const signup = await fetchPollInfluencerSignupById(signupId);

    if (!signup) {
      return apiCors({ success: false, message: 'Influencer signup not found' }, 404);
    }
    if (toStr(signup.statusToken) !== statusToken) {
      return apiCors({ success: false, message: 'Influencer signup access denied' }, 403);
    }

    return apiCors({
      success: true,
      signup: await buildPollInfluencerStatusPayload(signup)
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function post_apiPollInfluencerStatus(request) {
  try {
    const payload = await request.body.json();
    const signupId = toStr(payload?.signupId);
    const statusToken = toStr(payload?.statusToken);
    if (!signupId || !statusToken) {
      return apiCors({ success: false, message: 'signupId and statusToken are required' }, 400);
    }

    const signup = await fetchPollInfluencerSignupById(signupId);
    if (!signup) {
      return apiCors({ success: false, message: 'Influencer signup not found' }, 404);
    }
    if (toStr(signup.statusToken) !== statusToken) {
      return apiCors({ success: false, message: 'Influencer signup access denied' }, 403);
    }

    return apiCors({
      success: true,
      signup: await buildPollInfluencerStatusPayload(signup)
    });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function get_apiPollInfluencerReferrals(request) {
  try {
    const rawCodes = toStr(request.query.codes);
    const codes = rawCodes
      .split(',')
      .map((code) => toStr(code).toUpperCase())
      .filter(Boolean)
      .slice(0, 200);

    if (!codes.length) {
      return apiCors({ success: true, referrals: [] });
    }

    const signups = await fetchPollInfluencerSignupsByReferralCodes(codes);
    const referrals = signups.map((signup) => ({
      referralCode: toStr(signup.referralCode).toUpperCase(),
      fullName: toStr(signup.fullName),
      firstName: toStr(signup.fullName).trim().split(/\s+/)[0] || '',
      comboKey: normalizeComboKey(signup.comboKey)
    }));

    return apiCors({ success: true, referrals });
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 500);
  }
}

export async function get_apiSafeMeetStatus(request) {
  try {
    const phone = normalizePhone(request.query.phone);
    if (!phone) return apiCors({ status: "error", message: "Phone required" }, 400);

    const result = await wixData.query("SafeMeetUsers")
      .eq("phone", phone)
      .limit(1)
      .find({ suppressAuth: true });

    if (result.items.length === 0) return apiCors({ status: "error", message: "User not found" }, 404);

    const user = result.items[0];
    const dep = await queryByFieldStrOrNum("SafeMeetDeposits", "virtualAccountNumber", toStr(user.virtualAccountNumber))
      .limit(1000)
      .find({ suppressAuth: true });

    const summed = (dep.items || []).reduce((acc, d) => acc + toNum(d.amount, 0), 0);
    const totalPaid = Math.max(toNum(user.paidTotal, 0), summed);

    const latestDeposit = latestDepositByTimestamp(dep.items || []);
    const latestAmount = Math.max(
      toNum(user.lastPaymentAmount, 0),
      toNum(latestDeposit?.amount, 0)
    );
    const packageNow = getSafeMeetPackageByAmount(latestAmount || totalPaid);
    const isPaidNow = isSafeMeetPaid(totalPaid);

    if (toNum(user.paidTotal, 0) !== totalPaid || user.package !== packageNow || user.isPaid !== isPaidNow) {
      user.paidTotal = totalPaid;
      user.package = packageNow;
      user.isPaid = isPaidNow;
      await wixData.update("SafeMeetUsers", user, { suppressAuth: true });
    }

    return apiCors({
      status: "success",
      isPaid: isPaidNow,
      package: packageNow,
      paidTotal: totalPaid,
      lastPaymentAmount: latestAmount,
      virtualAccountNumber: user.virtualAccountNumber,
      lastPaymentDate: user.lastPaymentDate
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

export async function post_apiSafeMeetLogin(request) {
  try {
    const { phone, pin } = await request.body.json();
    const cleanPhone = normalizePhone(phone);

    const result = await wixData.query("SafeMeetUsers")
      .eq("phone", cleanPhone)
      .eq("pin", pin)
      .limit(1)
      .find({ suppressAuth: true });

    if (result.items.length === 0) {
      return apiCors({ status: "error", message: "Invalid credentials" }, 401);
    }

    const user = result.items[0];
    return apiCors({
      status: "success",
      user: {
        phone: user.phone,
        name: user.fullName,
        virtualAccountNumber: user.virtualAccountNumber,
        isPaid: !!user.isPaid,
        package: user.package || "Free",
        paidTotal: toNum(user.paidTotal, 0),
        fpcName: user.fpcName || "",
        fpcPhone: user.fpcPhone || "",
        fpcRelation: user.fpcRelation || "",
        fpcPriority: user.fpcPriority || ""
      }
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

/* ------------------------ SAFEMEET PROFILE API ------------------------ */

export async function post_apiUpdateProfile(request) {
  try {
    const payload = await request.body.json();
    const { phone, fpcName, fpcPhone, fpcRelation, fpcPriority } = payload || {};
    const cleanPhone = normalizePhone(phone);

    if (!cleanPhone) return apiCors({ status: "error", message: "Phone required" }, 400);

    const result = await wixData.query("SafeMeetUsers")
      .eq("phone", cleanPhone)
      .limit(1)
      .find({ suppressAuth: true });

    if (result.items.length === 0) return apiCors({ status: "error", message: "User not found" }, 404);

    const user = result.items[0];
    user.fpcName = toStr(fpcName);
    user.fpcPhone = normalizePhone(fpcPhone);
    user.fpcRelation = toStr(fpcRelation);
    user.fpcPriority = toStr(fpcPriority);
    user.updatedAt = new Date();

    await wixData.update("SafeMeetUsers", user, { suppressAuth: true });
    return apiCors({ status: "success" });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

/* ------------------------ SAFEMEET LOGGING APIs ------------------------ */

export async function post_apiCanCreateMeetup(request) {
  try {
    const payload = await request.body.json();
    const cleanPhone = normalizePhone(payload?.phone);
    const selectedPackage = normalizeSafeMeetPackage(payload?.selectedPackage || payload?.activePackage || "Basic");
    if (!cleanPhone) return apiCors({ status: "error", message: "Phone required" }, 400);

    const eligibility = await getSafeMeetEligibilityForPackage(cleanPhone, selectedPackage);
    if (!eligibility.ok) {
      return apiCors({
        status: "error",
        allowed: false,
        code: eligibility.code || "PAYMENT_REQUIRED",
        message: eligibility.message || `Payment required for ${selectedPackage}.`,
        package: selectedPackage,
        requiredAmount: eligibility.requiredAmount,
        virtualAccountNumber: eligibility.virtualAccountNumber,
        meetupId: eligibility.meetupId
      }, 200);
    }

    return apiCors({
      status: "success",
      allowed: true,
      package: selectedPackage,
      paymentTxIds: eligibility.paymentTxIds || [],
      paymentAmount: toNum(eligibility.paymentAmount, 0),
      paymentAt: eligibility.paymentAt || new Date(),
      virtualAccountNumber: eligibility.virtualAccountNumber || ""
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

export async function post_apiCreateMeetup(request) {
  try {
    const payload = await request.body.json();
    const {
      phone,
      activePackage,
      selectedPackage: selectedPackageRaw,
      pendingData,
      preLogPhoto,
      packageType,
      packageWindow
    } = payload;
    const cleanPhone = normalizePhone(phone);

    if (!cleanPhone) return apiCors({ status: "error", message: "Phone required" }, 400);

    const selectedPackage = normalizeSafeMeetPackage(selectedPackageRaw || activePackage || "Basic");
    const eligibility = await getSafeMeetEligibilityForPackage(cleanPhone, selectedPackage);
    if (!eligibility.ok) {
      if (eligibility.code === "ACTIVE_MEETUP_EXISTS") {
        return apiCors({ status: "success", meetupId: eligibility.meetupId, reused: true });
      }
      return apiCors({
        status: "error",
        code: eligibility.code || "PAYMENT_REQUIRED",
        message: eligibility.message || `Payment required for ${selectedPackage}.`,
        requiredAmount: eligibility.requiredAmount,
        package: selectedPackage,
        virtualAccountNumber: eligibility.virtualAccountNumber
      }, eligibility.status || 402);
    }
    const userRes = await wixData.query("SafeMeetUsers")
      .eq("phone", cleanPhone)
      .limit(1)
      .find({ suppressAuth: true });
    const user = userRes.items[0];
    const paymentTxIds = eligibility.paymentTxIds || [];
    const paymentAmount = toNum(eligibility.paymentAmount, 0);
    const paymentAt = eligibility.paymentAt || new Date();

    const expectedDurationMinutes = clampMinutes(pendingData?.expectedDurationMinutes, 120, 15, 2880);
    const graceMinutes = clampMinutes(pendingData?.graceMinutes, 20, 10, 30);
    const secondaryWelfareHours = clampMinutes(pendingData?.secondaryWelfareHours, 48, 24, 168);
    const nowMs = Date.now();
    const expectedEndAt = new Date(nowMs + expectedDurationMinutes * 60 * 1000);
    const graceEndsAt = new Date(nowMs + (expectedDurationMinutes + graceMinutes) * 60 * 1000);
    const welfareCheckAt = new Date(nowMs + secondaryWelfareHours * 60 * 60 * 1000);
    const reminderLeadAt = new Date(Math.max(nowMs, expectedEndAt.getTime() - (10 * 60 * 1000)));
    const reminderDeadlineAt = expectedEndAt;
    const expiresAt = welfareCheckAt;
    const folderPath = `/SafeMeet/${cleanPhone}`;
    const strangerUrls = await uploadImageListToUrls(pendingData?.strangerImageDataUrls, folderPath, "stranger", 1);
    const supportUrls = await uploadImageListToUrls(pendingData?.supportImageDataUrls, folderPath, "support", 6);
    const preLogPhotoUrl = await uploadBase64ImageToWix(preLogPhoto, folderPath, "prelog").catch(() => "");

    const newMeetup = {
      userPhone: cleanPhone,
      selectedPackage,
      faceMatchEnabled: pendingData?.faceMatchEnabled !== false,
      packageType: toStr(packageType) || (isPassPackage(selectedPackage) ? "pass" : "single"),
      packageWindow: toStr(packageWindow) || (isPassPackage(selectedPackage) ? (selectedPackage.startsWith("Weekly") ? "weekly" : "daily") : "single_log"),
      packageRank: packageRank(selectedPackage),
      fullName: toStr(pendingData?.fullName),
      placeType: toStr(pendingData?.placeType),
      address: toStr(pendingData?.address),
      state: toStr(pendingData?.state),
      lga: toStr(pendingData?.lga),
      phonesJson: JSON.stringify(Array.isArray(pendingData?.phones) ? pendingData.phones : []),
      dynamicFieldsJson: JSON.stringify(pendingData?.dynamicFields || {}),
      strangerImagesJson: JSON.stringify(strangerUrls),
      supportImagesJson: JSON.stringify(supportUrls),
      preLogPhoto: preLogPhotoUrl,
      status: "ACTIVE_WATCH",
      expectedDurationMinutes,
      graceMinutes,
      secondaryWelfareHours,
      expectedEndAt,
      graceEndsAt,
      welfareCheckAt,
      reminderLeadAt,
      reminderDeadlineAt,
      expiresAt,
      isEscalated: false,
      paymentTxId: paymentTxIds[0] || "",
      paymentTxIdsJson: JSON.stringify(paymentTxIds),
      paymentAmount: paymentAmount,
      paymentAt
    };

    const inserted = await wixData.insert("SafeMeetLogs", newMeetup, { suppressAuth: true });

    user.meetupsConsumedCount = toNum(user.meetupsConsumedCount, 0) + 1;
    user.updatedAt = new Date();
    await wixData.update("SafeMeetUsers", user, { suppressAuth: true });

    return apiCors({
      status: "success",
      meetupId: inserted._id,
      paymentTxId: newMeetup.paymentTxId,
      paymentTxIds: paymentTxIds
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

export async function post_apiEndMeetup(request) {
  try {
    const payload = await request.body.json();
    const { meetupId, livenessPhoto } = payload;

    if (!meetupId) return apiCors({ status: "error", message: "Meetup ID required" }, 400);

    const meetup = await wixData.get("SafeMeetLogs", meetupId, { suppressAuth: true });
    if (!meetup) return apiCors({ status: "error", message: "Not found" }, 404);

    meetup.status = "SAFE";
    meetup.livenessPhoto = livenessPhoto || "";
    meetup.endedAt = new Date();

    await wixData.update("SafeMeetLogs", meetup, { suppressAuth: true });
    return apiCors({ status: "success" });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

export async function get_apiGetActiveMeetup(request) {
  try {
    const phone = normalizePhone(request.query.phone);
    if (!phone) return apiCors({ status: "error", message: "Phone required" }, 400);

    const result = await wixData.query("SafeMeetLogs")
      .eq("userPhone", phone)
      .eq("status", "ACTIVE_WATCH")
      .descending("_createdDate")
      .limit(1)
      .find({ suppressAuth: true });

    if (result.items.length === 0) return apiCors({ status: "success", data: null });
    const active = { ...result.items[0] };
    active.preLogPhoto = toPublicWixImageUrl(active.preLogPhoto);
    const strangerImages = tryParseJson(active.strangerImagesJson, []);
    const supportImages = tryParseJson(active.supportImagesJson, []);
    active.strangerImagesJson = JSON.stringify(
      Array.isArray(strangerImages) ? strangerImages.map((u) => toPublicWixImageUrl(u)).filter(Boolean) : []
    );
    active.supportImagesJson = JSON.stringify(
      Array.isArray(supportImages) ? supportImages.map((u) => toPublicWixImageUrl(u)).filter(Boolean) : []
    );
    if (packageRank(active.selectedPackage) < 2) {
      active.lastGps = "";
      active.lastGpsAt = null;
    }
    return apiCors({ status: "success", data: active });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

export async function post_apiUpdateMeetup(request) {
  try {
    const payload = await request.body.json();
    const { meetupId, updateType, gpsData, noteData, reminderStage, extendMinutes, expectedEndAt, graceEndsAt } = payload;
    let realtimeEvent = "";

    if (!meetupId) return apiCors({ status: "error", message: "Meetup ID required" }, 400);

    const meetup = await wixData.get("SafeMeetLogs", meetupId, { suppressAuth: true });
    if (!meetup) return apiCors({ status: "error", message: "Not found" }, 404);

    if (updateType === "gps" && packageRank(meetup.selectedPackage) >= 2) {
      meetup.lastGps = gpsData;
      meetup.lastGpsAt = new Date();
    } else if (updateType === "note") {
      meetup.lastUpdateNote = noteData;
      meetup.lastUpdateAt = new Date();
    } else if (updateType === "reminder") {
      const stage = toStr(reminderStage).toUpperCase();
      if (stage === "LEAD_10M") {
        meetup.reminderLeadSentAt = new Date();
      } else {
        meetup.reminderDeadlineSentAt = new Date();
      }
      meetup.lastUpdateNote = toStr(noteData) || "Reminder issued";
      meetup.lastUpdateAt = new Date();
      realtimeEvent = "meetup_reminder";
    } else if (updateType === "emergency_trigger") {
      meetup.isEscalated = true;
      meetup.emergencyAlertTriggeredAt = new Date();
      meetup.lastUpdateNote = toStr(noteData) || "Emergency flow triggered";
      meetup.lastUpdateAt = new Date();
      realtimeEvent = "meetup_emergency_triggered";
    } else if (updateType === "extend_time") {
      const addMinutes = clampMinutes(extendMinutes, 60, 15, 720);
      const currentExpectedEnd = new Date(expectedEndAt || meetup.expectedEndAt || new Date());
      const currentGraceEnds = new Date(graceEndsAt || meetup.graceEndsAt || new Date(currentExpectedEnd.getTime() + (clampMinutes(meetup.graceMinutes, 20, 10, 30) * 60 * 1000)));
      meetup.expectedDurationMinutes = clampMinutes(meetup.expectedDurationMinutes, 120, 15, 2880) + addMinutes;
      meetup.expectedEndAt = new Date(currentExpectedEnd.getTime() + addMinutes * 60 * 1000);
      meetup.graceEndsAt = new Date(currentGraceEnds.getTime() + addMinutes * 60 * 1000);
      meetup.reminderLeadAt = new Date(Math.max(Date.now(), meetup.expectedEndAt.getTime() - (10 * 60 * 1000)));
      meetup.reminderDeadlineAt = meetup.expectedEndAt;
      meetup.reminderLeadSentAt = null;
      meetup.reminderDeadlineSentAt = null;
      meetup.isEscalated = false;
      meetup.emergencyAlertTriggeredAt = null;
      meetup.lastUpdateNote = toStr(noteData) || `Meetup extended by ${addMinutes} minutes`;
      meetup.lastUpdateAt = new Date();
      realtimeEvent = "meetup_extended";
    }

    await wixData.update("SafeMeetLogs", meetup, { suppressAuth: true });
    if (realtimeEvent) {
      try {
        await publish({ name: "meetily-watch-updates", resourceId: meetup.userPhone || "global" }, {
          event: realtimeEvent,
          meetupId: meetup._id,
          userPhone: meetup.userPhone || "",
          fpcPhone: meetup.fpcPhone || "",
          occurredAt: new Date().toISOString(),
          note: meetup.lastUpdateNote || ""
        });
      } catch (_) {
        // ignore realtime failures
      }
    }
    return apiCors({ status: "success" });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

/* ------------------------ SAFEMEET ADMIN DATA API ------------------------ */

export async function get_apiAdminMeetilyCollections(request) {
  try {
    const providedKey = toStr(
      request?.query?.adminKey ||
      request?.headers?.["x-admin-key"] ||
      request?.headers?.["X-Admin-Key"]
    );
    let expectedKey = "";
    try {
      expectedKey = toStr(await getSecret("MEETILY_ADMIN_KEY"));
    } catch (_) {
      expectedKey = "";
    }
    if (expectedKey && providedKey !== expectedKey) {
      return unauthorized({ body: { status: "error", message: "Unauthorized admin access" } });
    }

    const usersLimit = Math.min(1000, Math.max(1, toNum(request?.query?.usersLimit, 300)));
    const logsLimit = Math.min(1000, Math.max(1, toNum(request?.query?.logsLimit, 500)));
    const depositsLimit = Math.min(1000, Math.max(1, toNum(request?.query?.depositsLimit, 1000)));
    const nowMs = Date.now();

    const [usersRes, logsRes, depositsRes] = await Promise.all([
      wixData.query("SafeMeetUsers")
        .descending("_createdDate")
        .limit(usersLimit)
        .find({ suppressAuth: true }),
      wixData.query("SafeMeetLogs")
        .descending("_createdDate")
        .limit(logsLimit)
        .find({ suppressAuth: true }),
      wixData.query("SafeMeetDeposits")
        .descending("timestamp")
        .limit(depositsLimit)
        .find({ suppressAuth: true })
    ]);

    const users = (usersRes.items || []).map((u) => ({
      _id: u._id,
      phone: u.phone,
      fullName: u.fullName,
      virtualAccountNumber: u.virtualAccountNumber,
      isPaid: !!u.isPaid,
      package: u.package || "Free",
      paidTotal: toNum(u.paidTotal, 0),
      lastPaymentAmount: toNum(u.lastPaymentAmount, 0),
      lastPaymentDate: u.lastPaymentDate || null,
      fpcName: u.fpcName || "",
      fpcPhone: u.fpcPhone || "",
      fpcRelation: u.fpcRelation || "",
      fpcPriority: u.fpcPriority || "",
      createdDate: u.createdDate || u._createdDate || null,
      updatedAt: u.updatedAt || u._updatedDate || null
    }));

    const logs = (logsRes.items || []).map((m) => {
      const status = toStr(m.status);
      const expectedEndAtMs = m.expectedEndAt ? new Date(m.expectedEndAt).getTime() : 0;
      const graceEndsAtMs = m.graceEndsAt ? new Date(m.graceEndsAt).getTime() : 0;
      const expiresAt = m.expiresAt ? new Date(m.expiresAt).getTime() : 0;
      const endedAt = m.endedAt ? new Date(m.endedAt).getTime() : 0;
      let lifecycle = "UNKNOWN";
      if (status === "SAFE" || endedAt) lifecycle = "ENDED_BY_USER";
      else if (m.emergencyAlertTriggeredAt) lifecycle = "EMERGENCY_TRIGGERED";
      else if (status === "ACTIVE_WATCH" && graceEndsAtMs && graceEndsAtMs <= nowMs) lifecycle = "ALERT_DUE";
      else if (status === "ACTIVE_WATCH" && expectedEndAtMs && expectedEndAtMs <= nowMs) lifecycle = "GRACE_PERIOD";
      else if (status === "ACTIVE_WATCH" && expiresAt && expiresAt < nowMs) lifecycle = "OVERDUE_48H";
      else if (status === "ACTIVE_WATCH") lifecycle = "ACTIVE";

      return {
        _id: m._id,
        userPhone: m.userPhone,
        selectedPackage: m.selectedPackage,
        packageType: m.packageType || "",
        packageWindow: m.packageWindow || "",
        packageRank: toNum(m.packageRank, 0),
        status: status || "-",
        lifecycle,
        fullName: m.fullName || "",
        placeType: m.placeType || "",
        address: m.address || "",
        state: m.state || "",
        lga: m.lga || "",
        lastGps: m.lastGps || "",
        lastGpsAt: m.lastGpsAt || null,
        lastUpdateNote: m.lastUpdateNote || "",
        paymentTxId: m.paymentTxId || "",
        paymentAmount: toNum(m.paymentAmount, 0),
        paymentAt: m.paymentAt || null,
        createdAt: m._createdDate || null,
        updatedAt: m._updatedDate || null,
        expectedDurationMinutes: toNum(m.expectedDurationMinutes, 0),
        graceMinutes: toNum(m.graceMinutes, 0),
        expectedEndAt: m.expectedEndAt || null,
        graceEndsAt: m.graceEndsAt || null,
        welfareCheckAt: m.welfareCheckAt || null,
        reminderLeadSentAt: m.reminderLeadSentAt || null,
        reminderDeadlineSentAt: m.reminderDeadlineSentAt || null,
        emergencyAlertTriggeredAt: m.emergencyAlertTriggeredAt || null,
        expiresAt: m.expiresAt || null,
        endedAt: m.endedAt || null
      };
    });

    const deposits = (depositsRes.items || []).map((d) => ({
      _id: d._id,
      timestamp: d.timestamp || d._createdDate || null,
      transactionId: d.transactionId || "",
      virtualAccountNumber: d.virtualAccountNumber || "",
      amount: toNum(d.amount, 0),
      senderName: d.senderName || "",
      sourceBank: d.sourceBank || ""
    }));

    const summary = {
      usersTotal: users.length,
      paidUsers: users.filter((u) => u.isPaid).length,
      usersUnpaid: users.filter((u) => !u.isPaid).length,
      meetupsTotal: logs.length,
      activeMeetups: logs.filter((m) => m.lifecycle === "ACTIVE").length,
      overdueMeetups48h: logs.filter((m) => m.lifecycle === "OVERDUE_48H" || m.lifecycle === "ALERT_DUE" || m.lifecycle === "EMERGENCY_TRIGGERED").length,
      endedMeetups: logs.filter((m) => m.lifecycle === "ENDED_BY_USER").length,
      depositsTotal: deposits.length,
      depositsAmountTotal: deposits.reduce((acc, d) => acc + toNum(d.amount, 0), 0)
    };

    return apiCors({
      status: "success",
      fetchedAt: new Date().toISOString(),
      limits: { usersLimit, logsLimit, depositsLimit },
      summary,
      users,
      meetups: logs,
      deposits
    });
  } catch (err) {
    return apiCors({ status: "error", message: err.message }, 500);
  }
}

/* ------------------------ APP APIs (Existing) ------------------------ */

export async function get_apiCheckUser(request) {
  const { query } = request;
  const result = await checkUserExists(query.field, query.value);
  return apiCors(result);
}

export async function post_apiSignup(request) {
  try {
    const payload = await request.body.json();
    const result = await createUser(payload);
    return apiCors(result);
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 400);
  }
}

export async function post_apiLogin(request) {
  try {
    const payload = await request.body.json();
    const result = await loginUser(payload.phone, payload.pin);
    return apiCors(result);
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 400);
  }
}

export async function get_apiUpdates(request) {
  const phone = request.query.phone;
  const result = await getUpdates(phone);
  return apiCors(result);
}

export async function post_apiWithdraw(request) {
  try {
    const payload = await request.body.json();
    const result = await processWithdrawal(payload);
    return apiCors(result);
  } catch (err) {
    return apiCors({ success: false, message: err.message }, 400);
  }
}

export async function get_apiPartnerStats(request) {
  try {
    const phonesRaw = String(request.query.phones || '');
    const phones = phonesRaw.split(',').map(normalizePhone).filter(p => p.length === 11);

    if (!phones.length) {
      return apiCors({
        success: true,
        totals: { couples: 0, totalBalance: 0, totalWithdrawn: 0 },
        recent: []
      });
    }

    let totalBalance = 0;
    let totalWithdrawn = 0;
    const recent = [];

    for (const phone of phones) {
      const u = await getUpdates(phone);
      if (!u?.success || !u?.user) continue;

      totalBalance += Number(u.user.balance || 0);

      const hist = Array.isArray(u.history) ? u.history : [];
      for (const row of hist) {
        if (!isWithdrawalRow(row)) continue;
        const wAmt = getWithdrawalAmount(row);
        if (wAmt > 0) totalWithdrawn += wAmt;

        if (recent.length < 25) {
          recent.push({
            phone,
            type: 'withdrawal',
            amount: wAmt,
            date: row?.date || row?._createdDate || new Date(),
            title: row?.title || row?.description || 'Withdrawal'
          });
        }
      }
    }

    recent.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return apiCors({
      success: true,
      totals: { couples: phones.length, totalBalance, totalWithdrawn },
      recent: recent.slice(0, 12)
    });
  } catch (err) {
    console.error('apiPartnerStats error:', err);
    return apiCors({ success: false, message: 'Partner stats failed' }, 500);
  }
}

/* ------------------------ A3 INTERNET APIs ------------------------ */

export async function get_getVirtualAccount(request) {
  const macRaw = request.query.mac;
  const mac = normalizeMac(macRaw);
  if (!mac) return apiCors({ error: 'MAC Required' }, 400);

  try {
    const existingUser = await wixData.query('InternetUsers')
      .eq('title', mac)
      .limit(1)
      .find({ suppressAuth: true });

    if (existingUser.items.length > 0) {
      const user = existingUser.items[0];
      return apiCors({
        account_number: user.virtualAccountNumber,
        bank_name: 'Stanbic IBTC Bank',
        account_name: user.accountName || 'A3 Internet User'
      });
    }

    const newAccountNumber = await generateNewBankAccount();

    const newUser = {
      title: mac,
      virtualAccountNumber: String(newAccountNumber),
      accountName: 'A3 Internet User',
      lastPaymentDate: null,
      routerSynced: false
    };

    await wixData.insert('InternetUsers', newUser, { suppressAuth: true });

    return apiCors({
      account_number: String(newAccountNumber),
      bank_name: 'Stanbic IBTC Bank',
      account_name: 'A3 Internet User'
    });
  } catch (error) {
    console.error('Internet User Error:', error);
    return apiCors({ error: 'System Error' }, 500);
  }
}

export async function get_checkPaymentStatus(request) {
  const mac = normalizeMac(request.query.mac);
  if (!mac) return apiCors({ paid: false });

  try {
    const tenMinutesAgo = new Date(Date.now() - 1000 * 60 * 10);
    const recentPayment = await wixData.query('InternetDeposits')
      .eq('macAddress', mac)
      .gt('timestamp', tenMinutesAgo)
      .limit(1)
      .find({ suppressAuth: true });

    return apiCors({ paid: recentPayment.totalCount > 0 });
  } catch (error) {
    return apiCors({ error: error.message, paid: false }, 500);
  }
}

export async function get_getNewPaidUsers() {
  const responseObj = {
    headers: { "Content-Type": "application/json" }
  };

  try {
    const results = await wixData.query("InternetUsers")
      .ne("routerSynced", true)
      .limit(50)
      .find({ suppressAuth: true });

    const users = results.items.map(item => {
      let amount = Number(item.lastPaymentAmount);
      if (isNaN(amount) || amount <= 0) return null;

      let blocks = Math.floor(amount / 500);
      let remainder = amount % 500;
      let remainderMinutes = Math.floor(remainder * 0.6);
      let totalMinutes = (blocks * 1440) + remainderMinutes;

      let h = Math.floor(totalMinutes / 60);
      let m = totalMinutes % 60;
      let limitString = `${h}h${m}m`;

      if (totalMinutes < 1) return null;

      return {
        mac: normalizeMac(item.title).replace(/:/g, ''),
        limit: limitString,
        _id: item._id
      };
    }).filter(u => u !== null);

    if (results.items.length > 0) {
      const toUpdate = results.items.map(item => {
        item.routerSynced = true;
        item.routerSyncedAt = new Date();
        return item;
      });
      await wixData.bulkUpdate("InternetUsers", toUpdate, { suppressAuth: true });
    }

    responseObj.body = { users };
    return ok(responseObj);
  } catch (err) {
    console.error("getNewPaidUsers Error:", err);
    responseObj.body = { error: err.message };
    return serverError(responseObj);
  }
}

export async function post_postSyncPaidUsers() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const res = await wixData.query('InternetUsers')
      .gt('lastPaymentDate', oneDayAgo)
      .ne('routerSynced', true)
      .limit(100)
      .find({ suppressAuth: true });

    const users = res.items
      .map(item => ({ _id: item._id, mac: normalizeMac(item.title) }))
      .filter(x => x.mac);

    for (const item of res.items) {
      item.routerSynced = true;
      item.routerSyncedAt = new Date();
      await wixData.update('InternetUsers', item, { suppressAuth: true });
    }

    return apiCors({ users });
  } catch (error) {
    return apiCors({ error: error.message, users: [] }, 500);
  }
}

/* ------------------------ OPTIONS HANDLERS (CORS) ------------------------ */
export function options_apiSafeMeetSignup() { return apiCors(); }
export function options_apiSafeMeetLogin() { return apiCors(); }
export function options_apiSafeMeetStatus() { return apiCors(); }
export function options_apiPollInfluencerSignup() { return apiCors(); }
export function options_apiPollInfluencerStatus() { return apiCors(); }
export function options_apiPollInfluencerReferrals() { return apiCors(); }
export function options_apiUpdateProfile() { return apiCors(); }

export function options_apiAdminMeetilyCollections() { return apiCors(); }
export function options_apiCanCreateMeetup() { return apiCors(); }
export function options_apiCreateMeetup() { return apiCors(); }
export function options_apiEndMeetup() { return apiCors(); }
export function options_apiGetActiveMeetup() { return apiCors(); }
export function options_apiUpdateMeetup() { return apiCors(); }

export function options_apiSignup() { return apiCors(); }
export function options_apiLogin() { return apiCors(); }
export function options_apiWithdraw() { return apiCors(); }
export function options_apiCheckUser() { return apiCors(); }
export function options_apiUpdates() { return apiCors(); }
export function options_apiPartnerStats() { return apiCors(); }

export function options_getVirtualAccount() { return apiCors(); }
export function options_checkPaymentStatus() { return apiCors(); }
export function options_getNewPaidUsers() { return apiCors(); }
export function options_postSyncPaidUsers() { return apiCors(); }

/* ------------------------ UTILS ------------------------ */

function isWithdrawalRow(row) {
  const t = String(row?.type || row?.action || row?.kind || '').toLowerCase();
  const desc = String(row?.description || row?.title || '').toLowerCase();
  if (t.includes('withdraw')) return true;
  if (desc.includes('withdraw')) return true;
  if (t === 'debit') return true;
  const amt = Number(row?.amount ?? row?.withdrawnAmount ?? 0);
  return amt < 0;
}

function getWithdrawalAmount(row) {
  const amt = Number(row?.amount ?? row?.withdrawnAmount ?? row?.debitAmount ?? 0);
  return Math.abs(amt);
}

async function generateNewBankAccount() {
  for (let i = 0; i < 24; i += 1) {
    const seed = Math.floor(100000 + Math.random() * 900000);
    const account = `5770${seed}`;
    const exists = await wixData.query('InternetUsers')
      .eq('virtualAccountNumber', account)
      .limit(1)
      .find({ suppressAuth: true });
    if (!exists.items.length) return account;
  }
  throw new Error("Could not generate unique internet virtual account");
}

export async function get_poolilyDebug(request) {
  try {
    const accountNumber = toStr(request.query.accountNumber);
    const config = await getPoolilySupabaseConfig();

    const user = await fetchPoolilyUserByWalletAccount(accountNumber);

    return apiCors({
      ok: true,
      hasUrl: !!config.url,
      hasServiceRoleKey: !!config.serviceRoleKey,
      hasGatewayUrl: !!config.gatewayUrl,
      accountNumber,
      user
    });
  } catch (err) {
    return apiCors({
      ok: false,
      message: err.message,
      stack: String(err.stack || '')
    }, 500);
  }
}
