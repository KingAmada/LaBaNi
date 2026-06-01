# LaBaNi Peygo Payment Gateway

LaBaNi should not be a direct Stanbic endpoint. Stanbic continues to call Peygo/Wix, and LaBaNi only talks to Peygo.

## Flow

1. LaBaNi checkout calls Peygo:
   `POST {PEYGO_DOMAIN}/_functions/apiLabaniCreateBooking`
2. Peygo creates a LaBaNi booking in Wix, generates the `5770...` virtual account, and syncs pending tickets to Supabase.
3. Stanbic name enquiry keeps calling Peygo's existing `post_stanbicNameEnquiry`.
4. Peygo resolves LaBaNi accounts from `LabaniBookings`.
5. Stanbic payment notifications keep calling Peygo's existing `post_stanbicNotifications`.
6. Peygo records the deposit in `LabaniDeposits`, updates `LabaniBookings`, and syncs paid ticket status back to Supabase.
7. The LaBaNi frontend refreshes ticket status from Supabase.

## Frontend Config

In [index.html](/Users/mac/Downloads/Labani/index.html), replace this placeholder with the actual Peygo Wix functions domain:

```js
const PEYGO_FUNCTIONS_BASE_URL = (window.LABANI_PEYGO_FUNCTIONS_BASE_URL || localStorage.getItem('labani_peygo_functions_base_url') || 'https://YOUR-PEYGO-WIX-DOMAIN/_functions').replace(/\/$/, '');
```

Example shape:

```js
const PEYGO_FUNCTIONS_BASE_URL = 'https://your-peygo-site.com/_functions';
```

## Peygo/Wix Backend

Paste [peygo-labani-http-functions-snippet.js](/Users/mac/Downloads/Labani/peygo-labani-http-functions-snippet.js) into Peygo's existing `http-functions.js`.

Create these Wix Data collections:

- `LabaniBookings`
- `LabaniDeposits`

Add the two integration branches at the bottom of the snippet into the existing:

- `post_stanbicNameEnquiry`
- `post_stanbicNotifications`

## Peygo Secrets

Set these in Wix Secrets Manager:

- `LABANI_SUPABASE_URL`
- `LABANI_SUPABASE_SERVICE_ROLE_KEY`

If omitted, the snippet falls back to the shared `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets.

## Retire Direct Supabase Stanbic Functions

The previously deployed Supabase functions are no longer the intended flow. Remove them from Supabase when ready:

```bash
supabase functions delete stanbic-name-enquiry --project-ref acqypknpiqxtavzjqhpo
supabase functions delete stanbic-notifications --project-ref acqypknpiqxtavzjqhpo
```
