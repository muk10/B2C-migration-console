'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var cartridgeLoader = require('../helpers/cartridgeLoader');
cartridgeLoader.installCartridgeResolver();

var ordersRoot = path.join(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders');

function load(modulePath) {
    return require(path.join(ordersRoot, modulePath));
}

var generatorPath = path.join(ordersRoot, 'generators/sfccOrderXmlGenerator.js');

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
        assert.ok(xml.indexOf('<customer-locale>en_US</customer-locale>') > 0);
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
