'use strict';

const assert = require('assert').strict;
const JSZip = require('jszip');

describe(__filename, function () {
  this.timeout(30000);

  it('shows document.xml can expand far beyond the uploaded DOCX size', async function () {
    // Keep this deliberately modest for CI. The import endpoint accepts 50 MiB,
    // while this fixture expands from a few KiB to 8 MiB.
    const expandedSize = 8 * 1024 * 1024;
    const xml = '<w:document><w:body>' + 'A'.repeat(expandedSize) + '</w:body></w:document>';

    const zip = new JSZip();
    zip.file('word/document.xml', xml);
    const uploadedBytes = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {level: 9},
    });

    const loaded = await JSZip.loadAsync(uploadedBytes);
    const expandedXml = await loaded.file('word/document.xml').async('text');

    assert.equal(expandedXml, xml);
    assert(uploadedBytes.length < expandedSize / 100,
        'expected more than 100x expansion; got ' + expandedSize / uploadedBytes.length + 'x');
  });
});
