'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru().noPreserveCache();
var path       = require('path');
var loader     = require('../helpers/cartridgeLoader');

var root = path.join(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/storeMigration');

/**
 * Store file naming with an IMPEX export folder that already holds some files.
 * @param {string[]} existing - file names already in the store export folder
 * @returns {Object} storeFileNaming
 */
function loadNaming(existing) {
    return proxyquire(path.join(root, 'storeFileNaming.js'), {
        '*/cartridge/scripts/migration/core/migrationFileResolver': {
            getRelativePath: function () { return 'src/migration/store'; },
            getRunDate:      function () { return '20261005'; },
            localFileExists: function (rel) {
                return (existing || []).some(function (f) { return 'src/migration/store/' + f === rel; });
            }
        }
    });
}

/**
 * Store runner over in-memory stores and channels; the XML lands in out.xml.
 * @param {Object[]} stores - source stores the fetcher returns
 * @param {Object} channels - channel id → channel
 * @returns {Object} { runner, out }
 */
function loadRunner(stores, channels) {
    var out = { xml: '' };
    var fetcher = proxyquire(path.join(root, 'ctpStoreFetcher.js'), {
        '*/cartridge/scripts/migration/core/http': {},
        '*/cartridge/scripts/migration/configAccessor': {},
        'dw/crypto/Encoding': {},
        'dw/util/Bytes': function () {}
    });
    fetcher.fetchChannelMap = function () { return channels; };
    fetcher.fetchBatch = function (offset) { return { results: offset === 0 ? stores : [], total: stores.length }; };
    var registry = {
        getFetcher:    function () { return fetcher; },
        getPlatformId: function () { return 'commercetools'; }
    };
    var transformer = proxyquire(path.join(root, 'storeTransformer.js'), {
        '*/cartridge/scripts/migration/core/dataSourceRegistry': registry,
        '*/cartridge/scripts/migration/core/attrIdMapSession': {
            read: function () { return {}; }, resolve: function (id) { return id; }, clear: function () {}, saveFromAttrs: function () {}
        },
        '*/cartridge/scripts/migration/configAccessor': { sfcc: { inventoryListId: 'migrated-inventory' } },
        'dw/catalog/ProductInventoryMgr': { getInventoryList: function () { return null; } }
    });
    loader.installCartridgeResolver();
    var runner = proxyquire(path.join(root, 'fullMigrationRunner.js'), {
        '*/cartridge/scripts/migration/core/dataSourceRegistry': registry,
        '*/cartridge/scripts/migration/storeMigration/storeTransformer': transformer,
        '*/cartridge/scripts/migration/storeMigration/storeXmlBuilder': loader.requireCartridge('storeMigration/storeXmlBuilder'),
        '*/cartridge/scripts/migration/storeMigration/webDavUploader': {
            ensureDirectory: function () { return { ok: true }; },
            uploadLocalFile: function () { return { ok: true }; }
        },
        '*/cartridge/scripts/migration/core/migrationFileResolver': {
            getRelativePath: function () { return 'src/migration/store'; },
            getRunDate:      function () { return '20261005'; }
        },
        '*/cartridge/scripts/migration/storeMigration/storeFileNaming': loadNaming([]),
        '*/cartridge/scripts/migration/core/impexStreamWriter': {
            openWriter:  function () { return { writer: { write: function (s) { out.xml += s; } } }; },
            closeWriter: function () {}
        }
    });
    return { runner: runner, out: out };
}

var shop = { id: 'a1', key: 'ny-store', name: { en: 'New York Store' }, custom: { fields: { city: 'New York', country: 'US' } } };
var region = { id: 'b2', key: 'eu-store', name: { en: 'EU Store' } };

describe('store fullMigrationRunner', function () {
    it('exports only the stores set to Physical and counts the online ones', function () {
        var env = loadRunner([shop, region], {});
        var res = env.runner.runBatch(0, 'full', 'store-full-20261005-v001.xml', ['ny-store', 'eu-store'], true,
            { types: { 'ny-store': 'physical', 'eu-store': 'online' } });
        assert.isTrue(res.ok);
        assert.equal(res.built, 1);
        assert.equal(res.online, 1);
        assert.include(env.out.xml, 'store-id="ny-store"');
        assert.notInclude(env.out.xml, 'eu-store');
    });

    it('uses the suggested type when the page sent none', function () {
        var env = loadRunner([shop, region], {});
        var res = env.runner.runBatch(0, 'full', 'f.xml', null, true);
        assert.equal(res.built, 1);
        assert.equal(res.online, 1);
    });

    it('explains an export with only online stores', function () {
        var res = loadRunner([region], {}).runner.runBatch(0, 'full', 'f.xml', ['eu-store'], true, { types: { 'eu-store': 'online' } });
        assert.isFalse(res.ok);
        assert.match(res.error, /No physical stores to export/);
    });

    it('refuses a second store with the same store ID instead of overwriting the first', function () {
        var twin = { id: 'c3', key: 'ny.store', name: { en: 'Twin' }, custom: { fields: { city: 'Albany' } } };
        var res = loadRunner([shop, twin], {}).runner.runBatch(0, 'full', 'f.xml', null, true,
            { types: { 'ny-store': 'physical', 'ny.store': 'physical' } });
        assert.equal(res.built, 1);
        assert.equal(res.failed, 1);
        assert.match(res.errors[0], /already used/);
    });

    it('builds store IDs from the source the user chose', function () {
        var env = loadRunner([shop], {});
        env.runner.runBatch(0, 'full', 'f.xml', null, true, { types: { 'ny-store': 'physical' }, idSource: 'id' });
        assert.include(env.out.xml, 'store-id="a1"');
    });
});

describe('storeFileNaming', function () {
    it('keeps -v001 for the first export and gives a re-export the next free version', function () {
        assert.equal(loadNaming([]).resolveFileName('full', 0, 500, 'store-full-20261005-v001.xml'), 'store-full-20261005-v001.xml');
        assert.equal(loadNaming(['store-full-20261005-v001.xml']).resolveFileName('full', 0, 500, 'store-full-20261005-v001.xml'),
            'store-full-20261005-v002.xml');
    });
});
