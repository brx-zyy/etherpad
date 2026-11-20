'use strict';

import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import settings from '../../../node/utils/Settings';

const assert = require('assert').strict;
const common = require('../common');
const padManager = require('../../../node/db/PadManager');

describe(__filename, function () {
  this.timeout(30000);

  let agent: any;
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

  const findNewFilesWithContent = async (before: Set<string>, marker: Buffer) => {
    const after = await fs.readdir(os.tmpdir());
    const matching = [];
    for (const name of after.filter((entry) => !before.has(entry))) {
      const fullPath = path.join(os.tmpdir(), name);
      try {
        if ((await fs.readFile(fullPath)).equals(marker)) matching.push(fullPath);
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return matching;
  };

  const assertAndCleanLeakedFile = async (before: Set<string>, marker: Buffer) => {
    const matching = await findNewFilesWithContent(before, marker);
    try {
      assert.equal(matching.length, 1,
          'expected the uploaded bytes to remain as one temp file');
      assert.equal((await fs.readFile(matching[0])).toString(), marker.toString());
    } finally {
      await Promise.all(matching.map((file) => fs.unlink(file).catch(() => {})));
    }
  };

  it('leaves a rejected PDF upload in os.tmpdir()', async function () {
    assert.equal(settings.soffice, null);
    const padId = common.randomString(10);
    pad = await padManager.getPad(padId, '\n');

    const marker = Buffer.from('etherpad-import-temp-leak-proof-pdf');
    const before = new Set(await fs.readdir(os.tmpdir()));
    const response = await agent.post('/p/' + padId + '/import')
        .attach('file', marker, 'probe.pdf');

    assert.equal(response.status, 400);
    assert.equal(response.body.message, 'uploadFailed');
    await assertAndCleanLeakedFile(before, marker);
  });

  it('leaves a successfully imported .etherpad upload in os.tmpdir()', async function () {
    const padId = common.randomString(10);
    pad = await padManager.getPad(padId, '\n');
    const authorId = 'a.' + common.randomString(16);
    const pool = {numToAttrib: {}, nextNum: 0};
    const atext = {text: 'foo\n', attribs: '|1+4'};
    const payload = Buffer.from(JSON.stringify({
      'pad:testing': {atext, pool, head: 0, savedRevisions: []},
      ['globalAuthor:' + authorId]: {
        colorId: '#000000',
        name: 'new',
        timestamp: 1598747784631,
        padIDs: 'testing',
      },
      'pad:testing:revs:0': {
        changeset: 'Z:1>3+3$foo',
        meta: {
          author: '',
          timestamp: 1597632398288,
          pool,
          atext,
        },
      },
    }));

    const before = new Set(await fs.readdir(os.tmpdir()));
    const response = await agent.post('/p/' + padId + '/import')
        .attach('file', payload, 'probe.etherpad');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.directDatabaseAccess, true);
    await assertAndCleanLeakedFile(before, payload);
  });
});
