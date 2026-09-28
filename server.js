// server.js - serves the static Palm Beach Placements site and adds a
// small Stripe backend: Checkout (deposits on Starter/Growth), Invoicing
// (remaining balance, Enterprise, or anything ad hoc), and Stripe Tax on
// both. Enterprise stays "Contact Us" only - it's bespoke pricing with no
// fixed amount, so there is nothing to self-serve checkout.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Constructed lazily so a missing key fails only the payment routes below,
// not the whole process - the static marketing site must stay up even if
// Stripe isn't configured yet.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PORT = process.env.PORT || 4000;
const SITE_URL = process.env.SITE_URL || 'https://palmbeachplacements.com';

// Deposit is 50% of the placement fee, due to start the search; the
// remaining balance goes out as a Stripe Invoice once a placement is made.
// Change these two numbers if the actual deposit policy differs - nothing
// else in this file needs to know about it.
const PACKAGES = {
  starter: { label: 'Starter Placement', totalCents: 500000, depositCents: 250000 },
  growth: { label: 'Growth Placement', totalCents: 950000, depositCents: 475000 },
};

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'Server missing ADMIN_TOKEN configuration.' });
  }
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Missing or invalid x-admin-token.' });
  }
  next();
}

function mailer() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function notifyOwner(subject, text) {
  const transporter = mailer();
  if (!transporter) return;
  const to = process.env.OWNER_EMAIL || process.env.MAIL_FROM;
  if (!to) return;
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

// ─── Stripe webhook - needs the raw body, so this is registered before
// the global express.json() below ever touches the request ────────────────
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'STRIPE_SECRET_KEY not configured.' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret)
      : JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[webhook] signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      await notifyOwner(
        'Deposit received - Palm Beach Placements',
        `A deposit checkout completed.\n\nCustomer: ${s.customer_details?.email || 'unknown'}\nTier: ${s.metadata?.tier || 'unknown'}\nAmount paid: $${(s.amount_total / 100).toFixed(2)}\nStripe Checkout Session: ${s.id}`
      );
    } else if (event.type === 'invoice.paid') {
      const inv = event.data.object;
      await notifyOwner(
        'Invoice paid - Palm Beach Placements',
        `An invoice was paid.\n\nCustomer: ${inv.customer_email || 'unknown'}\nAmount: $${(inv.amount_paid / 100).toFixed(2)}\nInvoice: ${inv.id}`
      );
    }
  } catch (e) {
    // Never fail the webhook ack over a notification email problem - Stripe
    // will retry the whole webhook otherwise, and the payment already went
    // through regardless of whether the email sends.
    console.error('[webhook] notify failed:', e.message);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(__dirname));

// ─── Client-facing: start a deposit checkout for Starter or Growth ────────
app.post('/api/checkout/:tier', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'STRIPE_SECRET_KEY not configured.' });
  const pkg = PACKAGES[req.params.tier];
  if (!pkg) return res.status(404).json({ error: 'Unknown package.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_creation: 'always',
      customer_email: req.body?.email || undefined,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${pkg.label} - Deposit`,
            description: `50% deposit toward the ${pkg.label} flat fee ($${(pkg.totalCents / 100).toLocaleString()} total). Remaining balance is invoiced separately once a placement is made.`,
          },
          unit_amount: pkg.depositCents,
        },
        quantity: 1,
      }],
      metadata: { tier: req.params.tier },
      success_url: `${SITE_URL}/checkout-success.html`,
      cancel_url: `${SITE_URL}/checkout-cancel.html`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[checkout] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: create and send an invoice (remaining balance, Enterprise,
// or anything ad hoc) ───────────────────────────────────────────────────
app.post('/api/admin/create-invoice', requireAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'STRIPE_SECRET_KEY not configured.' });
  const { email, name, description, amountCents, daysUntilDue } = req.body || {};
  if (!email || !description || !amountCents) {
    return res.status(400).json({ error: 'email, description, and amountCents are required.' });
  }

  try {
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({ email, name });

    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: amountCents,
      currency: 'usd',
      description,
    });

    const invoice = await stripe.invoices.create({
      customer: customer.id,
      automatic_tax: { enabled: true },
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue || 14,
    });
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalized.id);

    res.json({ ok: true, invoiceId: finalized.id, hostedInvoiceUrl: finalized.hosted_invoice_url });
  } catch (e) {
    console.error('[create-invoice] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Palm Beach Placements listening on ${PORT}`));
