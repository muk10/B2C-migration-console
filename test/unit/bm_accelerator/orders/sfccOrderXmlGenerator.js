'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var cartridgeLoader = require('../helpers/cartridgeLoader');
cartridgeLoader.installCartridgeResolver();

var ordersRoot = path.join(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders');

/**
 * Load an order migration module.
 * @param {string} modulePath - Module path relative to the order migration root.
 * @returns {Object} Loaded module.
 */
function load(modulePath) {
    return require(path.join(ordersRoot, modulePath));
}

var generatorPath = path.join(ordersRoot, 'generators/sfccOrderXmlGenerator.js');

/**
 * Build a canonical order for XML generator tests.
 * @param {string} no - Order number.
 * @returns {Object} Canonical order fixture.
 */
function sampleOrder(no) {
    return {
        orderNumber: String(no),
        currency: 'USD',
        createdAt: '2024-01-01T00:00:00.000Z',
        customerLocale: 'en_US',
        taxation: 'net',
        customer: { id: 'c1', email: 'user@example.com', firstName: 'Test', lastName: 'User' },
        billingAddress: {
            firstName: 'Test', lastName: 'User', address1: '1 Main', city: 'NYC',
            stateCode: 'NY', postalCode: '10001', countryCode: 'US', phone: ''
        },
        shippingAddress: {
            firstName: 'Test', lastName: 'User', address1: '1 Main', city: 'NYC',
            stateCode: 'NY', postalCode: '10001', countryCode: 'US', phone: ''
        },
        lineItems: [{
            sku: 'SKU-1', name: 'Product & Co', quantity: 1,
            unitPrice: 10, netPrice: 10, grossPrice: 11, taxAmount: 1
        }],
        taxes: [],
        discounts: [],
        shipments: [{
            shipmentId: '000001',
            status: 'Ready',
            shippingMethod: 'STANDARD_SHIPPING',
            shippingAddress: {
                firstName: 'Test', lastName: 'User', address1: '1 Main', city: 'NYC',
                stateCode: 'NY', postalCode: '10001', countryCode: 'US', phone: ''
            },
            shippingNet: 0,
            shippingTax: 0,
            shippingGross: 0
        }],
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        confirmationStatus: 'NOT_CONFIRMED',
        channelType: 'Storefront',
        externalOrderNo: '#1001',
        externalOrderText: 'Migrated order',
        customerOrderReference: 'CONF-1001',
        merchandiseTotal: 10,
        shippingTotal: 0,
        taxTotal: 1,
        orderTotal: 11,
        payments: [{
            method: 'CARD',
            amount: 11,
            transactionId: 'txn-1'
        }]
    };
}

describe('sfccOrderXmlGenerator', function () {
    var generator;

    beforeEach(function () {
        generator = proxyquire(generatorPath, {
            '*/cartridge/scripts/migration/orders/localizedString': load('localizedString'),
            '*/cartridge/scripts/migration/orders/orderShippingStatus': load('orderShippingStatus'),
            '*/cartridge/scripts/migration/orders/orderTotalsCalculator': load('orderTotalsCalculator'),
            '*/cartridge/scripts/migration/orders/validators/orderXmlValidator': load('validators/orderXmlValidator'),
            '*/cartridge/scripts/migration/core/runtimeAttrMap': require('*/cartridge/scripts/migration/core/runtimeAttrMap')
        });
    });

    it('should escape XML special characters', function () {
        assert.equal(generator.escapeXml('a & b < c'), 'a &amp; b &lt; c');
    });

    it('should generate single order XML with native export structure', function () {
        var xml = generator.generateOrderXml(sampleOrder('1001'));
        assert.ok(xml.indexOf('<?xml') === 0);
        assert.include(xml, 'xmlns="http://www.demandware.com/xml/impex/order/2006-10-31"');
        assert.ok(xml.indexOf('order-no="1001"') > 0);
        assert.ok(xml.indexOf('<currency>USD</currency>') > 0);
        assert.ok(xml.indexOf('<guest>false</guest>') > 0);
        assert.ok(xml.indexOf('<customer-email>user@example.com</customer-email>') > 0);
        assert.ok(xml.indexOf('<guest>false</guest>') < xml.indexOf('<customer-no>'));
        assert.ok(xml.indexOf('Product &amp; Co') > 0);
        assert.ok(xml.indexOf('<payment-status>PAID</payment-status>') > 0);
        assert.include(xml, '<confirmation-status>NOT_CONFIRMED</confirmation-status>');
        assert.ok(xml.indexOf('<customer-locale>en_US</customer-locale>') > 0);
        assert.include(xml, '<customer-order-reference>CONF-1001</customer-order-reference>');
        assert.include(xml, '<channel-type>Storefront</channel-type>');
        assert.include(xml, '<external-order-no>#1001</external-order-no>');
        assert.include(xml, '<external-order-text>Migrated order</external-order-text>');
        assert.ok(xml.indexOf('<quantity unit="">1.0</quantity>') > 0);
        assert.ok(xml.indexOf('<shipment-id>000001</shipment-id>') > 0);
        assert.ok(xml.indexOf('<shipping-lineitems>') > 0);
        assert.ok(xml.indexOf('<shipment-total>') > 0);
        assert.ok(xml.indexOf('<custom-method>') > 0);
        assert.ok(xml.indexOf('<method-name>CARD</method-name>') > 0);
        var shipmentsPos = xml.indexOf('<shipments>');
        var totalsPos = xml.indexOf('<totals>');
        assert.ok(shipmentsPos > 0 && totalsPos > 0 && shipmentsPos < totalsPos);
        assert.ok(xml.indexOf('</orders>') > 0);
    });

    it('writes the resolved SFCC product ID, and the SKU only when none was found', function () {
        var order = sampleOrder('1002');
        order.lineItems.push({
            sku: 'SKU-2', productId: 'prod-uuid-2', name: 'Variant', quantity: 1,
            unitPrice: 5, netPrice: 5, grossPrice: 5, taxAmount: 0
        });
        var xml = generator.generateOrderInnerXml(order);
        assert.include(xml, '<product-id>SKU-1</product-id>');
        assert.include(xml, '<product-id>prod-uuid-2</product-id>');
        assert.notInclude(xml, '<product-id>SKU-2</product-id>');
    });

    it('writes price adjustments where order.xsd puts them and totals after adjustments', function () {
        var order = sampleOrder('1003');
        order.lineItems[0].priceAdjustments = [{
            promotionId: 'promo-1', lineitemText: 'Discount promo-1', netPrice: -2, taxAmount: -0.2, grossPrice: -2.2
        }];
        order.shippingLineItems = [{
            netPrice: 5, taxAmount: 0, grossPrice: 5, itemId: 'Standard', lineitemText: 'Shipping', taxRate: 0,
            priceAdjustments: [{ promotionId: 'free-ship', netPrice: -5, taxAmount: 0, grossPrice: -5 }]
        }];
        order.priceAdjustments = [{
            promotionId: 'brexit-vat-removal', lineitemText: 'Brexit VAT removal', netPrice: -1, taxAmount: 0, grossPrice: -1,
            customAttributes: [{ id: 'lineItemIds', value: ['li-1'] }]
        }];
        var xml = generator.generateOrderInnerXml(order);

        var pli = xml.slice(xml.indexOf('<product-lineitem>'), xml.indexOf('</product-lineitem>'));
        assert.include(pli, '<promotion-id>promo-1</promotion-id>');
        assert.isBelow(pli.indexOf('<shipment-id>'), pli.indexOf('<price-adjustments>'));
        var sli = xml.slice(xml.indexOf('<shipping-lineitem>'), xml.indexOf('</shipping-lineitem>'));
        assert.isBelow(sli.indexOf('<price-adjustments>'), sli.indexOf('<item-id>'));

        var totals = xml.slice(xml.lastIndexOf('<totals>'));
        var merch = totals.slice(totals.indexOf('<merchandize-total>'), totals.indexOf('</merchandize-total>'));
        assert.include(merch, '<promotion-id>brexit-vat-removal</promotion-id>');
        assert.include(merch, '<custom-attribute attribute-id="lineItemIds">');
        // 10 - 2 (item) - 1 (order) = 7 net; shipping 5 - 5 = 0
        assert.include(totals, '<adjusted-merchandize-total>\n                <net-price>7.00</net-price>');
        assert.include(totals, '<adjusted-shipping-total>\n                <net-price>0.00</net-price>');
        assert.include(totals, '<order-total>\n                <net-price>7.00</net-price>\n                <tax>0.80</tax>\n                <gross-price>7.80</gross-price>');
        generator.assertValidOrderDocument(xml);
    });

    it('writes tracking number, payment processor and transaction type, and address attributes', function () {
        var order = sampleOrder('1004');
        order.shipments[0].trackingNumber = 'TRK1, TRK2';
        order.payments[0].processorId = 'Adyen';
        order.payments[0].transactionType = 'AUTH';
        order.billingAddress.customAttributes = [{ id: 'vatNumber', value: 'FR123' }];
        order.lineItems[0].customAttributes = [{ id: 'configuratorMessages', value: ['Hi', 'There'] }];
        var xml = generator.generateOrderInnerXml(order);

        assert.include(xml, '<shipping-method>STANDARD_SHIPPING</shipping-method>\n                <tracking-number>TRK1, TRK2</tracking-number>');
        var payment = xml.slice(xml.indexOf('<payment>'), xml.indexOf('</payment>'));
        assert.isBelow(payment.indexOf('<amount>'), payment.indexOf('<processor-id>Adyen</processor-id>'));
        assert.isBelow(payment.indexOf('<transaction-id>'), payment.indexOf('<transaction-type>AUTH</transaction-type>'));
        var billing = xml.slice(xml.indexOf('<billing-address>'), xml.indexOf('</billing-address>'));
        assert.isBelow(billing.indexOf('<phone>'), billing.indexOf('<custom-attribute attribute-id="vatNumber">FR123</custom-attribute>'));
        assert.include(xml, '<value>Hi</value>');
        assert.include(xml, '<value>There</value>');
        generator.assertValidOrderDocument(xml);
    });

    it('keeps the totals unchanged when there are no adjustments', function () {
        var xml = generator.generateOrderInnerXml(sampleOrder('1005'));
        var totals = xml.slice(xml.lastIndexOf('<totals>'));
        assert.include(totals, '<merchandize-total>\n                <net-price>10.00</net-price>');
        assert.include(totals, '<adjusted-merchandize-total>\n                <net-price>10.00</net-price>');
        assert.notInclude(xml, '<price-adjustments>');
        assert.notInclude(xml, '<tracking-number>');
    });

    it('serializes collection custom attributes with repeated value elements', function () {
        var order = sampleOrder('1002');
        order.customAttributes = [
            { id: 'spy_migration__labels', value: ['vip', 'fragile & insured'] },
            { id: 'spy_migration__empty_labels', value: ['', null] }
        ];

        var xml = generator.generateOrderXml(order);
        assert.include(xml, '<custom-attribute attribute-id="spy_migration__labels">');
        assert.include(xml, '<value>vip</value>');
        assert.include(xml, '<value>fragile &amp; insured</value>');
        assert.notInclude(xml, 'vip, fragile');
        assert.notInclude(xml, 'spy_migration__empty_labels');
    });

    it('serializes free-form cancellation metadata', function () {
        var order = sampleOrder('1003');
        order.status = 'CANCELLED';
        order.cancelCode = 'inventory';
        order.cancelDescription = 'Shopify cancellation reason: inventory';

        var xml = generator.generateOrderXml(order);
        assert.include(xml, '<cancel-code>inventory</cancel-code>');
        assert.include(xml, '<cancel-description>Shopify cancellation reason: inventory</cancel-description>');
    });

    it('should chunk orders into multiple files', function () {
        var orders = [sampleOrder('1'), sampleOrder('2'), sampleOrder('3')];
        var chunks = generator.generateChunkedXml(orders, 2);

        assert.equal(chunks.length, 2);
        assert.equal(chunks[0].fileName, 'orders_001.xml');
        assert.equal(chunks[1].fileName, 'orders_002.xml');
        assert.ok(chunks[0].content.indexOf('order-no="1"') > 0);
        assert.ok(chunks[0].content.indexOf('order-no="2"') > 0);
        assert.ok(chunks[1].content.indexOf('order-no="3"') > 0);
    });

    it('should default to 5000 orders per chunk', function () {
        assert.equal(generator.DEFAULT_CHUNK_SIZE, 5000);
    });
});
