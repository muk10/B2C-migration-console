'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var transformerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/shopifyCustomerTransformer.js'
);

describe('shopifyCustomerTransformer', function () {
    /**
     * Load the transformer with deterministic attribute mapping dependencies.
     * @param {Object} map Visit-scoped source-to-SFCC attribute map.
     * @returns {Object} Shopify customer transformer.
     */
    function loadTransformer(map) {
        return proxyquire(transformerPath, {
            '*/cartridge/scripts/migration/core/sourceAttrIds': {
                toAttrId: function (id) { return 'spy_' + id; }
            },
            '*/cartridge/scripts/migration/core/attrIdMapSession': {
                read: function () { return map || {}; },
                resolve: function (id, attrMap) { return attrMap[id] || id; }
            }
        });
    }

    it('maps native fields and keeps migration-only values non-custom', function () {
        var transformed = loadTransformer().transformCustomer({
            id: 123,
            email: 'customer@example.com',
            first_name: 'Test',
            last_name: 'Customer',
            phone: '+1-555-0100',
            locale: 'en-US',
            tags: 'vip, wholesale',
            addresses: [{ id: 9, address1: '1 Main', country_code: 'US', default: true }]
        });

        assert.equal(transformed.profile.preferred_locale, 'en_US');
        assert.equal(transformed.profile.source_customer_id, '123');
        assert.deepEqual(transformed.profile.shopify_tags, ['vip', 'wholesale']);
        assert.isUndefined(transformed.profile.c_shopify_customer_id);
        assert.isUndefined(transformed.profile.c_shopify_tags);
        assert.equal(transformed.addresses[0].address1, '1 Main');
        assert.isTrue(transformed.addresses[0].preferred);
    });

    it('maps customer metafields and respects selected attribute renames', function () {
        var transformed = loadTransformer({
            spy_migration__loyalty_id: 'customerLoyaltyId'
        }).transformCustomer({
            id: 123,
            email: 'customer@example.com',
            metafields: [{ namespace: 'migration', key: 'loyalty_id', type: 'number_integer', value: '42' }]
        });

        assert.equal(transformed.profile.c_customerLoyaltyId, '42');
        assert.isUndefined(transformed.profile.c_spy_migration__loyalty_id);
    });

    it('parses Shopify list metafields for SFCC set attributes', function () {
        var transformed = loadTransformer().transformCustomer({
            id: 123,
            email: 'customer@example.com',
            metafields: [{
                namespace: 'preferences',
                key: 'favorite_colors',
                type: 'list.single_line_text_field',
                value: '["blue","green"]'
            }]
        });

        assert.deepEqual(transformed.profile.c_spy_preferences__favorite_colors, ['blue', 'green']);
    });
});
