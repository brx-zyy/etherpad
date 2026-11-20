'use strict';

import http from 'node:http';
import {chromium} from '@playwright/test';
import settings from '../../../../node/utils/Settings';

const assert = require('assert').strict;
const common = require('../../common');

describe('admin settings browser CSWSH', function () {
  this.timeout(60000);

  // This is deliberately an opt-in integration test. The ordinary backend
  // suite does not install Chromium; the dedicated workflow below sets this.
  if (process.env.RUN_CWSH_BROWSER_TEST !== '1') {
    it.skip('requires the dedicated Chromium workflow', function () {});
    return;
  }

  let agent: any;
  let browser: any;
  let attackerServer: http.Server;
  let attackerPort: number;
  let backups: any;

  const targetHost = 'pad.etherpad.test';
  const sameSiteAttackerHost = 'evil.etherpad.test';
  const crossSiteAttackerHost = 'attacker.invalid';

  before(async function () {
    agent = await common.init();
    backups = {
      users: settings.users,
      requireAuthentication: settings.requireAuthentication,
      requireAuthorization: settings.requireAuthorization,
      showSettingsInAdminPage: settings.showSettingsInAdminPage,
      sameSite: settings.cookie.sameSite,
    };
    settings.users = {
      admin: {password: 'temporary-test-password', is_admin: true},
    };
    settings.requireAuthentication = true;
    settings.requireAuthorization = false;
    settings.showSettingsInAdminPage = true;
    // The default production setting. Sibling subdomains remain same-site
    // even though their origins differ.
    settings.cookie.sameSite = 'lax';

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--host-resolver-rules=MAP *.etherpad.test 127.0.0.1,MAP attacker.invalid 127.0.0.1',
      ],
    });

    attackerServer = http.createServer((_req, res) => {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><html><body>controlled attacker origin</body></html>');
    });
    await new Promise<void>((resolve) => attackerServer.listen(0, '127.0.0.1', resolve));
    attackerPort = (attackerServer.address() as any).port;
  });

  after(async function () {
    if (browser) await browser.close();
    if (attackerServer) await new Promise<void>((resolve) => attackerServer.close(() => resolve()));
    if (backups) {
      settings.users = backups.users;
      settings.requireAuthentication = backups.requireAuthentication;
      settings.requireAuthorization = backups.requireAuthorization;
      settings.showSettingsInAdminPage = backups.showSettingsInAdminPage;
      settings.cookie.sameSite = backups.sameSite;
    }
  });

  it('allows a same-site sibling origin to read admin settings over WebSocket, while Lax blocks an unrelated site', async function () {
    const auth = await agent.get('/admin-auth/')
        .auth('admin', 'temporary-test-password')
        .expect(200);
    const setCookies = auth.headers['set-cookie'] || [];
    assert(setCookies.length > 0, 'admin authentication must issue a session cookie');

    const target = new URL(common.baseUrl);
    target.hostname = targetHost;
    const targetOrigin = target.origin;

    const context = await browser.newContext();
    try {
      // Recreate the host-only Lax cookie that the browser receives from the
      // target origin's Basic-auth session endpoint.
      for (const raw of setCookies) {
        const pair = raw.split(';', 1)[0];
        const separator = pair.indexOf('=');
        assert(separator > 0, 'expected a well-formed session cookie');
        await context.addCookies([{
          name: pair.slice(0, separator),
          value: pair.slice(separator + 1),
          domain: targetHost,
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        }]);
      }

      const runAttack = async (attackerHost: string, expectDisclosure: boolean) => {
        const page = await context.newPage();
        try {
          await page.goto(`http://${attackerHost}:${attackerPort}/`);
          await page.addScriptTag({url: `${targetOrigin}/socket.io/socket.io.js`});
          const result = await page.evaluate(({targetOrigin}) => new Promise((resolve) => {
            const socket = (window as any).io(`${targetOrigin}/settings`, {
              transports: ['websocket'],
              upgrade: false,
              timeout: 8000,
              reconnection: false,
            });
            let finished = false;
            const finish = (value: any) => {
              if (finished) return;
              finished = true;
              socket.disconnect();
              resolve(value);
            };
            socket.on('connect', () => socket.emit('load', ''));
            socket.on('settings', (data: any) => finish({
              disclosed: typeof data?.results === 'string',
              resultLength: typeof data?.results === 'string' ? data.results.length : 0,
            }));
            socket.on('admin_auth_error', () => finish({disclosed: false, adminAuthError: true}));
            socket.on('connect_error', (error: any) => finish({
              disclosed: false,
              connectError: String(error?.message || error),
            }));
            setTimeout(() => finish({disclosed: false, timedOut: true}), 10000);
          }), {targetOrigin});
          assert.equal(result.disclosed, expectDisclosure,
              `unexpected browser result from ${attackerHost}: ${JSON.stringify(result)}`);
          return result;
        } finally {
          await page.close();
        }
      };

      const siblingResult = await runAttack(sameSiteAttackerHost, true);
      assert(siblingResult.resultLength > 0, 'the attacker page should receive non-empty settings data');

      const unrelatedResult = await runAttack(crossSiteAttackerHost, false);
      assert.equal(unrelatedResult.disclosed, false);
    } finally {
      await context.close();
    }
  });
});
