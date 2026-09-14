'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var ordersRoot = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders'
);
var mapperPath = path.join(ordersRoot, 'mappers/shopifyOrderMapper.js');

/**
 * Load an order migration module for proxyquire.
 * @param {string} file - Module path relative to the order migration root.
 * @returns {Object} Loaded module.
 */
function load(file) {
    return require(path.join(ordersRoot, file));
}

/**
 * Build a representative Shopify REST order response.
 * @returns {Object} Representative Shopify order.
 */
function sampleOrder() {
    return {
        id: 7258678952247,
        admin_graphql_api_id: 'gid://shopify/Order/7258678952247',
        checkout_id: 40450715255095,
        name: '#1003',
        order_number: 1003,
        confirmation_number: '58CT8FG6K',
        confirmed: true,
        email: 'customer@example.com',
        customer_locale: 'en-PK',
        source_name: 'shopify_draft_order',
        created_at: '2026-07-13T05:40:10-04:00',
        closed_at: '2026-07-13T07:08:40-04:00',
        processed_at: '2026-07-13T05:40:09-04:00',
        currency: 'PKR',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        taxes_included: false,
        test: false,
        tags: 'vip, migrated',
        note: 'Handle carefully',
        note_attributes: [{ name: 'delivery_window', value: 'morning' }],
        subtotal_price: '699.95',
        total_price: '811.94',
        total_tax: '111.99',
        total_shipping_price_set: { shop_money: { amount: '0.00', currency_code: 'PKR' } },
        customer: { id: 10527086215479, first_name: 'Test', last_name: 'Customer' },
        billing_address: { first_name: 'Test', last_name: 'Customer', address1: '1 Main', city: 'Lahore', country_code: 'PK' },
        shipping_address: { first_name: 'Test', last_name: 'Customer', address1: '1 Main', city: 'Lahore', country_code: 'PK' },
        line_items: [{ id: 1, variant_id: 52613052203319, title: 'Snowboard', quantity: 1, price: '699.95', tax_lines: [{ price: '111.99' }] }],
        tax_lines: [{ title: 'GST', price: '111.99', rate: 0.16 }],
        discount_codes: [],
        fulfillments: [{ status: 'success' }],
        shipping_lines: []
    };
}

describe('shopifyOrderMapper', function () {
    var mapper;

    beforeEach(function () {
        mapper = proxyquire(mapperPath, {
            '*/cartridge/scripts/migration/orders/canonicalOrder': load('canonicalOrder'),
            '*/cartridge/scripts/migration/orders/orderShippingStatus': load('orderShippingStatus'),
            '*/cartridge/scripts/migration/core/sourceAttrIds': {
                toAttrId: function (id) { return 'spy_' + id; }
            },
            '*/cartridge/scripts/migration/core/attrIdMapSession': {
                read: function () { return {}; },
                resolve: function (id, map) { return map[id] || id; }
            }
        });
    });

    it('maps Shopify fields to native SFCC order fields', function () {
        var order = mapper.mapOrder(sampleOrder());
        assert.equal(order.orderNumber, '1003');
        assert.equal(order.externalOrderNo, '#1003');
        assert.equal(order.externalOrderText, 'Handle carefully');
        assert.equal(order.customerOrderReference, '');
        assert.equal(order.customerLocale, 'en_PK');
        assert.equal(order.channelType, 'CustomerServiceCenter');
        assert.equal(order.confirmationStatus, 'CONFIRMED');
        assert.equal(order.status, 'COMPLETED');
        assert.equal(order.paymentStatus, 'PAID');
        assert.equal(order.shipments[0].status, 'SHIPPED');
    });

    it('does not create hard-coded custom attributes from standard Shopify fields', function () {
        var attributes = mapper.mapOrder(sampleOrder()).customAttributes;
        assert.deepEqual(attributes, []);
    });

    it('uses valid SFCC enum values for partial payment and channels', function () {
        var source = sampleOrder();
        source.financial_status = 'partially_paid';
        source.source_name = 'pos';
        source.confirmed = false;
        source.closed_at = null;
        source.fulfillment_status = null;

        var order = mapper.mapOrder(source);
        assert.equal(order.paymentStatus, 'PART_PAID');
        assert.equal(order.channelType, 'Store');
        assert.equal(order.confirmationStatus, 'NOT_CONFIRMED');
        assert.equal(order.status, 'OPEN');
        assert.equal(order.cancelCode, '');
        assert.equal(order.cancelDescription, '');
    });

    it('defaults missing or unexpected Shopify confirmation values safely', function () {
        var missing = sampleOrder();
        delete missing.confirmed;
        assert.equal(mapper.mapOrder(missing).confirmationStatus, 'NOT_CONFIRMED');

        var unexpected = sampleOrder();
        unexpected.confirmed = 'true';
        assert.equal(mapper.mapOrder(unexpected).confirmationStatus, 'NOT_CONFIRMED');
    });

    it('maps Shopify order metafields to SFCC custom attributes', function () {
        var source = sampleOrder();
        source.metafields = [{
            namespace: 'migration',
            key:       'tracking_id',
            type:      'number_integer',
            value:     '12345'
        }];

        var attributes = mapper.mapOrder(source).customAttributes;
        var tracking = attributes.filter(function (attr) {
            return attr.id === 'spy_migration__tracking_id';
        })[0];

        assert.isOk(tracking);
        assert.equal(tracking.value, '12345');
    });
});
