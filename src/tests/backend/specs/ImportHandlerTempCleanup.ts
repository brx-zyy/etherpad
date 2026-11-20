'use strict';

import os from 'node:os';
import {promises as fs} from 'node:fs';
import settings from '../../../node/utils/Settings';

const assert = require('assert').strict;
const common = require('../common');
const padManager = require('../../../node/db/PadManager');

describe(__filename, function () {
  this.timeout(30000);

  let agent: any;
  let padId: string;
  let pad: any;

  before(async function () {
    agent = await common.init();
  });

  afterEach(async function () {
    if (pad != null) {
      await pad.remove();
      pad = null;
    }
  });

  it('reproduces a rejected PDF upload remaining in os.tmpdir()', async function () {
    // The default test configuration has no LibreOffice converter, so PDF
    // imports are rejected only after Formidable has written the upload.
    assert.equal(settings.soffice, null);
    padId = common.randomString(10);
    pad = await padManager.getPad(padId, '\\n');

    const marker = Buffer.from('etherpad-import-temp-leak-proof');
    const before = new Set(await fs.readdir(os.tmpdir()));
    const response = await agent.post(`/p/${padId}/import`)
        .attach('file', marker, 'probe.pdf');

    assert.equal(response.status, 400);
    assert.equal(response.body.message, 'uploadFailed');

    const after = await fs.readdir(os.tmpdir());
    const newPaths = after.filter((name) => !before.has(name));
    const matching = [];
    for (const name of newPaths) {
      const fullPath = `${os.tmpdir()}/${name}`;
      try {
        if ((await fs.readFile(fullPath)).equals(marker)) matching.push(fullPath);
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    try {
      assert.equal(matching.length, 1,
          'expected the rejected PDF upload to remain as one temp file');
      assert.equal((await fs.readFile(matching[0])).toString(), marker.toString());
    } finally {
      // Keep the test self-cleaning even though the vulnerability is expected.
      await Promise.all(matching.map((file) => fs.unlink(file).catch(() => {})));
    }
  });
});
