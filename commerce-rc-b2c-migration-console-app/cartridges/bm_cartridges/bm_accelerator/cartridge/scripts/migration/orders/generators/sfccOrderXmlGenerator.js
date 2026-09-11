'use strict';

var localizedString     = require('*/cartridge/scripts/migration/orders/localizedString').localizedString;
var orderShippingStatus = require('*/cartridge/scripts/migration/orders/orderShippingStatus');
var orderTotals         = require('*/cartridge/scripts/migration/orders/orderTotalsCalculator');
var orderXmlValidator   = require('*/cartridge/scripts/migration/orders/validators/orderXmlValidator');
var runtimeAttrMap      = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

var XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
var NS_ORDER   = orderXmlValidator.NS_ORDER;

/**
 * Escape XML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Format a number to two decimal places for XML.
 * @param {number} n
 * @returns {string}
 */
function fmtMoney(n) {
    var val = parseFloat(n) || 0;
    return val.toFixed(2);
}

/**
 * Format tax rate for XML (up to 4 decimal places).
 * @param {number} rate
 * @returns {string}
 */
function fmtTaxRate(rate) {
    var val = parseFloat(rate) || 0;
    return val.toFixed(4);
}

/**
 * Normalize order date to SFCC export style.
 * @param {string} dateStr
 * @returns {string}
 */
function formatOrderDate(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

/**
 * Build XML for an address block (order.xsd Address sequence).
 * @param {string} tagName
 * @param {Object} addr
 * @param {string} indent
 * @returns {string}
 */
function addressXml(tagName, addr, indent) {
    if (!addr) return '';

    var pad = indent || '        ';
    var inner = pad + '    ';
    var address1 = String(addr.address1 || '');
    if (addr.address2) {
        address1 = (address1 + ' ' + String(addr.address2)).trim();
    }

    var lines = [
        pad + '<' + tagName + '>',
        inner + '<first-name>' + escapeXml(addr.firstName) + '</first-name>',
        inner + '<last-name>' + escapeXml(addr.lastName) + '</last-name>'
    ];

    if (addr.company) {
        lines.push(inner + '<company-name>' + escapeXml(addr.company) + '</company-name>');
    }

    lines.push(inner + '<address1>' + escapeXml(address1) + '</address1>');
    lines.push(inner + '<city>' + escapeXml(addr.city) + '</city>');
    lines.push(inner + '<postal-code>' + escapeXml(addr.postalCode) + '</postal-code>');
    lines.push(inner + '<state-code>' + escapeXml(addr.stateCode) + '</state-code>');
    lines.push(inner + '<country-code>' + escapeXml(addr.countryCode) + '</country-code>');
    lines.push(inner + '<phone>' + escapeXml(addr.phone) + '</phone>');
    lines.push(pad + '</' + tagName + '>');
    return lines.join('\n');
}

/**
 * Shared line-item amount fields in XSD order.
 * @param {Object} li
 * @param {string} indent
 * @param {string} lineitemText
 * @returns {string[]}
 */
function lineItemAmountLines(li, indent, lineitemText) {
    return [
        indent + '<net-price>' + fmtMoney(li.netPrice) + '</net-price>',
        indent + '<tax>' + fmtMoney(li.taxAmount) + '</tax>',
        indent + '<gross-price>' + fmtMoney(li.grossPrice) + '</gross-price>',
        indent + '<base-price>' + fmtMoney(li.basePrice !== undefined ? li.basePrice : li.unitPrice) + '</base-price>',
        indent + '<lineitem-text>' + escapeXml(lineitemText) + '</lineitem-text>',
        indent + '<tax-basis>' + fmtMoney(li.taxBasis) + '</tax-basis>'
    ];
}

function lineItemDisplayName(li) {
    return localizedString(li.name, li.sku || '');
}

/**
 * Render a net/tax/gross totals group.
 * @param {string} tag
 * @param {Object} amounts
 * @param {string} indent
 * @returns {string}
 */
function totalsGroupXml(tag, amounts, indent) {
    var inner = indent + '    ';
    return [
        indent + '<' + tag + '>',
        inner + '<net-price>' + fmtMoney(amounts.net) + '</net-price>',
        inner + '<tax>' + fmtMoney(amounts.tax) + '</tax>',
        inner + '<gross-price>' + fmtMoney(amounts.gross) + '</gross-price>',
        indent + '</' + tag + '>'
    ].join('\n');
}

/**
 * @param {Object} totals
 * @param {string} indent
 * @param {boolean} shipmentLevel
 * @returns {string}
 */
function totalsBlockXml(totals, indent, shipmentLevel) {
    var parts = [indent + '<totals>'];
    parts.push(totalsGroupXml('merchandize-total', totals.merchandise, indent + '    '));
    parts.push(totalsGroupXml('adjusted-merchandize-total', totals.merchandise, indent + '    '));
    parts.push(totalsGroupXml('shipping-total', totals.shipping, indent + '    '));
    parts.push(totalsGroupXml('adjusted-shipping-total', totals.shipping, indent + '    '));
    if (shipmentLevel) {
        parts.push(totalsGroupXml('shipment-total', totals.shipment, indent + '    '));
    } else {
        parts.push(totalsGroupXml('order-total', totals.order, indent + '    '));
    }
    parts.push(indent + '</totals>');
    return parts.join('\n');
}

/**
 * @param {Object} order
 * @returns {string}
 */
function customerXml(order) {
    var customer = order.customer || {};
    var isGuest = customer.guest === true || !customer.id;
    var parts = [
        '        <customer>',
        '            <guest>' + (isGuest ? 'true' : 'false') + '</guest>',
        '            <customer-no>' + escapeXml(customer.id || customer.email) + '</customer-no>',
        '            <customer-name>' + escapeXml((customer.firstName + ' ' + customer.lastName).trim()) + '</customer-name>',
        '            <customer-email>' + escapeXml(customer.email) + '</customer-email>',
        addressXml('billing-address', order.billingAddress, '            '),
        '        </customer>'
    ];
    return parts.join('\n');
}

/**
 * @param {Object[]} lineItems
 * @returns {string}
 */
function productLineItemsXml(lineItems) {
    var parts = ['        <product-lineitems>'];
    for (var i = 0; i < lineItems.length; i++) {
        var li = lineItems[i];
        var displayName = lineItemDisplayName(li);
        var qty = parseFloat(li.quantity) || 1;
        var indent = '                ';
        parts.push('            <product-lineitem>');
        var amountLines = lineItemAmountLines(li, indent, displayName);
        for (var a = 0; a < amountLines.length; a++) {
            parts.push(amountLines[a]);
        }
        parts.push(indent + '<position>' + (i + 1) + '</position>');
        parts.push(indent + '<product-id>' + escapeXml(li.sku) + '</product-id>');
        parts.push(indent + '<product-name>' + escapeXml(displayName) + '</product-name>');
        parts.push(indent + '<quantity unit="">' + qty.toFixed(1) + '</quantity>');
        parts.push(indent + '<tax-rate>' + fmtTaxRate(li.taxRate) + '</tax-rate>');
        parts.push(indent + '<shipment-id>' + escapeXml(li.shipmentId) + '</shipment-id>');
        parts.push('            </product-lineitem>');
    }
    parts.push('        </product-lineitems>');
    return parts.join('\n');
}

/**
 * @param {Object[]} shippingLineItems
 * @returns {string}
 */
function shippingLineItemsXml(shippingLineItems) {
    var parts = ['        <shipping-lineitems>'];
    for (var i = 0; i < shippingLineItems.length; i++) {
        var li = shippingLineItems[i];
        var text = li.lineitemText || 'Shipping';
        var indent = '                ';
        parts.push('            <shipping-lineitem>');
        var amountLines = lineItemAmountLines(li, indent, text);
        for (var a = 0; a < amountLines.length; a++) {
            parts.push(amountLines[a]);
        }
        parts.push(indent + '<item-id>' + escapeXml(li.itemId || 'STANDARD_SHIPPING') + '</item-id>');
        parts.push(indent + '<shipment-id>' + escapeXml(li.shipmentId) + '</shipment-id>');
        parts.push(indent + '<tax-rate>' + fmtTaxRate(li.taxRate) + '</tax-rate>');
        parts.push('            </shipping-lineitem>');
    }
    parts.push('        </shipping-lineitems>');
    return parts.join('\n');
}

/**
 * @param {Object[]} shipments
 * @returns {string}
 */
function shipmentsXml(shipments) {
    var parts = ['        <shipments>'];
    for (var i = 0; i < shipments.length; i++) {
        var s = shipments[i];
        var shipmentId = escapeXml(s.shipmentId || s.id);
        var shippingStatus = orderShippingStatus.mapShipmentShippingStatus(s.status);
        parts.push('            <shipment shipment-id="' + shipmentId + '">');
        parts.push('                <status>');
        parts.push('                    <shipping-status>' + shippingStatus + '</shipping-status>');
        parts.push('                </status>');
        if (s.shippingMethod) {
            parts.push('                <shipping-method>' + escapeXml(s.shippingMethod) + '</shipping-method>');
        }
        parts.push(addressXml('shipping-address', s.shippingAddress, '                '));
        if (s.totals) {
            parts.push(totalsBlockXml(s.totals, '                ', true));
        }
        parts.push('            </shipment>');
    }
    parts.push('        </shipments>');
    return parts.join('\n');
}

/**
 * @param {Object[]} payments
 * @returns {string}
 */
function paymentsXml(payments) {
    if (!payments || !payments.length) return '';
    var parts = ['        <payments>'];
    for (var i = 0; i < payments.length; i++) {
        var p = payments[i];
        parts.push('            <payment>');
        if (p.method) {
            parts.push('                <custom-method>');
            parts.push('                    <method-name>' + escapeXml(p.method) + '</method-name>');
            parts.push('                </custom-method>');
        }
        if (p.amount !== undefined && p.amount !== null) {
            parts.push('                <amount>' + fmtMoney(p.amount) + '</amount>');
        }
        if (p.transactionId) {
            parts.push('                <transaction-id>' + escapeXml(p.transactionId) + '</transaction-id>');
        }
        parts.push('            </payment>');
    }
    parts.push('        </payments>');
    return parts.join('\n');
}

/**
 * @param {Object} order
 * @returns {Object}
 */
function prepareOrder(order) {
    return orderTotals.reconcileOrder(order);
}

/**
 * Generate inner <order> XML block (no wrapper).
 * @param {Object} order - CanonicalOrder
 * @returns {string}
 */
function generateOrderInnerXml(order) {
    var prepared = prepareOrder(order);
    var mapped = runtimeAttrMap.applyEntries(prepared.customAttributes || [], 'order');
    if (!prepared.customer) prepared.customer = {};
    if ((!prepared.customer.email) && mapped.system.customerEmail) {
        prepared.customer.email = mapped.system.customerEmail;
    }
    if ((!prepared.customer.id) && mapped.system.customerNo) {
        prepared.customer.id = mapped.system.customerNo;
    }
    if ((!prepared.customerLocale) && mapped.system.customerLocaleID) {
        prepared.customerLocale = mapped.system.customerLocaleID;
    }
    if ((!prepared.status) && mapped.system.status) {
        prepared.status = mapped.system.status;
    }
    var orderNo = escapeXml(prepared.orderNumber);
    var parts   = [
        '    <order order-no="' + orderNo + '">',
        '        <order-date>' + escapeXml(formatOrderDate(prepared.createdAt)) + '</order-date>',
        '        <created-by>migration</created-by>',
        '        <original-order-no>' + orderNo + '</original-order-no>',
        '        <currency>' + escapeXml(prepared.currency) + '</currency>',
        '        <customer-locale>' + escapeXml(prepared.customerLocale || 'en_US') + '</customer-locale>',
        '        <taxation>' + escapeXml(prepared.taxation || 'net') + '</taxation>',
        customerXml(prepared),
        '        <status>',
        '            <order-status>' + escapeXml(prepared.status || 'NEW') + '</order-status>',
        '            <shipping-status>' + orderShippingStatus.mapOrderShippingStatus(prepared.shipments[0] && prepared.shipments[0].status) + '</shipping-status>',
        '            <confirmation-status>CONFIRMED</confirmation-status>',
        '            <payment-status>' + escapeXml(prepared.paymentStatus || 'NOT_PAID') + '</payment-status>',
        '        </status>',
        '        <current-order-no>' + orderNo + '</current-order-no>',
        productLineItemsXml(prepared.lineItems),
        shippingLineItemsXml(prepared.shippingLineItems),
        shipmentsXml(prepared.shipments),
        totalsBlockXml(prepared.totals, '        ', false)
    ];
    var paymentsBlock = paymentsXml(prepared.payments);
    if (paymentsBlock) {
        parts.push(paymentsBlock);
    }

    var externalNo = mapped.system.externalOrderNo;
    var externalStatus = mapped.system.externalOrderStatus;
    var externalText = mapped.system.externalOrderText;
    if (externalNo) {
        parts.push('        <external-order-no>' + escapeXml(externalNo) + '</external-order-no>');
    }
    if (externalStatus) {
        parts.push('        <external-order-status>' + escapeXml(externalStatus) + '</external-order-status>');
    }
    if (externalText) {
        parts.push('        <external-order-text>' + escapeXml(externalText) + '</external-order-text>');
    }

    if (mapped.custom && mapped.custom.length) {
        parts.push('        <custom-attributes>');
        for (var c = 0; c < mapped.custom.length; c++) {
            var attr = mapped.custom[c];
            if (!attr || !attr.id || attr.value === '' || attr.value == null) continue;
            parts.push('            <custom-attribute attribute-id="' + escapeXml(attr.id) + '">'
                + escapeXml(runtimeAttrMap.formatCustomAttrValue(attr.value)) + '</custom-attribute>');
        }
        parts.push('        </custom-attributes>');
    }

    parts.push('    </order>');
    return parts.join('\n');
}

function buildHeader() {
    return XML_HEADER + '<orders xmlns="' + NS_ORDER + '">\n';
}

function buildFooter() {
    return '</orders>\n';
}

/**
 * Validate one order inner fragment wrapped in a minimal orders document.
 * @param {string} innerXml
 */
function assertValidOrderDocument(innerXml) {
    orderXmlValidator.assertValidOrderXml(buildHeader() + innerXml + buildFooter());
}

/**
 * Generate SFCC order XML for a single canonical order.
 * @param {Object} order - CanonicalOrder
 * @returns {string}
 */
function generateOrderXml(order) {
    var xml = buildHeader() + generateOrderInnerXml(order) + buildFooter();
    orderXmlValidator.assertValidOrderXml(xml);
    return xml;
}

/**
 * Generate chunked XML files from an array of canonical orders.
 * @param {Object[]} orders
 * @param {number} [chunkSize=5000]
 * @returns {Object[]} { fileName, content }[]
 */
function generateChunkedXml(orders, chunkSize) {
    var size   = chunkSize || 5000;
    var chunks = [];
    var total  = orders.length;
    var fileIndex = 1;

    for (var offset = 0; offset < total; offset += size) {
        var slice  = [];
        var end    = Math.min(offset + size, total);
        for (var i = offset; i < end; i++) {
            slice.push(orders[i]);
        }

        var parts = [buildHeader()];
        for (var j = 0; j < slice.length; j++) {
            parts.push(generateOrderInnerXml(slice[j]));
        }
        parts.push(buildFooter());

        var xml = parts.join('');
        orderXmlValidator.assertValidOrderXml(xml);

        var padded = String(fileIndex);
        while (padded.length < 3) padded = '0' + padded;

        chunks.push({
            fileName: 'orders_' + padded + '.xml',
            content:  xml
        });
        fileIndex++;
    }

    return chunks;
}

module.exports = {
    NS_ORDER:                NS_ORDER,
    escapeXml:               escapeXml,
    fmtMoney:                fmtMoney,
    formatOrderDate:         formatOrderDate,
    prepareOrder:            prepareOrder,
    buildHeader:             buildHeader,
    buildFooter:             buildFooter,
    assertValidOrderDocument: assertValidOrderDocument,
    generateOrderInnerXml:   generateOrderInnerXml,
    generateOrderXml:        generateOrderXml,
    generateChunkedXml:      generateChunkedXml,
    DEFAULT_CHUNK_SIZE:      5000
};
