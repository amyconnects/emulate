/**
 * Seeding a pinned organization id. Application databases store WorkOS org ids as
 * foreign keys — regenerating them on every emulator boot breaks that join. The seed
 * file already lets you pin client_id / client_secret / API keys; organizations get
 * the same courtesy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEmulator, type Emulator } from '../index.js';
import { getWorkOSStore } from './store.js';
import { validateSeedConfig } from './config-validator.js';

const PINNED_ORG_ID = 'org_01PINNEDACMECORPTEST';

interface ReceivedWebhook {
  id: string;
  event: string;
  data: Record<string, any>;
}

interface WebhookReceiver {
  url: string;
  received: ReceivedWebhook[];
  close: () => Promise<void>;
}

function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const server: Server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', () => {
      received.push(JSON.parse(rawBody));
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/webhooks`,
        received,
        close: () => new Promise((res2, rej) => server.close((err) => (err ? rej(err) : res2()))),
      });
    });
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Seeding a pinned organization id', () => {
  let emulator: Emulator | undefined;
  let receiver: WebhookReceiver | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
    await receiver?.close();
    receiver = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  it('serves the pinned id from the API, login tokens, and webhooks', async () => {
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'admin@acme.com', password: 'secret', email_verified: true }],
        organizations: [
          {
            id: PINNED_ORG_ID,
            name: 'Acme Corp',
            memberships: [{ email: 'admin@acme.com', role: 'admin', status: 'active' }],
          },
        ],
      },
    });

    // API: the seeded organization is addressable by the pinned id.
    const getRes = await fetch(`${emulator.url}/organizations/${PINNED_ORG_ID}`, {
      headers: auth(emulator.apiKey),
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ id: PINNED_ORG_ID, name: 'Acme Corp' });

    // Login token: organization-selection scopes the session to the pinned id
    // (same grant AuthKit uses after password / OAuth when an org must be chosen).
    const user = getWorkOSStore(emulator.store).users.findOneBy('email', 'admin@acme.com')!;
    const pendingToken = 'pending_pinned_org_test';
    emulator.store.setData(`pending_auth:${pendingToken}`, {
      user_id: user.id,
      organization_id: null,
      auth_method: 'Password',
    });

    const selectRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:organization-selection',
        pending_authentication_token: pendingToken,
        organization_id: PINNED_ORG_ID,
      }),
    });
    expect(selectRes.status).toBe(200);
    const selected = (await selectRes.json()) as { access_token: string; organization_id: string };
    expect(selected.organization_id).toBe(PINNED_ORG_ID);
    expect(decodeJwtPayload(selected.access_token).org_id).toBe(PINNED_ORG_ID);

    // Webhooks: an update to the pinned org carries the same id in the payload.
    const cursor = receiver.received.length;
    const whRes = await fetch(`${emulator.url}/webhook_endpoints`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ endpoint_url: receiver.url, events: [] }),
    });
    expect(whRes.status).toBe(201);

    const putRes = await fetch(`${emulator.url}/organizations/${PINNED_ORG_ID}`, {
      method: 'PUT',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ name: 'Acme Corp Updated' }),
    });
    expect(putRes.status).toBe(200);

    const webhook = await vi.waitFor(
      () => {
        const hit = receiver!.received.slice(cursor).find((w) => w.event === 'organization.updated');
        if (!hit) {
          const seen =
            receiver!.received
              .slice(cursor)
              .map((w) => w.event)
              .join(', ') || '(none)';
          throw new Error(`no organization.updated webhook yet; saw: ${seen}`);
        }
        return hit;
      },
      { timeout: 3000, interval: 25 },
    );
    expect(webhook.data.id).toBe(PINNED_ORG_ID);
    expect(webhook.data.name).toBe('Acme Corp Updated');
  });

  describe('seed config validation', () => {
    const findError = (config: Parameters<typeof validateSeedConfig>[0], pathFragment: string) => {
      const { valid, errors } = validateSeedConfig(config);
      expect(valid).toBe(false);
      const error = errors.find((e) => e.path.includes(pathFragment));
      expect(error, `expected an error at ${pathFragment}, got: ${JSON.stringify(errors)}`).toBeDefined();
      return error!;
    };

    it('rejects two organizations pinning the same id', () => {
      const error = findError(
        {
          organizations: [
            { name: 'Acme', id: 'org_dup' },
            { name: 'Beta', id: 'org_dup' },
          ],
        },
        'organizations[1].id',
      );
      expect(error.message).toContain('unique');
    });

    it('rejects an empty organization id', () => {
      findError({ organizations: [{ name: 'Acme', id: '' }] }, 'organizations[0].id');
    });

    it('rejects a non-string organization id', () => {
      findError({ organizations: [{ name: 'Acme', id: 42 as never }] }, 'organizations[0].id');
    });

    it('accepts a pinned organization id', () => {
      const result = validateSeedConfig({
        organizations: [{ name: 'Acme', id: PINNED_ORG_ID }],
      });
      expect(result).toEqual({ valid: true, errors: [] });
    });
  });
});
