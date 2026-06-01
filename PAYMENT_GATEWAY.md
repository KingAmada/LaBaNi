# LaBaNi Stanbic Gateway

The frontend reserves tickets first, then shows a unique Stanbic IBTC virtual account for the booking.

## Supabase Edge Functions

- Name enquiry: `https://acqypknpiqxtavzjqhpo.supabase.co/functions/v1/stanbic-name-enquiry`
- Payment notifications: `https://acqypknpiqxtavzjqhpo.supabase.co/functions/v1/stanbic-notifications`

Deploy both functions with JWT verification disabled because Stanbic calls them directly:

```bash
supabase functions deploy stanbic-name-enquiry --project-ref acqypknpiqxtavzjqhpo --no-verify-jwt
supabase functions deploy stanbic-notifications --project-ref acqypknpiqxtavzjqhpo --no-verify-jwt
```

## Required Function Secrets

Set these in Supabase before going live:

```bash
supabase secrets set --project-ref acqypknpiqxtavzjqhpo \
  STANBIC_PROVIDER_ID='...' \
  STANBIC_PROVIDER_SECRET='...' \
  STANBIC_WEBHOOK_KEY='...' \
  SUPABASE_SERVICE_ROLE_KEY='...'
```

`SUPABASE_SERVICE_ROLE_KEY` must stay server-side only. Do not add it to `index.html`.

## Gateway Contract

Stanbic name enquiry should send `provider_id` and `provider_secret` headers, plus JSON containing `requestId` and `accountNumber`.

Stanbic notifications should send `x-stanbic-signature` as an HMAC-SHA256 signature of the raw request body using `STANBIC_WEBHOOK_KEY`. The function accepts either one transaction object or an array of transaction objects.
