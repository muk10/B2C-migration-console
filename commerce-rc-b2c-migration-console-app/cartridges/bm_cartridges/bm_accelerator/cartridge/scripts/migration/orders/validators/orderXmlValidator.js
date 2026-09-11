'use strict';

var NS_ORDER = 'http://www.demandware.com/xml/impex/order/2006-10-31';

/**
 * Structural validation for generated order IMPEX XML (native export shape).
 * @param {string} xml
 * @returns {Object} { valid, errors }
 */
function validateOrderXml(xml) {
    var errors = [];
    var content = String(xml || '');

    if (content.indexOf('xmlns="' + NS_ORDER + '"') < 0) {
        errors.push('Missing or incorrect orders namespace');
    }
    if (content.indexOf('<billing-address>') < 0) {
        errors.push('Missing billing-address');
    }
    if (content.indexOf('</customer>') >= 0 && content.indexOf('<customer>') >= 0) {
        var customerBlock = content.substring(
            content.indexOf('<customer>'),
            content.indexOf('</customer>') + '</customer>'.length
        );
        if (customerBlock.indexOf('<billing-address>') < 0) {
            errors.push('billing-address must be nested inside customer');
        }
        if (customerBlock.indexOf('<guest>') < 0) {
            errors.push('customer guest flag is required (order.xsd / version 19.2+)');
        } else if (customerBlock.indexOf('<guest>') > customerBlock.indexOf('<customer-no>')) {
            errors.push('guest must appear before customer-no');
        }
    }
    if (/<order[^>]*>[\s\S]*<shipping-address>/.test(content)
        && content.indexOf('<shipment') >= 0) {
        var afterFirstOrder = content.substring(content.indexOf('<order'));
        var shipmentsIdx = afterFirstOrder.indexOf('<shipments>');
        var shipAddrBeforeShipments = afterFirstOrder.indexOf('<shipping-address>');
        if (shipmentsIdx < 0 || (shipAddrBeforeShipments >= 0 && shipAddrBeforeShipments < shipmentsIdx)) {
            var betweenCustomerAndShipments = afterFirstOrder.substring(0, shipmentsIdx > 0 ? shipmentsIdx : afterFirstOrder.length);
            if (betweenCustomerAndShipments.indexOf('<shipping-address>') >= 0
                && betweenCustomerAndShipments.indexOf('<shipping-lineitem>') < 0) {
                errors.push('order-level shipping-address is not allowed');
            }
        }
    }
    if (content.indexOf('<product-lineitem>') >= 0 && content.indexOf('<shipment-id>') < 0) {
        errors.push('product line items must include shipment-id');
    }
    if (content.indexOf('<quantity>') >= 0 && content.indexOf('<quantity unit=') < 0) {
        errors.push('quantity must use unit attribute form');
    }
    if (content.indexOf('<customer-locale>') < 0) {
        errors.push('Missing customer-locale');
    }
    if (content.indexOf('<taxation>') < 0) {
        errors.push('Missing taxation');
    }
    if (content.indexOf('<shipping-lineitems>') < 0) {
        errors.push('Missing shipping-lineitems');
    }
    if (content.indexOf('<shipment shipment-id=') < 0) {
        errors.push('Missing shipment shipment-id attribute');
    }
    if (content.indexOf('<shipment-total>') < 0) {
        errors.push('Missing shipment-total inside shipment totals');
    }

    var orderBlocks = content.match(/<order[^>]*>[\s\S]*?<\/order>/g) || [];
    for (var o = 0; o < orderBlocks.length; o++) {
        var orderBlock = orderBlocks[o];
        var shipmentsIdx = orderBlock.indexOf('<shipments>');
        var totalsIdx = orderBlock.indexOf('<totals>');
        if (shipmentsIdx >= 0 && totalsIdx >= 0 && shipmentsIdx > totalsIdx) {
            errors.push('shipments must appear before totals');
        }
        var paymentsIdx = orderBlock.indexOf('<payments>');
        if (paymentsIdx >= 0 && totalsIdx >= 0 && paymentsIdx < totalsIdx) {
            errors.push('payments must appear after totals');
        }
        if (orderBlock.indexOf('<payment>') >= 0 && /<payment>[\s\S]*?<method>/.test(orderBlock)) {
            errors.push('payment method must use custom-method/method-name');
        }
        var addressBlocks = orderBlock.match(/<(?:billing|shipping)-address>[\s\S]*?<\/(?:billing|shipping)-address>/g) || [];
        for (var a = 0; a < addressBlocks.length; a++) {
            var addrBlock = addressBlocks[a];
            var cityIdx = addrBlock.indexOf('<city>');
            var addr2Idx = addrBlock.indexOf('<address2>');
            if (addr2Idx >= 0 && cityIdx >= 0 && addr2Idx > cityIdx) {
                errors.push('address2 must appear before city in address blocks');
            }
        }
    }

    return {
        valid:  errors.length === 0,
        errors: errors
    };
}

/**
 * Validate XML for each order chunk; throws on first failure.
 * @param {string} xml
 */
function assertValidOrderXml(xml) {
    var result = validateOrderXml(xml);
    if (!result.valid) {
        throw new Error('Order XML validation failed: ' + result.errors.join('; '));
    }
}

module.exports = {
    NS_ORDER:           NS_ORDER,
    validateOrderXml:   validateOrderXml,
    assertValidOrderXml: assertValidOrderXml
};
