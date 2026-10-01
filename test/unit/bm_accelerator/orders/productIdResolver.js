'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path       = require('path');

var resolverPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/productIdResolver.js'
);

/**
 * Catalog as imported by the product migration: masters named after the commercetools
 * product, variants {master}-{n} in variant order.
 * @returns {Object} { resolver, lookups }
 */
function load() {
    var catalog = {};
    var lookups = [];

    /**
     * @param {string} id - product ID
     * @param {string} sku - manufacturer SKU
     * @param {string[]} [variantIds] - variant product IDs when this is a master
     */
    function add(id, sku, variantIds) {
        catalog[id] = {
            ID:              id,
            manufacturerSKU: sku,
            master:          !!variantIds,
            getVariants:     function () {
                var list = (variantIds || []).map(function (v) { return catalog[v]; });
                var i = 0;
                return { iterator: function () {
                    return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } };
                } };
            }
        };
    }
    add('p1', '', ['p1-1', 'p1-2']);
    add('p1-1', 'SKU-A');
    add('p1-2', 'SKU-B');
    add('p2', 'SKU-C');
    // variant 2 was deleted in commercetools: variant ID 3 is now the second variant
    add('p3', '', ['p3-1', 'p3-2']);
    add('p3-1', 'SKU-X');
    add('p3-2', 'SKU-Z');
    add('key-4', '', ['key-4-1']);
    add('key-4-1', 'SKU-K');

    var resolver = proxyquire(resolverPath, {
        'dw/catalog/ProductMgr': {
            getProduct: function (id) {
                lookups.push(id);
                return catalog[id] || null;
            }
        }
    }).createResolver();
    return { resolver: resolver, lookups: lookups };
}

/**
 * @param {Object[]} items - line items
 * @returns {Object} canonical order
 */
function order(items) {
    return { orderNumber: 'o1', lineItems: items };
}

describe('order productIdResolver', function () {
    it('replaces the SKU with the SFCC variant ID {master}-{n}', function () {
        var env = load();
        var o = order([
            { sku: 'SKU-A', sourceProductId: 'p1', sourceVariantId: 1 },
            { sku: 'SKU-B', sourceProductId: 'p1', sourceVariantId: 2 }
        ]);
        assert.equal(env.resolver.resolveOrder(o), 0);
        assert.equal(o.lineItems[0].productId, 'p1-1');
        assert.equal(o.lineItems[1].productId, 'p1-2');
    });

    it('finds the variant by SKU when the variant ID no longer matches its position', function () {
        var env = load();
        var o = order([{ sku: 'SKU-Z', sourceProductId: 'p3', sourceVariantId: 3 }]);
        assert.equal(env.resolver.resolveOrder(o), 0);
        assert.equal(o.lineItems[0].productId, 'p3-2');
    });

    it('uses the product itself when it has no variants', function () {
        var env = load();
        var o = order([{ sku: 'SKU-C', sourceProductId: 'p2', sourceVariantId: 1 }]);
        assert.equal(env.resolver.resolveOrder(o), 0);
        assert.equal(o.lineItems[0].productId, 'p2');
    });

    it('falls back to the product key when the product ID is not in the catalog', function () {
        var env = load();
        var o = order([{ sku: 'SKU-K', sourceProductId: 'gone', sourceProductKey: 'key-4', sourceVariantId: 1 }]);
        assert.equal(env.resolver.resolveOrder(o), 0);
        assert.equal(o.lineItems[0].productId, 'key-4-1');
    });

    it('keeps the SKU and counts the line item when no SFCC product matches', function () {
        var env = load();
        var o = order([
            { sku: 'SKU-OLD', sourceProductId: 'deleted', sourceVariantId: 1 },
            { sku: 'SKU-NONE', sourceProductId: 'p1', sourceVariantId: 9 }
        ]);
        assert.equal(env.resolver.resolveOrder(o), 2);
        assert.isUndefined(o.lineItems[0].productId);
        assert.isUndefined(o.lineItems[1].productId);
    });

    it('leaves line items without a source product reference untouched and uncounted', function () {
        var env = load();
        var o = order([{ sku: 'SHOPIFY-SKU' }]);
        assert.equal(env.resolver.resolveOrder(o), 0);
        assert.isUndefined(o.lineItems[0].productId);
        assert.lengthOf(env.lookups, 0);
    });

    it('looks each product up once per resolver', function () {
        var env = load();
        var item = function () { return { sku: 'SKU-A', sourceProductId: 'p1', sourceVariantId: 1 }; };
        env.resolver.resolveOrder(order([item()]));
        var afterFirst = env.lookups.length;
        env.resolver.resolveOrder(order([item(), item()]));
        assert.equal(env.lookups.length, afterFirst);
    });
});
