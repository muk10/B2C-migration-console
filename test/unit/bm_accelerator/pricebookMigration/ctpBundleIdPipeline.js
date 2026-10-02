'use strict';

/* eslint-env mocha */

/**
 * End-to-end check of the commercetools price book and inventory flows for bundles:
 * lean CT product pages (productType is an unexpanded reference) -> product-type names
 * attached -> price / inventory records -> import XML. Mirrors the CHF sandbox case where
 * every bundle was priced under a non-existent {bundleId}-{n}.
 */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var loader     = require('../helpers/cartridgeLoader');

var SCRIPTS = loader.getCartridgeRoot() + '/scripts/migration/';

var PRODUCT_TYPES = [
    { id: 'pt-bundle', name: 'Bundle' },
    { id: 'pt-candy', name: 'Candy' }
];

/**
 * @param {number} cents - amount in minor units
 * @param {Array} [tiers] - [{ minimumQuantity, cents }]
 * @returns {Object} CT CHF price
 */
function chf(cents, tiers) {
    var p = { value: { centAmount: cents, fractionDigits: 2, currencyCode: 'CHF' } };
    if (tiers) {
        p.tiers = tiers.map(function (t) {
            return { minimumQuantity: t.q, value: { centAmount: t.cents, fractionDigits: 2, currencyCode: 'CHF' } };
        });
    }
    return p;
}

/**
 * @param {string} id - CT product UUID
 * @param {string} typeId - product-type id (unexpanded reference, as a lean page returns it)
 * @param {Object} masterVariant - CT master variant
 * @param {Array} [variants] - other CT variants
 * @returns {Object} CT product
 */
function product(id, typeId, masterVariant, variants) {
    return {
        id:          id,
        productType: { typeId: 'product-type', id: typeId },
        masterData:  { current: { name: { en: id }, masterVariant: masterVariant, variants: variants || [] } }
    };
}

var MEMBERS = [{ name: 'bundleItems', value: [{ product: { typeId: 'product', id: 'member-1' }, quantity: 1 }] }];

// The three bundles from the CHF report, a bundle without members, and a normal product.
var CATALOG = [
    product('ecbfea07-e6c9-4d49-9496-8abd6c6eb568', 'pt-bundle',
        { id: 1, sku: 'gift-box', prices: [chf(4600)], attributes: MEMBERS }),
    product('3f034bb5-7080-411a-bc7c-e1c638beb404', 'pt-bundle',
        { id: 1, sku: 'peanut-bag', prices: [chf(10000, [{ q: 2, cents: 9500 }, { q: 3, cents: 9000 }])], attributes: MEMBERS }),
    product('41cbb1eb-9041-48dd-b158-f5cf4d0ecb35', 'pt-bundle',
        { id: 1, sku: 'cubes-bag', prices: [chf(12000, [{ q: 2, cents: 11500 }])], attributes: MEMBERS },
        [{ id: 2, sku: '9139test', prices: [chf(15000)] }]),
    product('aaaaaaaa-0000-0000-0000-000000000001', 'pt-bundle',
        { id: 1, sku: 'memberless-bundle', prices: [chf(900)] }),
    product('bbbbbbbb-0000-0000-0000-000000000002', 'pt-candy',
        { id: 1, sku: 'candy-1', prices: [chf(300)] },
        [{ id: 3, sku: 'candy-3', prices: [chf(350)] }, { id: 4, sku: 'candy-4', prices: [chf(400)] }])
];

/**
 * @param {string} uuid - CT product id
 * @returns {string} SFCC master product-id, resolved exactly as the product migration does
 */
function sfccId(uuid) {
    return loader.requireCartridge('productMigration/productTransformer').resolveMasterProductId({ id: uuid });
}

/**
 * Fake CT API: lean product pages (the URL must carry no expand) and product types.
 * @param {Array} requests - receives every GET url
 * @returns {Object} http stub
 */
function ctHttp(requests) {
    return {
        post: function () { return { status: 200, data: { access_token: 'token' } }; },
        get:  function (url) {
            requests.push(url);
            var limit  = parseInt((/limit=(\d+)/.exec(url) || [])[1], 10) || 20;
            var offset = parseInt((/offset=(\d+)/.exec(url) || [])[1], 10) || 0;
            var source = url.indexOf('/product-types') !== -1 ? PRODUCT_TYPES : CATALOG;
            var page   = JSON.parse(JSON.stringify(source.slice(offset, offset + limit)));
            return { status: 200, data: { results: page, total: source.length } };
        }
    };
}

/** Minimal dw.util.HashMap for the inventory resolver. */
function HashMap() {
    this.m = {};
}
HashMap.prototype.put = function (k, v) { this.m[k] = v; };
HashMap.prototype.get = function (k) { return Object.prototype.hasOwnProperty.call(this.m, k) ? this.m[k] : null; };
HashMap.prototype.containsKey = function (k) { return Object.prototype.hasOwnProperty.call(this.m, k); };

/**
 * @param {Array} requests - receives every GET url
 * @returns {Object} ctpProductFetcher wired to the fake CT API
 */
function loadProductFetcher(requests) {
    return proxyquire(SCRIPTS + 'productMigration/ctpProductFetcher.js', {
        '*/cartridge/scripts/migration/core/http': ctHttp(requests),
        '*/cartridge/scripts/migration/configAccessor': {
            ctp: { authUrl: 'https://auth.test', apiUrl: 'https://api.test', projectKey: 'p', clientId: 'c', clientSecret: 's' }
        },
        'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
        'dw/util/Bytes': function (v) { return v; },
        'dw/util/HashMap': HashMap
    });
}

describe('commercetools bundle product-ids, end to end', function () {
    var requests;
    var productFetcher;
    var savedSession;

    beforeEach(function () {
        requests = [];
        productFetcher = loadProductFetcher(requests);
        savedSession = global.session;
        global.session = { custom: {} };
    });

    afterEach(function () {
        global.session = savedSession;
    });

    it('writes the CHF price book with plain bundle ids and variant ids for normal products', function () {
        var embedded = proxyquire(SCRIPTS + 'pricebookMigration/ctpEmbeddedPriceFetcher.js', {
            '*/cartridge/scripts/migration/productMigration/ctpProductFetcher': productFetcher,
            '*/cartridge/scripts/migration/pricebookMigration/embeddedPriceExtractor':
                loader.requireCartridge('pricebookMigration/embeddedPriceExtractor')
        });
        var xmlBuilder = loader.requireCartridge('pricebookMigration/pricebookXmlBuilder');

        var targets = embedded.discoverEmbeddedPricebookTargets();
        assert.deepEqual(targets.map(function (t) { return t.currency; }), ['CHF']);

        var batch = embedded.fetchPriceRecordsBatch(0, 250, 'CHF', 'all', true);
        var out   = xmlBuilder.buildXml(batch.records, 'product-list-prices-chf', 'CHF');
        var ids   = [];
        out.xml.replace(/product-id="([^"]+)"/g, function (m, id) { ids.push(id); return m; });

        var candy = sfccId('bbbbbbbb-0000-0000-0000-000000000002');
        assert.deepEqual(ids, [
            sfccId('ecbfea07-e6c9-4d49-9496-8abd6c6eb568'),
            sfccId('3f034bb5-7080-411a-bc7c-e1c638beb404'),
            sfccId('41cbb1eb-9041-48dd-b158-f5cf4d0ecb35'),
            sfccId('aaaaaaaa-0000-0000-0000-000000000001'),
            candy + '-1', candy + '-2', candy + '-3'
        ]);
        assert.equal(out.failed, 0);

        var byId = {};
        batch.records.forEach(function (r) { byId[r.productId] = r; });
        assert.equal(byId[sfccId('ecbfea07-e6c9-4d49-9496-8abd6c6eb568')].amount, '46.00');
        assert.deepEqual(byId[sfccId('3f034bb5-7080-411a-bc7c-e1c638beb404')].tiers,
            [{ quantity: 2, amount: '95.00' }, { quantity: 3, amount: '90.00' }]);
        // master variant price, not the 150.00 test variant
        assert.equal(byId[sfccId('41cbb1eb-9041-48dd-b158-f5cf4d0ecb35')].amount, '120.00');

        // products were fetched lean; product types were looked up instead
        requests.filter(function (u) { return u.indexOf('/products?') !== -1; }).forEach(function (u) {
            assert.notInclude(u, 'expand=');
        });
        assert.isTrue(requests.some(function (u) { return u.indexOf('/product-types?') !== -1; }));
    });

    it('maps bundle inventory to the plain bundle id and drops non-master bundle variants', function () {
        var resolverModule = proxyquire(SCRIPTS + 'inventoryMigration/ctpInventoryProductIdResolver.js', {
            '*/cartridge/scripts/migration/productMigration/ctpProductFetcher': productFetcher,
            '*/cartridge/scripts/migration/productMigration/productTransformer':
                loader.requireCartridge('productMigration/productTransformer'),
            'dw/util/HashMap': HashMap
        });
        var transformer = loader.requireCartridge('inventoryMigration/inventoryTransformer');

        var records = transformer.aggregateBySku([
            { sku: 'gift-box', quantityOnStock: 5 },
            { sku: 'cubes-bag', quantityOnStock: 2 },
            { sku: '9139test', quantityOnStock: 7 },
            { sku: 'memberless-bundle', quantityOnStock: 1 },
            { sku: 'candy-3', quantityOnStock: 4 }
        ], resolverModule.build());

        var candy = sfccId('bbbbbbbb-0000-0000-0000-000000000002');
        assert.deepEqual(records.map(function (r) { return r.productId; }), [
            sfccId('ecbfea07-e6c9-4d49-9496-8abd6c6eb568'),
            sfccId('41cbb1eb-9041-48dd-b158-f5cf4d0ecb35'),
            // only the product-type name marks this one as a bundle
            sfccId('aaaaaaaa-0000-0000-0000-000000000001'),
            candy + '-2'
        ]);
    });
});
