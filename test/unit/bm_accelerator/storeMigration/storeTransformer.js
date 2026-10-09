'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru().noPreserveCache();
var path       = require('path');
var loader     = require('../helpers/cartridgeLoader');

var root = path.join(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/storeMigration');

/**
 * Load the store transformer with the real commercetools fetcher helpers and stubbed platform,
 * session map and SFCC inventory lists.
 * @param {Object} [opts] - { platform, attrMap, lists }
 * @returns {Object} storeTransformer
 */
function loadTransformer(opts) {
    var o = opts || {};
    var fetcher = proxyquire(path.join(root, 'ctpStoreFetcher.js'), {
        '*/cartridge/scripts/migration/core/http': {},
        '*/cartridge/scripts/migration/configAccessor': {},
        'dw/crypto/Encoding': {},
        'dw/util/Bytes': function () {}
    });
    return proxyquire(path.join(root, 'storeTransformer.js'), {
        '*/cartridge/scripts/migration/core/dataSourceRegistry': {
            getFetcher:    function () { return fetcher; },
            getPlatformId: function () { return o.platform || 'commercetools'; }
        },
        '*/cartridge/scripts/migration/core/attrIdMapSession': {
            read:          function () { return o.attrMap || {}; },
            resolve:       function (id, map) { return (map && map[id]) || id; },
            clear:         function () {},
            saveFromAttrs: function () {}
        },
        '*/cartridge/scripts/migration/configAccessor': { sfcc: { inventoryListId: 'migrated-inventory' } },
        'dw/catalog/ProductInventoryMgr': {
            getInventoryList: function (id) { return (o.lists || []).indexOf(id) !== -1 ? { ID: id } : null; }
        }
    });
}

var channels = {
    'ch-eu': { id: 'ch-eu', key: 'eu-warehouse-channel', roles: ['InventorySupply'] },
    'ch-ny': { id: 'ch-ny', key: 'ny-warehouse-channel', roles: ['InventorySupply', 'ProductDistribution'] },
    'ch-dt': {
        id: 'ch-dt', key: 'downtown',
        address: { streetNumber: '1', streetName: 'Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
        geoLocation: { type: 'Point', coordinates: [-73.99, 40.73] }
    }
};
var euStore = { id: '9bd96783-0000', key: 'eu-store', name: { en: 'EU Store' }, countries: [], supplyChannels: [{ id: 'ch-eu' }] };
var nyStore = {
    id: '66a2e685-0000', key: 'ny-store', name: { en: 'New York Store' }, countries: [],
    supplyChannels: [{ id: 'ch-ny' }], distributionChannels: [{ id: 'ch-ny' }],
    custom: { fields: {
        streetNumber: '47', streetName: 'W 13th St', additionalStreetInfo: 'Ground floor', city: 'New York',
        state: 'NY', postalCode: '10011', country: 'US', region: 'amer',
        pickupInstructions: 'Show the order QR code', storeWeeklyHours: '[{"dayOfTheWeek":1}]', storeNumber: '6118'
    } }
};
var dsStore = { id: '1e0600b7-0000', key: 'ds-store', name: { en: 'Disney Springs Store' }, custom: { fields: { pickupInstructions: 'At the cashier' } } };

describe('storeTransformer — store type', function () {
    it('suggests online for a commercetools sales channel and physical for shops', function () {
        var t = loadTransformer();
        assert.equal(t.classifyStore(euStore, channels).type, 'online');
        assert.equal(t.classifyStore(nyStore, channels).type, 'physical');
        assert.include(t.classifyStore(nyStore, channels).reasons, 'Address from custom fields');
        assert.deepEqual(t.classifyStore(dsStore, channels).reasons, ['Has pick-up details']);
    });

    it('keeps store locations from other platforms physical', function () {
        var t = loadTransformer({ platform: 'shopify' });
        assert.equal(t.classifyStore({ id: '77', key: 'shopify-loc-77', supplyChannels: [{ id: '77' }] }, {}).type, 'physical');
    });
});

describe('storeTransformer — address and IDs', function () {
    it('reads an address kept in custom fields into the native store fields', function () {
        var rec = loadTransformer().transformStore(nyStore, channels);
        assert.equal(rec.storeId, 'ny-store');
        assert.equal(rec.address1, '47 W 13th St');
        assert.equal(rec.address2, 'Ground floor');
        assert.equal(rec.city, 'New York');
        assert.equal(rec.postalCode, '10011');
        assert.equal(rec.stateCode, 'NY');
        assert.equal(rec.countryCode, 'US');
        assert.isTrue(rec.storeLocatorEnabled);
        // address fields are native now; region, pick-up and hours fields stay custom attributes
        assert.notProperty(rec.customAttributes, 'streetName');
        assert.notProperty(rec.customAttributes, 'country');
        assert.equal(rec.customAttributes.region, 'amer');
        assert.equal(rec.customAttributes.pickupInstructions, 'Show the order QR code');
        assert.property(rec.customAttributes, 'storeWeeklyHours');
    });

    it('prefers the linked channel address and coordinates, and says when it ignored custom address fields', function () {
        var store = { key: 'dt', id: 'x', name: { en: 'Downtown' }, supplyChannels: [{ id: 'ch-dt' }],
            custom: { fields: { city: 'Elsewhere' } } };
        var rec = loadTransformer().transformStore(store, channels);
        assert.equal(rec.address1, '1 Main St');
        assert.equal(rec.city, 'Springfield');
        assert.equal(rec.latitude, '40.73');
        assert.equal(rec.longitude, '-73.99');
        assert.include(rec.issues.map(function (i) { return i.code; }), 'custom-address-ignored');
    });

    it('builds the store ID from the key by default on commercetools, from the ID elsewhere, or from the name', function () {
        assert.equal(loadTransformer().resolveStoreId(nyStore), 'ny-store');
        assert.equal(loadTransformer({ platform: 'shopify' }).resolveStoreId({ id: '77', key: 'shopify-loc-77' }), '77');
        assert.equal(loadTransformer().resolveStoreId(nyStore, 'id'), '66a2e685-0000');
        assert.equal(loadTransformer().resolveStoreId(nyStore, 'name'), 'New-York-Store');
    });

    it('leaves a field the user renamed in Check Attributes to that mapping', function () {
        var rec = loadTransformer({ attrMap: { streetName: 'legacyStreet' } }).transformStore(nyStore, channels);
        assert.equal(rec.address1, '47');
        assert.equal(rec.customAttributes.streetName, 'W 13th St');
    });
});

describe('storeTransformer — checks', function () {
    it('links the inventory list only when it exists in SFCC', function () {
        var found = loadTransformer({ lists: ['migrated-inventory_ny-warehouse-channel'] }).transformStore(nyStore, channels);
        assert.equal(found.inventoryListId, 'migrated-inventory_ny-warehouse-channel');

        var missing = loadTransformer().transformStore(nyStore, channels);
        assert.equal(missing.inventoryListId, '');
        assert.include(missing.issues.map(function (i) { return i.code; }), 'inventory-list-missing');
    });

    it('hides a store without an address from the store locator and warns about missing data', function () {
        var rec = loadTransformer().transformStore(dsStore, channels);
        assert.isFalse(rec.storeLocatorEnabled);
        var codes = rec.issues.map(function (i) { return i.code; });
        assert.includeMembers(codes, ['no-address', 'no-coordinates', 'no-country']);
    });

    it('leaves out an invalid country code and invalid coordinates with a warning', function () {
        var store = { key: 'bad', name: { en: 'Bad' }, countries: ['USA'],
            custom: { fields: { city: 'X', latitude: '123', longitude: '10' } } };
        var rec = loadTransformer().transformStore(store, {});
        assert.equal(rec.countryCode, '');
        assert.equal(rec.latitude, '');
        var codes = rec.issues.map(function (i) { return i.code; });
        assert.includeMembers(codes, ['invalid-country', 'invalid-coordinates']);
    });

    it('flags two stores that end up with the same SFCC store ID', function () {
        var rows = loadTransformer().previewStores([
            { key: 'shop.one', name: { en: 'A' } },
            { key: 'shop-one', name: { en: 'B' } }
        ], {});
        assert.equal(rows[0].sfccStoreId, 'shop-one');
        assert.equal(rows[0].issues[0].code, 'duplicate-id');
        assert.equal(rows[1].issues[0].code, 'duplicate-id');
    });

    it('returns the suggested type and its reasons on each checklist row', function () {
        var rows = loadTransformer().previewStores([euStore, nyStore], channels);
        assert.equal(rows[0].suggestedType, 'online');
        assert.equal(rows[1].suggestedType, 'physical');
        assert.equal(rows[1].address, '47 W 13th St, New York, US');
    });
});

describe('storeXmlBuilder', function () {
    it('writes the native address in store.xsd order, without the deprecated POS flag', function () {
        loader.installCartridgeResolver();
        var xmlBuilder = loader.requireCartridge('storeMigration/storeXmlBuilder');
        var rec = loadTransformer({ lists: ['migrated-inventory_ny-warehouse-channel'] }).transformStore(nyStore, channels);
        var xml = xmlBuilder.buildStoreXml(rec, {});
        var order = ['<name>', '<address1>', '<address2>', '<city>', '<postal-code>', '<state-code>', '<country-code>',
            '<inventory-list-id>', '<store-locator-enabled-flag>', '<pos-enabled-flag>', '<custom-attributes>'];
        var last = -1;
        order.forEach(function (tag) {
            var at = xml.indexOf(tag);
            assert.isAbove(at, last, tag + ' out of order');
            last = at;
        });
        assert.notInclude(xml, 'demandware-pos-enabled-flag');
        assert.include(xml, '<store-locator-enabled-flag>true</store-locator-enabled-flag>');
        assert.notInclude(xml, 'attribute-id="streetName"');
    });

    it('writes weekly opening hours as store-hours, one line per day from Monday, and keeps the raw field', function () {
        loader.installCartridgeResolver();
        var xmlBuilder = loader.requireCartridge('storeMigration/storeXmlBuilder');
        var hours = JSON.stringify([
            { dayOfTheWeek: 0, openTime: '11:00:00.000+00:00', closeTime: '16:00:00.000+00:00' },
            { dayOfTheWeek: 1, openTime: '09:00:00.000+00:00', closeTime: '18:00:00.000+00:00' },
            { dayOfTheWeek: 2, openTime: 'closed' }
        ]);
        var store = JSON.parse(JSON.stringify(nyStore));
        store.custom.fields.storeWeeklyHours = hours;
        var rec = loadTransformer().transformStore(store, channels);
        assert.equal(rec.storeHours, '<p>Monday: 09:00 - 18:00</p><p>Sunday: 11:00 - 16:00</p>');
        assert.equal(rec.customAttributes.storeWeeklyHours, hours);
        assert.include(xmlBuilder.buildStoreXml(rec, {}),
            '<store-hours xml:lang="x-default">&lt;p&gt;Monday: 09:00 - 18:00&lt;/p&gt;&lt;p&gt;Sunday: 11:00 - 16:00&lt;/p&gt;</store-hours>');
        assert.equal(loadTransformer().transformStore(nyStore, channels).storeHours, '');
    });
});
