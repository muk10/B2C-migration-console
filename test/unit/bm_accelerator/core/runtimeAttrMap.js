'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var loader = require('../helpers/cartridgeLoader');
loader.installCartridgeResolver();

var runtimeAttrMap = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

describe('runtimeAttrMap', function () {
    it('maps a source field to an OOTB system id', function () {
        var mapped = runtimeAttrMap.apply(
            { storePhone: '555-0100' },
            'store',
            { storePhone: 'phone' }
        );
        assert.equal(mapped.system.phone, '555-0100');
        assert.equal(mapped.custom.length, 0);
    });

    it('maps a source field to a custom attribute id', function () {
        var mapped = runtimeAttrMap.apply(
            { loyaltyTier: 'gold' },
            'store',
            { loyaltyTier: 'vip_tier' }
        );
        assert.equal(mapped.custom[0].id, 'vip_tier');
        assert.equal(mapped.custom[0].value, 'gold');
        assert.deepEqual(mapped.system, {});
    });

    it('keeps identity mapping when the source id is already OOTB', function () {
        var mapped = runtimeAttrMap.apply({ phone: '555-0100' }, 'store', {});
        assert.equal(mapped.system.phone, '555-0100');
        assert.equal(mapped.custom.length, 0);
    });

    it('strips c_ prefixes used by transformers', function () {
        var mapped = runtimeAttrMap.apply(
            { c_taxClassID: 'standard' },
            'shippingMethod',
            {}
        );
        assert.equal(mapped.system.taxClassID, 'standard');
    });

    it('formats datetime custom values without a trailing Z', function () {
        assert.equal(
            runtimeAttrMap.formatCustomAttrValue('2023-02-17T14:15:32.288Z'),
            '2023-02-17T14:15:32.288+0000'
        );
    });
});

describe('runtime maps in XML builders', function () {
    it('store: OOTB target becomes phone element, custom target keeps mapped id', function () {
        var storeXml = loader.requireCartridge('storeMigration/storeXmlBuilder');
        var ootb = storeXml.buildStoreXml({
            storeId: 's1',
            name: 'Downtown',
            storeLocatorEnabled: true,
            demandwarePosEnabled: false,
            posEnabled: false,
            customAttributes: { storePhone: '555-0100' }
        }, { storePhone: 'phone' });
        assert.match(ootb, /<phone>555-0100<\/phone>/);
        assert.notMatch(ootb, /attribute-id="phone"/);
        assert.notMatch(ootb, /attribute-id="storePhone"/);

        var custom = storeXml.buildStoreXml({
            storeId: 's1',
            name: 'Downtown',
            storeLocatorEnabled: true,
            demandwarePosEnabled: false,
            posEnabled: false,
            customAttributes: { loyaltyTier: 'gold' }
        }, { loyaltyTier: 'vip_tier' });
        assert.match(custom, /attribute-id="vip_tier">gold/);
        assert.notMatch(custom, /attribute-id="loyaltyTier"/);
    });

    it('inventory: source id is remapped on the custom-attribute', function () {
        var invXml = loader.requireCartridge('inventoryMigration/inventoryXmlBuilder');
        var xml = invXml.buildRecordXml({
            productId: 'sku-1',
            allocation: 4,
            perpetual: false,
            preorderBackorder: 'none',
            customAttributes: { warehouseNote: 'shelf-a' }
        }, { warehouseNote: 'bin_note' });
        assert.match(xml, /attribute-id="bin_note">shelf-a/);
        assert.notMatch(xml, /attribute-id="warehouseNote"/);
        assert.notMatch(xml, /attribute-id="allocation"/);
    });
});
