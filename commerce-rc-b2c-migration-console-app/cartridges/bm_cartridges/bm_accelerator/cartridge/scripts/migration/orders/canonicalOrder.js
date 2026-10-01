'use strict';

/**
 * Platform-neutral order representation used between source connectors and SFCC IMPEX.
 * No commercetools or SFCC-specific fields — only canonical commerce concepts.
 */

/**
 * @typedef {Object} CanonicalAddress
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} company
 * @property {string} address1
 * @property {string} address2
 * @property {string} city
 * @property {string} stateCode
 * @property {string} postalCode
 * @property {string} countryCode
 * @property {string} phone
 * @property {Array<{id: string, value: *}>} [customAttributes] - address custom-attributes
 */

/**
 * @typedef {Object} CanonicalCustomer
 * @property {string} id
 * @property {string} email
 * @property {string} firstName
 * @property {string} lastName
 */

/**
 * @typedef {Object} CanonicalLineItem
 * @property {string} id
 * @property {string} sku
 * @property {string} name
 * @property {number} quantity
 * @property {number} unitPrice
 * @property {number} taxAmount
 * @property {number} grossPrice
 * @property {number} netPrice
 * @property {string} currency
 * @property {number} [taxRate] - source tax rate; computed from amounts when absent
 * @property {CanonicalPriceAdjustment[]} [priceAdjustments] - amounts above are before these
 * @property {Array<{id: string, value: *}>} [customAttributes] - product-lineitem custom-attributes
 */

/**
 * order.xsd PriceAdjustment (negative amounts reduce the total).
 * @typedef {Object} CanonicalPriceAdjustment
 * @property {string} promotionId
 * @property {string} lineitemText
 * @property {number} netPrice
 * @property {number} taxAmount
 * @property {number} grossPrice
 * @property {number} [basePrice]
 * @property {number} [taxBasis]
 * @property {Array<{id: string, value: *}>} [customAttributes]
 */

/**
 * @typedef {Object} CanonicalTax
 * @property {string} name
 * @property {number} amount
 * @property {number} rate
 */

/**
 * @typedef {Object} CanonicalDiscount
 * @property {string} id
 * @property {string} code
 * @property {number} amount
 * @property {string} description
 */

/**
 * @typedef {Object} CanonicalShipment
 * @property {string} id
 * @property {string} status
 * @property {string} shippingMethod
 * @property {string} [trackingNumber]
 * @property {CanonicalAddress} shippingAddress
 */

/**
 * @typedef {Object} CanonicalOrder
 * @property {string} orderNumber
 * @property {string} currency
 * @property {string} createdAt
 * @property {CanonicalCustomer} customer
 * @property {CanonicalAddress} billingAddress
 * @property {CanonicalAddress} shippingAddress
 * @property {CanonicalLineItem[]} lineItems
 * @property {CanonicalTax[]} taxes
 * @property {CanonicalDiscount[]} discounts
 * @property {CanonicalPriceAdjustment[]} priceAdjustments - order-level
 * @property {CanonicalShipment[]} shipments
 * @property {string} status
 * @property {string} paymentStatus
 * @property {string} confirmationStatus
 * @property {string} channelType
 * @property {string} externalOrderNo
 * @property {string} externalOrderText
 * @property {string} customerOrderReference
 * @property {string} cancelCode
 * @property {string} cancelDescription
 * @property {number} merchandiseTotal
 * @property {number} shippingTotal
 * @property {number} taxTotal
 * @property {number} orderTotal
 */

/**
 * Create an empty canonical order shell.
 * @returns {CanonicalOrder}
 */
function createEmpty() {
    return {
        orderNumber:     '',
        currency:        '',
        createdAt:       '',
        customerLocale:  '',
        taxation:        'net',
        customer:        { id: '', email: '', firstName: '', lastName: '' },
        billingAddress:  emptyAddress(),
        shippingAddress: emptyAddress(),
        lineItems:       [],
        shippingLineItems: [],
        taxes:           [],
        discounts:       [],
        // order-level price adjustments (order.xsd totals/merchandize-total/price-adjustments)
        priceAdjustments: [],
        shipments:       [],
        payments:        [],
        customAttributes: [],
        status:          '',
        paymentStatus:   '',
        confirmationStatus: 'NOT_CONFIRMED',
        channelType:     '',
        externalOrderNo: '',
        externalOrderText: '',
        customerOrderReference: '',
        cancelCode:      '',
        cancelDescription: '',
        merchandiseTotal: 0,
        shippingTotal:    0,
        taxTotal:         0,
        orderTotal:       0
    };
}

/**
 * @returns {CanonicalAddress}
 */
function emptyAddress() {
    return {
        firstName:   '',
        lastName:    '',
        company:     '',
        address1:    '',
        address2:    '',
        city:        '',
        stateCode:   '',
        postalCode:  '',
        countryCode: '',
        phone:       ''
    };
}

module.exports = {
    createEmpty: createEmpty,
    emptyAddress: emptyAddress
};
