'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var loader = require('../helpers/cartridgeLoader');

var extractor;
var productTransformer;
var productFetcher;

/** Fixed "now" so validity windows in the fixtures are deterministic. */
var NOW = Date.parse('2026-06-01T00:00:00Z');

/**
 * @param {number} cents - amount in minor units
 * @param {string} [cur] - currency code (default USD)
 * @returns {Object} CT money value
 */
function money(cents, cur) {
    return { centAmount: cents, fractionDigits: 2, currencyCode: cur || 'USD' };
}

/**
 * @param {number} cents - amount in minor units
 * @param {string} cur - currency code
 * @param {Object} [extra] - country / customerGroup / channel / validFrom / validUntil / tiers
 * @returns {Object} CT embedded price entry
 */
function price(cents, cur, extra) {
    var p = { value: money(cents, cur) };
    if (extra) {
        Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
    }
    return p;
}

/**
 * Minimal CT product projection with a stable id so master-id resolution is realistic.
 * @param {string} masterSku - SKU of the master variant
 * @param {Array} masterPrices - prices of the master variant
 * @param {Array} [variants] - [{ sku, prices }]
 * @returns {Object} CT product
 */
function ctProduct(masterSku, masterPrices, variants) {
    return {
        id:  'bbf1882b-f053-4c01-b3fe-940507a85f14',
        key: 'the-product',
        masterData: {
            current: {
                name: { en: 'Test' },
                masterVariant: { sku: masterSku, prices: masterPrices || [] },
                variants: variants || []
            }
        }
    };
}

/**
 * @param {Object} product - CT product
 * @param {string} currency - currency code
 * @param {Object} [options] - extractor options (default: fixed now)
 * @returns {Array} price records
 */
function extract(product, currency, options) {
    return extractor.extractRecordsFromProduct(product, currency, 'all', true, options || { nowMs: NOW });
}

describe('embeddedPriceExtractor', function () {
    before(function () {
        loader.installCartridgeResolver();
        extractor = loader.requireCartridge('pricebookMigration/embeddedPriceExtractor');
        productTransformer = loader.requireCartridge('productMigration/productTransformer');
        productFetcher = loader.requireCartridge('productMigration/ctpProductFetcher');
    });

    describe('product-id (issue 1)', function () {
        it('writes {masterId}-{n} product-ids, never the SKU', function () {
            var records = extract(
                ctProduct('e3', [price(1000, 'GBP')], [{ sku: 'e4', prices: [price(3500, 'GBP')] }]),
                'GBP'
            );
            var ids = records.map(function (r) { return r.productId; });
            assert.lengthOf(records, 2);
            assert.match(ids[0], /-1$/);
            assert.match(ids[1], /-2$/);
            // same master prefix, and neither is the raw SKU
            var prefix0 = ids[0].replace(/-1$/, '');
            var prefix1 = ids[1].replace(/-2$/, '');
            assert.equal(prefix0, prefix1);
            assert.notEqual(ids[0], 'e3');
            assert.notEqual(ids[1], 'e4');
        });

        it('carries quantity tiers onto the record', function () {
            var records = extract(
                ctProduct('kl8', [price(1000, 'GBP', { tiers: [{ minimumQuantity: 10, value: money(800, 'GBP') }] })]),
                'GBP'
            );
            assert.lengthOf(records, 1);
            assert.deepEqual(records[0].tiers, [{ quantity: 10, amount: '8.00' }]);
        });
    });

    describe('SKU hygiene', function () {
        it('trims the SKU on the record', function () {
            var records = extract(ctProduct('  e3  ', [price(1000, 'GBP')]), 'GBP');
            assert.equal(records[0].sku, 'e3');
        });

        it('still prices a variant whose SKU is blank (it has a valid product-id)', function () {
            var records = extract(
                ctProduct('m', [price(1000, 'GBP')], [{ sku: '   ', prices: [price(2000, 'GBP')] }]),
                'GBP'
            );
            assert.lengthOf(records, 2);
            assert.match(records[1].productId, /-2$/);
        });
    });

    describe('price selection filters', function () {
        it('excludes customer-group prices (issue 5)', function () {
            var records = extract(
                ctProduct('sw1', [price(1500, 'EUR', { customerGroup: { typeId: 'customer-group', id: 'pop-france' } })]),
                'EUR'
            );
            assert.lengthOf(records, 0);
        });

        it('prefers the base price over a customer-group price', function () {
            var records = extract(
                ctProduct('sw1', [
                    price(1500, 'EUR', { customerGroup: { typeId: 'customer-group', id: 'pop-france' } }),
                    price(2000, 'EUR')
                ]),
                'EUR'
            );
            assert.lengthOf(records, 1);
            assert.equal(records[0].amount, '20.00');
        });

        it('excludes expired prices (issue 6)', function () {
            var records = extract(
                ctProduct('9180', [price(180, 'CHF', { validUntil: '2025-10-01T00:00:00Z' })]),
                'CHF'
            );
            assert.lengthOf(records, 0);
        });

        it('excludes not-yet-valid prices', function () {
            var records = extract(
                ctProduct('x', [price(500, 'USD', { validFrom: '2027-01-01T00:00:00Z' })]),
                'USD'
            );
            assert.lengthOf(records, 0);
        });

        it('excludes channel/warehouse prices (issue 8)', function () {
            var records = extract(
                ctProduct('x', [price(500, 'USD', { channel: { typeId: 'channel', id: 'ny-warehouse' } })]),
                'USD'
            );
            assert.lengthOf(records, 0);
        });
    });

    describe('country selection (issue 4)', function () {
        it('prefers the base (no-country) price', function () {
            var records = extract(
                ctProduct('9352', [price(4250, 'EUR', { country: 'DE' }), price(5100, 'EUR')]),
                'EUR'
            );
            assert.equal(records[0].amount, '51.00');
        });

        it('uses the dominant country when only country prices exist', function () {
            var records = extract(
                ctProduct('9352', [
                    price(5100, 'EUR', { country: 'FR' }),
                    price(4250, 'EUR', { country: 'DE' })
                ]),
                'EUR',
                { nowMs: NOW, dominantCountry: 'FR' }
            );
            assert.equal(records[0].amount, '51.00');
        });

        it('falls back to the most common amount when no dominant country matches', function () {
            var records = extract(
                ctProduct('e3', [
                    price(3500, 'EUR', { country: 'DE' }),
                    price(3500, 'EUR', { country: 'FR' }),
                    price(2000, 'EUR', { country: 'IT' })
                ]),
                'EUR'
            );
            assert.equal(records[0].amount, '35.00');
        });
    });

    describe('bundles and sets (plain product-id)', function () {
        /**
         * @param {Object} product - ctProduct(...) result
         * @param {string} typeName - CT product-type name
         * @returns {Object} the product with an expanded productType
         */
        function withType(product, typeName) {
            var p = product;
            p.productType = { typeId: 'product-type', id: 'pt-1', obj: { id: 'pt-1', name: typeName } };
            return p;
        }

        /**
         * @param {Object} product - CT product
         * @returns {string} SFCC master product-id
         */
        function masterIdOf(product) {
            return productTransformer.resolveMasterProductId(product);
        }

        it('prices a one-variant bundle under its plain product-id', function () {
            var p = withType(ctProduct('gift-box', [price(4600, 'CHF')]), 'Bundle');
            var records = extract(p, 'CHF');
            assert.lengthOf(records, 1);
            assert.equal(records[0].productId, masterIdOf(p));
            assert.equal(records[0].amount, '46.00');
        });

        it('uses only the master variant price for a multi-variant bundle (no -2 row)', function () {
            var p = withType(ctProduct('9139', [price(12000, 'CHF')], [
                { sku: '9139test', prices: [price(15000, 'CHF')] }
            ]), 'Product Bundle');
            var records = extract(p, 'CHF');
            assert.lengthOf(records, 1);
            assert.equal(records[0].productId, masterIdOf(p));
            assert.equal(records[0].amount, '120.00');
        });

        it('keeps quantity tiers on the bundle row', function () {
            var p = withType(ctProduct('peanut', [price(10000, 'CHF', {
                tiers: [
                    { minimumQuantity: 2, value: money(9500, 'CHF') },
                    { minimumQuantity: 3, value: money(9000, 'CHF') }
                ]
            })]), 'bundle');
            var records = extract(p, 'CHF');
            assert.lengthOf(records, 1);
            assert.equal(records[0].productId, masterIdOf(p));
            assert.deepEqual(records[0].tiers, [
                { quantity: 2, amount: '95.00' },
                { quantity: 3, amount: '90.00' }
            ]);
        });

        it('prices a set under its plain product-id', function () {
            var p = withType(ctProduct('set-1', [price(3000, 'EUR')]), 'Gift Set');
            var records = extract(p, 'EUR');
            assert.lengthOf(records, 1);
            assert.equal(records[0].productId, masterIdOf(p));
        });

        it('classifies a lean (unexpanded) bundle once its product-type name is attached', function () {
            var p = ctProduct('gift-box', [price(4600, 'CHF')], [{ sku: 'gift-box-b', prices: [price(5000, 'CHF')] }]);
            p.productType = { typeId: 'product-type', id: 'pt-bundle' };
            productFetcher.attachProductTypeNames([p], { 'pt-bundle': 'Bundle' });
            var records = extract(p, 'CHF');
            assert.lengthOf(records, 1);
            assert.equal(records[0].productId, masterIdOf(p));
        });

        it('still gives {masterId}-{position} for a normal product with a gap in CT variant ids', function () {
            var p = withType(ctProduct('n1', [price(1000, 'GBP')], [
                { id: 3, sku: 'n3', prices: [price(1100, 'GBP')] },
                { id: 4, sku: 'n4', prices: [price(1200, 'GBP')] }
            ]), 'Default');
            p.masterData.current.masterVariant.id = 1;
            var ids = extract(p, 'GBP').map(function (r) { return r.productId; });
            var m = masterIdOf(p);
            assert.deepEqual(ids, [m + '-1', m + '-2', m + '-3']);
        });
    });

    describe('dominantCountryByCurrency', function () {
        it('returns the country with the most rows per currency', function () {
            var map = extractor.dominantCountryByCurrency({
                EUR: { FR: 1, DE: 8, IT: 3 },
                GBP: { GB: 5 }
            });
            assert.equal(map.EUR, 'DE');
            assert.equal(map.GBP, 'GB');
        });
    });
});
