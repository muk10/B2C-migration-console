'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var loader = require('../helpers/cartridgeLoader');

var transformer;

/**
 * Resolver mapping the doc's example SKUs to SFCC variant product-ids.
 * @param {string} sku - CT SKU
 * @returns {string} SFCC product-id, or '' when unknown
 */
function resolver(sku) {
    var map = {
        e3: 'CTbbf1882b-1',
        e4: 'CTbbf1882b-2'
    };
    return map[sku] || '';
}

describe('inventoryTransformer product-id resolution (issue 2)', function () {
    before(function () {
        loader.installCartridgeResolver();
        transformer = loader.requireCartridge('inventoryMigration/inventoryTransformer');
    });

    it('maps the SKU to the SFCC product-id when a resolver is given', function () {
        var rec = transformer.transformEntry({ sku: 'e3', quantityOnStock: 5 }, resolver);
        assert.equal(rec.productId, 'CTbbf1882b-1');
        assert.equal(rec.sku, 'e3');
        assert.equal(rec.allocation, 5);
    });

    it('trims the SKU before resolving', function () {
        var rec = transformer.transformEntry({ sku: '  e4  ', quantityOnStock: 1 }, resolver);
        assert.equal(rec.productId, 'CTbbf1882b-2');
        assert.equal(rec.sku, 'e4');
    });

    it('skips an entry whose SKU has no migrated product', function () {
        var rec = transformer.transformEntry({ sku: 'bundle-only', quantityOnStock: 9 }, resolver);
        assert.isNull(rec);
    });

    it('falls back to the SKU when no resolver is given (other platforms)', function () {
        var rec = transformer.transformEntry({ sku: 'shopify-123', quantityOnStock: 2 });
        assert.equal(rec.productId, 'shopify-123');
        assert.equal(rec.sku, 'shopify-123');
    });

    it('aggregates supply-channel rows under the resolved product-id', function () {
        var records = transformer.aggregateBySku([
            { sku: 'e3', quantityOnStock: 4, supplyChannel: { id: 'a' } },
            { sku: 'e3', quantityOnStock: 6, supplyChannel: { id: 'b' } },
            { sku: 'e4', quantityOnStock: 3 }
        ], resolver);

        assert.lengthOf(records, 2);
        var byId = {};
        records.forEach(function (r) { byId[r.productId] = r; });
        assert.equal(byId['CTbbf1882b-1'].allocation, 10);
        assert.equal(byId['CTbbf1882b-2'].allocation, 3);
    });
});
