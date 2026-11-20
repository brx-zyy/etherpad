'use strict';

import settings from '../../../../node/utils/Settings';

const assert = require('assert').strict;
const io = require('socket.io-client');
const common = require('../../common');

describe(__filename, function () {
  this.timeout(15000);

  let agent: any;
  let backups: any;

  before(async function () {
    agent = await common.init();
  });

  beforeEach(function () {
    backups = {
      users: settings.users,
      requireAuthentication: settings.requireAuthentication,
      requireAuthorization: settings.requireAuthorization,
      showSettingsInAdminPage: settings.showSettingsInAdminPage,
    };
    settings.users = {
      admin: {password: 'temporary-test-password', is_admin: true},
    };
    settings.requireAuthentication = true;
    settings.requireAuthorization = false;
    settings.showSettingsInAdminPage = true;
  });

  afterEach(function () {
    Object.assign(settings, backups);
  });

  it('accepts an authenticated /settings socket carrying an untrusted Origin header', async function () {
    const response = await agent.get('/admin-auth/')
        .auth('admin', 'temporary-test-password')
        .expect(200);
    const setCookies = response.headers['set-cookie'] || [];
    assert(setCookies.length > 0, 'admin authentication must issue a session cookie');
    const cookieHeader = setCookies.map((cookie: string) => cookie.split(';', 1)[0]).join('; ');

    const socket = io(`${common.baseUrl}/settings`, {
      forceNew: true,
      transports: ['websocket'],
      extraHeaders: {
        Origin: 'https://attacker.invalid',
        Cookie: cookieHeader,
      },
    });

    try {
      const result = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for settings')), 8000);
        socket.once('connect_error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        socket.once('settings', (data: any) => {
          clearTimeout(timeout);
          resolve(data);
        });
        socket.once('connect', () => socket.emit('load', ''));
      });
      assert.equal(typeof result.results, 'string',
          'the authenticated settings socket should return settings data');
    } finally {
      socket.disconnect();
    }
  });
});
