'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path       = require('path');

var mapperPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/mappers/ctpOrderMapper.js'
);

/**
 * @param {string} file - module path relative to the order migration folder
 * @returns {Object} the loaded module
 */
function loadOrderModule(file) {
    return require(path.join(
        __dirname,
        '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders',
        file
    ));
}

var sampleCtOrder = {
    id: 'abc-123',
    orderNumber: 'ORD-1001',
    createdAt: '2024-06-15T10:30:00.000Z',
    locale: 'en-US',
    orderState: 'Complete',
    paymentState: 'Paid',
    shipmentState: 'Shipped',
    customerEmail: 'jane@example.com',
    customerId: 'cust-1',
    billingAddress: {
        firstName: 'Jane',
        lastName: 'Doe',
        streetName: '123 Main St',
        city: 'Boston',
        state: 'MA',
        postalCode: '02101',
        country: 'US',
        phone: '555-0100'
    },
    shippingAddress: {
        firstName: 'Jane',
        lastName: 'Doe',
        streetName: '456 Ship Ln',
        city: 'Boston',
        postalCode: '02102',
        country: 'US'
    },
    lineItems: [{
        id: 'li-1',
        name: { en: 'Blue Widget' },
        quantity: 2,
        variant: { sku: 'WIDGET-BLUE' },
        price: { value: { centAmount: 2500, fractionDigits: 2, currencyCode: 'USD' } },
        taxedPrice: {
            totalNet:   { centAmount: 5000, fractionDigits: 2 },
            totalGross: { centAmount: 5500, fractionDigits: 2 }
        }
    }],
    taxedPrice: {
        totalNet:   { centAmount: 5000, fractionDigits: 2, currencyCode: 'USD' },
        totalGross: { centAmount: 5500, fractionDigits: 2, currencyCode: 'USD' },
        totalTax:   { centAmount: 500, fractionDigits: 2 },
        taxPortions: [{ name: 'Sales Tax', amount: { centAmount: 500, fractionDigits: 2 }, rate: 0.1 }]
    },
    totalPrice: { centAmount: 5500, fractionDigits: 2, currencyCode: 'USD' },
    shippingInfo: {
        shippingMethodName: 'Standard',
        taxedPrice: { totalGross: { centAmount: 0, fractionDigits: 2 } }
    }
};

describe('ctpOrderMapper', function () {
    var mapper;

    beforeEach(function () {
        mapper = proxyquire(mapperPath, {
            '*/cartridge/scripts/migration/orders/canonicalOrder': loadOrderModule('canonicalOrder'),
            '*/cartridge/scripts/migration/orders/localizedString': loadOrderModule('localizedString'),
            '*/cartridge/scripts/migration/orders/orderShippingStatus': loadOrderModule('orderShippingStatus')
        });
    });

    it('should map commercetools order to canonical order', function () {
        var order = mapper.mapOrder(sampleCtOrder);

        assert.equal(order.orderNumber, 'ORD-1001');
        assert.equal(order.currency, 'USD');
        assert.equal(order.customerLocale, 'en_US');
        assert.equal(order.taxation, 'net');
        assert.equal(order.customer.email, 'jane@example.com');
        assert.equal(order.status, 'COMPLETED');
        assert.equal(order.paymentStatus, 'PAID');
        assert.equal(order.shipments[0].shipmentId, '000001');
        assert.equal(order.shipments[0].status, 'SHIPPED');
        assert.equal(order.lineItems.length, 1);
        assert.equal(order.lineItems[0].sku, 'WIDGET-BLUE');
        assert.equal(order.lineItems[0].name, 'Blue Widget');
        assert.equal(order.lineItems[0].quantity, 2);
        assert.equal(order.lineItems[0].unitPrice, 25);
        assert.equal(order.billingAddress.city, 'Boston');
        assert.equal(order.shippingAddress.city, 'Boston');
        assert.equal(order.taxes.length, 1);
        assert.equal(order.taxes[0].amount, 5);
        assert.equal(order.orderTotal, 55);
    });

    it('should convert money amounts from centAmount', function () {
        assert.equal(mapper.moneyToDecimal({ centAmount: 1999, fractionDigits: 2 }), 19.99);
        assert.equal(mapper.moneyToDecimal(null), 0);
    });

    it('should map multiple orders', function () {
        var orders = mapper.mapOrders([sampleCtOrder, sampleCtOrder]);
        assert.equal(orders.length, 2);
        assert.equal(orders[0].orderNumber, 'ORD-1001');
    });

    it('keeps the source product reference so the SFCC product ID can be resolved', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.lineItems[0].productId = 'prod-uuid';
        ct.lineItems[0].productKey = 'widget';
        ct.lineItems[0].variant.id = 3;
        var li = mapper.mapOrder(ct).lineItems[0];
        assert.equal(li.sourceProductId, 'prod-uuid');
        assert.equal(li.sourceProductKey, 'widget');
        assert.equal(li.sourceVariantId, 3);
        assert.equal(li.sku, 'WIDGET-BLUE');
    });

    it('uses the customerNumber as customer-no, like the customer migration', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.customerNumber = '29c1afb71ea2451bade9a99f6fb86d65';
        assert.equal(mapper.mapOrder(ct).customer.id, '29c1afb71ea2451bade9a99f6fb86d65');
    });

    it('falls back to the commercetools customer ID when there is no customerNumber', function () {
        assert.equal(mapper.mapOrder(sampleCtOrder).customer.id, 'cust-1');
    });

    /**
     * @param {number} cents - amount in cents
     * @param {string} [currency] - currency code
     * @returns {Object} commercetools money
     */
    function money(cents, currency) {
        return { centAmount: cents, fractionDigits: 2, currencyCode: currency || 'EUR' };
    }

    it('uses the line total, not the unit price, when a line has no taxedPrice', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        delete ct.lineItems[0].taxedPrice;
        delete ct.taxedPrice;
        ct.lineItems[0].quantity = 2;
        ct.lineItems[0].price.value = money(2149, 'USD');
        ct.lineItems[0].totalPrice = money(4298, 'USD');
        var li = mapper.mapOrder(ct).lineItems[0];
        assert.equal(li.netPrice, 42.98);
        assert.equal(li.grossPrice, 42.98);
        assert.equal(li.unitPrice, 21.49);
    });

    it('writes discounted lines as the price before discount plus one adjustment per discount', function () {
        // real EU order: 79.00 incl. 5.5% VAT, 23.70 off, paid 55.30 gross / 52.42 net
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.lineItems[0] = {
            id: 'li-1', productId: 'p', variant: { id: 1, sku: '9004' }, quantity: 1, name: { en: 'Pack' },
            price: { value: money(7900) }, totalPrice: money(5530),
            taxRate: { amount: 0.055, includedInPrice: true },
            taxedPrice: { totalNet: money(5242), totalGross: money(5530) },
            discountedPricePerQuantity: [{ quantity: 1, discountedPrice: { value: money(5530), includedDiscounts: [
                { discount: { typeId: 'cart-discount', id: 'cd-1' }, discountedAmount: money(2370) }
            ] } }]
        };
        var order = mapper.mapOrder(ct);
        var li = order.lineItems[0];
        assert.equal(order.taxation, 'gross');
        assert.equal(li.taxRate, 0.055);
        assert.equal(li.grossPrice, 79);
        assert.lengthOf(li.priceAdjustments, 1);
        var adj = li.priceAdjustments[0];
        assert.equal(adj.promotionId, 'cd-1');
        assert.equal(Math.round((li.grossPrice + adj.grossPrice) * 100), 5530);
        assert.equal(Math.round((li.netPrice + adj.netPrice) * 100), 5242);
    });

    it('maps custom line items to the order.xsd element that fits', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.customLineItems = [
            { id: 'c1', slug: 'brexit-vat-removal', name: { en: 'Brexit VAT removal' }, quantity: 1,
                money: money(-8167), totalPrice: money(-8167), taxedPrice: { totalNet: money(-8167), totalGross: money(-8167) } },
            { id: 'c2', slug: 'shipping-surcharge', name: { en: 'shipping-surcharge' }, quantity: 1,
                money: money(2000), totalPrice: money(2000) },
            { id: 'c3', slug: 'greeting-card', name: { en: 'Gift Message' }, quantity: 1, money: money(0), totalPrice: money(0),
                custom: { fields: { message: 'Happy birthday' } } }
        ];
        var order = mapper.mapOrder(ct);
        assert.equal(order.priceAdjustments[0].promotionId, 'brexit-vat-removal');
        assert.equal(order.priceAdjustments[0].grossPrice, -81.67);
        var surcharge = order.shippingLineItems.filter(function (s) { return s.itemId === 'shipping-surcharge'; })[0];
        assert.equal(surcharge.grossPrice, 20);
        var card = order.lineItems.filter(function (l) { return l.sku === 'greeting-card'; })[0];
        assert.equal(card.name, 'Gift Message');
        assert.deepEqual(card.customAttributes, [{ id: 'message', value: 'Happy birthday' }]);
    });

    it('maps payment, tracking, workflow state and order fields without an order.xsd element', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.paymentInfo = { payments: [{ typeId: 'payment', id: 'pay-1', obj: {
            id: 'pay-1', amountPlanned: money(5500, 'USD'),
            paymentMethodInfo: { paymentInterface: 'Adyen', method: 'scheme' },
            transactions: [{ type: 'Authorization', state: 'Success', interactionId: 'PSP-1' }],
            custom: { fields: { merchantReference: 'MR-1' } }
        } }] };
        ct.shippingInfo.deliveries = [{ parcels: [{ trackingData: { trackingId: 'TRK1' } }, { trackingData: { trackingId: 'TRK2' } }] }];
        ct.state = { typeId: 'state', id: 's-1', obj: { key: 'Created' } };
        ct.store = { typeId: 'store', key: 'eu-store' };
        ct.custom = { fields: { featureExperimentations: ['a', 'b'], deposit: money(1250), isB2BOrder: true } };
        var order = mapper.mapOrder(ct);

        assert.include(order.payments[0], { method: 'scheme', processorId: 'Adyen', transactionId: 'PSP-1', transactionType: 'AUTH' });
        assert.deepEqual(order.payments[0].customAttributes, [{ id: 'merchantReference', value: 'MR-1' }]);
        assert.equal(order.shipments[0].trackingNumber, 'TRK1, TRK2');
        assert.equal(order.externalOrderStatus, 'Created');
        var attrs = {};
        order.customAttributes.forEach(function (a) { attrs[a.id] = a.value; });
        assert.deepEqual(attrs.featureExperimentations, ['a', 'b']);
        assert.equal(attrs.deposit, 12.5);
        assert.equal(attrs.isB2BOrder, true);
        assert.equal(attrs.store, 'eu-store');
    });

    it('keeps address custom fields and email as address custom attributes', function () {
        var addr = mapper.mapAddress({ firstName: 'A', country: 'FR', email: 'a@b.c', custom: { fields: { vatNumber: 'FR1', addressType: 'RESIDENTIAL' } } });
        assert.deepEqual(addr.customAttributes, [
            { id: 'vatNumber', value: 'FR1' }, { id: 'addressType', value: 'RESIDENTIAL' }, { id: 'email', value: 'a@b.c' }
        ]);
    });

    it('spreads order-level tax over the lines for External tax orders', function () {
        var ct = JSON.parse(JSON.stringify(sampleCtOrder));
        ct.taxMode = 'External';
        ct.lineItems = [
            { id: 'a', variant: { sku: 'A' }, quantity: 1, price: { value: money(3000, 'USD') }, totalPrice: money(3000, 'USD') },
            { id: 'b', variant: { sku: 'B' }, quantity: 1, price: { value: money(1999, 'USD') }, totalPrice: money(1999, 'USD') }
        ];
        ct.taxedPrice = { totalNet: money(4999, 'USD'), totalGross: money(5299, 'USD'), totalTax: money(300, 'USD') };
        delete ct.shippingInfo;
        var order = mapper.mapOrder(ct);
        var tax = order.lineItems[0].taxAmount + order.lineItems[1].taxAmount;
        assert.equal(Math.round(tax * 100), 300);
        assert.equal(Math.round((order.lineItems[0].grossPrice + order.lineItems[1].grossPrice) * 100), 5299);
    });
});
