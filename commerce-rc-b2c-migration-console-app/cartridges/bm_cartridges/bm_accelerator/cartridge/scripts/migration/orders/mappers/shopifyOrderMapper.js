'use strict';

var canonicalOrder      = require('*/cartridge/scripts/migration/orders/canonicalOrder');
var orderShippingStatus = require('*/cartridge/scripts/migration/orders/orderShippingStatus');
var sourceAttrIds       = require('*/cartridge/scripts/migration/core/sourceAttrIds');
var attrIdMapSession    = require('*/cartridge/scripts/migration/core/attrIdMapSession');

function parseMoney(val) {
    var n = parseFloat(String(val || '0'));
    return isNaN(n) ? 0 : n;
}

/**
 * Convert Shopify locale notation to the underscore form used by SFCC.
 * @param {string} locale
 * @returns {string}
 */
function mapLocale(locale) {
    return locale ? String(locale).replace(/-/g, '_') : 'en_US';
}

/**
 * Map Shopify order sources to values accepted by the SFCC order XSD.
 * @param {string} sourceName
 * @returns {string}
 */
function mapChannelType(sourceName) {
    var source = String(sourceName || '').toLowerCase();
    if (source === 'pos' || source === 'point_of_sale') return 'Store';
    if (source === 'shopify_draft_order') return 'CustomerServiceCenter';
    if (source === 'facebook' || source === 'facebook_ads') return 'FacebookAds';
    if (source === 'instagram') return 'InstagramCommerce';
    if (source === 'google') return 'Google';
    if (source === 'tiktok') return 'TikTok';
    return 'Storefront';
}

/**
 * Convert Shopify's inventory-reservation flag to the requested SFCC
 * confirmation-status policy. Only an explicit boolean true is confirmed;
 * missing or unexpected values remain safely unconfirmed.
 * @param {*} confirmed Shopify confirmed value.
 * @returns {string} SFCC confirmation status.
 */
function mapConfirmationStatus(confirmed) {
    return confirmed === true ? 'CONFIRMED' : 'NOT_CONFIRMED';
}

/**
 * Add a non-empty value to the canonical custom-attribute collection.
 * Boolean false is a meaningful value and must not be dropped.
 * @param {Object[]} attributes
 * @param {string} id
 * @param {*} value
 */
function addCustomAttribute(attributes, id, value) {
    if (value === null || value === undefined || value === '') return;
    attributes.push({ id: id, value: value });
}

/**
 * Map dynamically discovered Shopify order metafields to SFCC custom attributes.
 * @param {Object} shopOrder
 * @returns {Object[]}
 */
function mapCustomAttributes(shopOrder) {
    var attributes = [];

    var metafields = shopOrder.metafields || [];
    var attrMap = attrIdMapSession.read('order');
    var i;
    for (i = 0; i < metafields.length; i++) {
        var metafield = metafields[i] || {};
        if (!metafield.key) continue;
        var rawId = metafield.namespace
            ? metafield.namespace + '__' + metafield.key
            : metafield.key;
        var canonicalId = sourceAttrIds.toAttrId(rawId, 'shopify');
        addCustomAttribute(
            attributes,
            attrIdMapSession.resolve(canonicalId, attrMap),
            metafield.value
        );
    }
    return attributes;
}

function mapAddress(addr) {
    if (!addr) return canonicalOrder.emptyAddress();
    return {
        firstName:   addr.first_name || '',
        lastName:    addr.last_name  || '',
        company:     addr.company     || '',
        address1:    addr.address1    || '',
        address2:    addr.address2    || '',
        city:        addr.city        || '',
        stateCode:   addr.province_code || addr.province || '',
        postalCode:  addr.zip         || '',
        countryCode: addr.country_code || addr.country || '',
        phone:       addr.phone       || ''
    };
}

function mapCustomer(shopOrder) {
    var customer = shopOrder.customer || {};
    return {
        id:        customer.id ? String(customer.id) : '',
        email:     shopOrder.email || customer.email || '',
        firstName: customer.first_name || (shopOrder.billing_address && shopOrder.billing_address.first_name) || '',
        lastName:  customer.last_name  || (shopOrder.billing_address && shopOrder.billing_address.last_name)  || ''
    };
}

function mapLineItems(shopOrder) {
    var items    = shopOrder.line_items || [];
    var currency = shopOrder.currency || '';
    var mapped   = [];
    var i;

    for (i = 0; i < items.length; i++) {
        var li     = items[i];
        var unit   = parseMoney(li.price);
        var qty    = li.quantity || 1;
        var gross  = unit * qty;
        var taxAmt = 0;
        var taxes  = li.tax_lines || [];
        var ti;
        for (ti = 0; ti < taxes.length; ti++) {
            taxAmt += parseMoney(taxes[ti].price);
        }

        mapped.push({
            id:         li.id ? String(li.id) : String(i + 1),
            sku:        li.variant_id ? String(li.variant_id) : '',
            name:       li.title || li.name || '',
            quantity:   qty,
            unitPrice:  unit,
            taxAmount:  taxAmt,
            grossPrice: gross + taxAmt,
            netPrice:   gross,
            currency:   currency
        });
    }
    return mapped;
}

function mapTaxes(shopOrder) {
    var taxes  = [];
    var lines  = shopOrder.tax_lines || [];
    var i;
    for (i = 0; i < lines.length; i++) {
        var tl = lines[i];
        taxes.push({
            name:   tl.title || 'Tax',
            amount: parseMoney(tl.price),
            rate:   tl.rate || 0
        });
    }
    return taxes;
}

function mapDiscounts(shopOrder) {
    var discounts = [];
    var codes     = shopOrder.discount_codes || [];
    var i;
    for (i = 0; i < codes.length; i++) {
        var dc = codes[i];
        discounts.push({
            id:          dc.code || ('discount-' + i),
            code:        dc.code || '',
            amount:      parseMoney(dc.amount),
            description: dc.type || 'Discount'
        });
    }
    return discounts;
}

function mapFulfillmentStatus(status) {
    if (!status || status === 'unfulfilled') return 'NOT_SHIPPED';
    if (status === 'fulfilled' || status === 'shipped' || status === 'success') return 'SHIPPED';
    if (status === 'partial') return 'PARTIAL';
    return String(status).toUpperCase();
}

function mapShipments(shopOrder) {
    var shipments = [];
    var fulfillments = shopOrder.fulfillments || [];
    var shipLines = shopOrder.shipping_lines || [];
    var shipNet   = 0;
    var shipTax   = 0;
    var i;

    for (i = 0; i < shipLines.length; i++) {
        shipNet += parseMoney(shipLines[i].price);
        var stl = shipLines[i].tax_lines || [];
        var si;
        for (si = 0; si < stl.length; si++) {
            shipTax += parseMoney(stl[si].price);
        }
    }

    var shipMethod = shipLines.length ? (shipLines[0].title || 'STANDARD_SHIPPING') : 'STANDARD_SHIPPING';
    var shipStatus = fulfillments.length
        ? mapFulfillmentStatus(fulfillments[0].status)
        : orderShippingStatus.mapShippingStatus(mapFulfillmentStatus(shopOrder.fulfillment_status));

    shipments.push({
        shipmentId:      '000001',
        status:          shipStatus,
        shippingMethod:  shipMethod,
        shippingAddress: mapAddress(shopOrder.shipping_address),
        shippingNet:     shipNet,
        shippingTax:     shipTax,
        shippingGross:   shipNet + shipTax
    });

    return shipments;
}

function mapPaymentStatus(financialStatus) {
    var map = {
        paid:              'PAID',
        partially_paid:    'PART_PAID',
        pending:           'NOT_PAID',
        authorized:        'NOT_PAID',
        refunded:          'PAID',
        partially_refunded: 'PAID',
        voided:            'NOT_PAID'
    };
    return map[financialStatus] || 'NOT_PAID';
}

function mapOrderStatus(shopOrder) {
    if (shopOrder.cancelled_at) return 'CANCELLED';
    if (shopOrder.closed_at) return 'COMPLETED';
    if (shopOrder.fulfillment_status === 'fulfilled') return 'COMPLETED';
    return 'OPEN';
}

function mapPayments(shopOrder) {
    var payments = [];
    if (shopOrder.financial_status) {
        payments.push({
            method:        'SHOPIFY_PAYMENTS',
            amount:        parseMoney(shopOrder.total_price),
            transactionId: shopOrder.id ? String(shopOrder.id) : ''
        });
    }
    return payments;
}

/**
 * @param {Object} shopOrder
 * @returns {Object}
 */
function mapOrder(shopOrder) {
    var order    = canonicalOrder.createEmpty();
    var currency = shopOrder.currency || '';

    order.orderNumber      = shopOrder.order_number != null
        ? String(shopOrder.order_number)
        : String(shopOrder.id || shopOrder.name || '');
    order.currency         = currency;
    order.createdAt        = shopOrder.created_at || '';
    order.customerLocale   = mapLocale(shopOrder.customer_locale);
    order.taxation         = shopOrder.taxes_included ? 'gross' : 'net';
    order.customer         = mapCustomer(shopOrder);
    order.billingAddress   = mapAddress(shopOrder.billing_address);
    order.shippingAddress  = mapAddress(shopOrder.shipping_address);
    order.lineItems        = mapLineItems(shopOrder);
    order.taxes            = mapTaxes(shopOrder);
    order.discounts        = mapDiscounts(shopOrder);
    order.shipments        = mapShipments(shopOrder);
    order.payments         = mapPayments(shopOrder);
    order.customAttributes = mapCustomAttributes(shopOrder);
    order.status           = mapOrderStatus(shopOrder);
    order.paymentStatus    = mapPaymentStatus(shopOrder.financial_status);
    order.confirmationStatus = mapConfirmationStatus(shopOrder.confirmed);
    order.channelType      = mapChannelType(shopOrder.source_name);
    order.externalOrderNo  = shopOrder.name || '';
    order.externalOrderText = shopOrder.note || '';

    order.merchandiseTotal = parseMoney(shopOrder.subtotal_price);
    order.shippingTotal    = shopOrder.total_shipping_price_set && shopOrder.total_shipping_price_set.shop_money
        ? parseMoney(shopOrder.total_shipping_price_set.shop_money.amount)
        : 0;
    if (!order.shippingTotal && shopOrder.shipping_lines) {
        var si;
        for (si = 0; si < shopOrder.shipping_lines.length; si++) {
            order.shippingTotal += parseMoney(shopOrder.shipping_lines[si].price);
        }
    }
    order.taxTotal   = parseMoney(shopOrder.total_tax);
    order.orderTotal = parseMoney(shopOrder.total_price);

    return order;
}

function mapOrders(shopOrders) {
    var mapped = [];
    var i;
    for (i = 0; i < shopOrders.length; i++) {
        mapped.push(mapOrder(shopOrders[i]));
    }
    return mapped;
}

module.exports = {
    mapOrder:   mapOrder,
    mapOrders:  mapOrders,
    mapAddress: mapAddress,
    mapLocale:  mapLocale,
    mapChannelType: mapChannelType,
    mapConfirmationStatus: mapConfirmationStatus,
    mapCustomAttributes: mapCustomAttributes
};
