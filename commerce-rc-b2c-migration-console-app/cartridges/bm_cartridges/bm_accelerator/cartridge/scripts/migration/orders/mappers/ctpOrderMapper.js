'use strict';

var canonicalOrder = require('*/cartridge/scripts/migration/orders/canonicalOrder');
var localizedString = require('*/cartridge/scripts/migration/orders/localizedString').localizedString;
var orderShippingStatus = require('*/cartridge/scripts/migration/orders/orderShippingStatus');

/**
 * Resolve a line item display name from commercetools order data.
 * @param {Object} li
 * @param {Object} variant
 * @returns {string}
 */
function lineItemName(li, variant) {
    var fallback = variant.sku || li.productId || '';
    return localizedString(li.name, '')
        || localizedString(li.productSlug, '')
        || localizedString(variant.title, '')
        || fallback;
}

/**
 * Map commercetools locale to SFCC customer-locale.
 * @param {string} locale
 * @returns {string}
 */
function mapCustomerLocale(locale) {
    if (!locale) return 'en_US';
    return String(locale).replace(/-/g, '_');
}

/**
 * Map commercetools tax mode to SFCC taxation value.
 * @param {Object} ctOrder
 * @returns {string}
 */
function mapTaxation(ctOrder) {
    // order.xsd taxation: gross when commercetools prices include tax (UK/EU), else net
    var items = ctOrder.lineItems || [];
    for (var i = 0; i < items.length; i++) {
        if (items[i].taxRate && items[i].taxRate.includedInPrice === true) return 'gross';
    }
    if (ctOrder.taxedPrice && ctOrder.taxedPrice.totalTax && ctOrder.taxedPrice.totalTax.centAmount) {
        return 'net';
    }
    if (ctOrder.taxMode === 'Gross') return 'gross';
    return 'net';
}

/**
 * @param {number} n
 * @returns {number} n rounded to 2 decimals
 */
function round2(n) {
    return Math.round((n || 0) * 100) / 100;
}

/**
 * Value of a commercetools custom field for an SFCC custom attribute, matching the attribute
 * types the Check Attributes step creates (ctpTypeMap): Set → list of values (set_of_string),
 * Money → decimal, Reference → key or ID, LocalizedString → text, other objects → JSON.
 * @param {*} val
 * @returns {*} '' when there is no value
 */
function customFieldValue(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) {
        var list = [];
        for (var i = 0; i < val.length; i++) {
            var v = customFieldValue(val[i]);
            if (v !== '' && !(Array.isArray(v) && !v.length)) list.push(v);
        }
        return list;
    }
    if (typeof val !== 'object') return val;
    if (val.centAmount !== undefined) return moneyToDecimal(val);
    if (val.typeId && (val.id || val.key)) return String((val.obj && val.obj.key) || val.key || val.id);
    var keys = Object.keys(val);
    var isLocalized = keys.length > 0 && keys.every(function (k) {
        return /^[a-z]{2}(-[A-Za-z0-9]+)*$/.test(k) && typeof val[k] === 'string';
    });
    return isLocalized ? localizedString(val, '') : JSON.stringify(val);
}

/**
 * commercetools custom fields (custom.fields) as SFCC custom attributes, keyed by field name.
 * @param {Object} custom - commercetools CustomFields
 * @returns {Object[]} [{ id, value }]
 */
function customFieldsToAttrs(custom) {
    var attrs = [];
    var fields = custom && custom.fields;
    if (!fields) return attrs;
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) {
        pushAttr(attrs, keys[i], customFieldValue(fields[keys[i]]));
    }
    return attrs;
}

/**
 * @param {Object[]} attrs
 * @param {string} id
 * @param {*} value - skipped when empty
 */
function pushAttr(attrs, id, value) {
    if (value === '' || value === null || value === undefined) return;
    if (Array.isArray(value) && !value.length) return;
    attrs.push({ id: id, value: value });
}

/**
 * @param {Object} ref - commercetools Reference, expanded or not
 * @returns {string} key when expanded, else ID
 */
function refKey(ref) {
    if (!ref) return '';
    return String((ref.obj && ref.obj.key) || ref.key || ref.id || '');
}

var TRANSACTION_TYPES = {
    Authorization:       'AUTH',
    CancelAuthorization: 'AUTH_REVERSAL',
    Charge:              'CAPTURE',
    Refund:              'CREDIT',
    Chargeback:          'CREDIT'
};

/**
 * Map commercetools payment info. With paymentInfo.payments[*] expanded the real method,
 * payment interface and transaction are used; 'CARD' only when the payment is not readable.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapPayments(ctOrder) {
    var payments = [];
    var info = ctOrder.paymentInfo && ctOrder.paymentInfo.payments;
    if (info && info.length) {
        for (var i = 0; i < info.length; i++) {
            var p = info[i];
            var obj = p.obj || p;
            var pmi = obj.paymentMethodInfo || {};
            var txs = obj.transactions || [];
            var tx = null;
            for (var t = txs.length - 1; t >= 0 && !tx; t--) {
                if (txs[t].state === 'Success') tx = txs[t];
            }
            tx = tx || txs[txs.length - 1] || null;
            payments.push({
                method:          pmi.method || obj.paymentMethod || 'CARD',
                amount:          obj.amountPlanned ? moneyToDecimal(obj.amountPlanned) : null,
                processorId:     pmi.paymentInterface || '',
                transactionId:   (tx && tx.interactionId) || obj.interfaceId || obj.id || '',
                transactionType: (tx && TRANSACTION_TYPES[tx.type]) || '',
                customAttributes: customFieldsToAttrs(obj.custom)
            });
        }
    }
    return payments;
}

/**
 * Order custom fields plus commercetools order fields that order.xsd has no element for.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapCustomAttributes(ctOrder) {
    var attrs = customFieldsToAttrs(ctOrder.custom);
    var codes = [];
    var dcs = ctOrder.discountCodes || [];
    for (var i = 0; i < dcs.length; i++) {
        var ref = dcs[i].discountCode || {};
        codes.push(String((ref.obj && ref.obj.code) || ref.id || ''));
    }
    pushAttr(attrs, 'store', ctOrder.store && ctOrder.store.key);
    pushAttr(attrs, 'completedAt', ctOrder.completedAt);
    pushAttr(attrs, 'anonymousId', ctOrder.anonymousId);
    pushAttr(attrs, 'customerGroup', refKey(ctOrder.customerGroup));
    pushAttr(attrs, 'country', ctOrder.country);
    pushAttr(attrs, 'discountCodes', codes.filter(function (c) { return c; }));
    return attrs;
}

/**
 * Convert cents (or smallest currency unit) to decimal amount.
 * @param {Object} money - { centAmount, fractionDigits }
 * @returns {number}
 */
function moneyToDecimal(money) {
    if (!money || money.centAmount === undefined || money.centAmount === null) return 0;
    var digits = money.fractionDigits !== undefined ? money.fractionDigits : 2;
    return money.centAmount / Math.pow(10, digits);
}

/**
 * Map a commercetools address to canonical address.
 * @param {Object} addr
 * @returns {Object}
 */
function mapAddress(addr) {
    if (!addr) return canonicalOrder.emptyAddress();
    return {
        firstName:   addr.firstName   || '',
        lastName:    addr.lastName    || '',
        company:     addr.company     || '',
        address1:    addr.streetName  || '',
        address2:    addr.streetNumber ? String(addr.streetNumber) : (addr.additionalStreetInfo || ''),
        city:        addr.city        || '',
        stateCode:   addr.state       || addr.region || '',
        postalCode:  addr.postalCode  || '',
        countryCode: addr.country     || '',
        phone:       addr.phone       || addr.mobile || '',
        // order.xsd Address custom-attributes: address custom fields (VAT, EORI, pickup point…) and email
        customAttributes: addressAttrs(addr)
    };
}

/**
 * @param {Object} addr - commercetools address
 * @returns {Object[]}
 */
function addressAttrs(addr) {
    var attrs = customFieldsToAttrs(addr.custom);
    pushAttr(attrs, 'email', addr.email);
    return attrs;
}

/**
 * Map commercetools customer info from order.
 * @param {Object} ctOrder
 * @returns {Object}
 */
function mapCustomer(ctOrder) {
    var customer = ctOrder.customer || {};
    var email    = ctOrder.customerEmail || customer.email || '';
    return {
        // Same number the customer migration imports: customerNumber, else the commercetools ID.
        // customerNumber is added to the order by ctpOrderConnector.addCustomerNumbers.
        id:        ctOrder.customerNumber || customer.id || ctOrder.customerId || '',
        email:     email,
        firstName: customer.firstName || (ctOrder.billingAddress && ctOrder.billingAddress.firstName) || '',
        lastName:  customer.lastName  || (ctOrder.billingAddress && ctOrder.billingAddress.lastName)  || ''
    };
}

/**
 * Map line items from commercetools order.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapLineItems(ctOrder) {
    var items    = ctOrder.lineItems || [];
    var currency = ctOrder.totalPrice && ctOrder.totalPrice.currencyCode ? ctOrder.totalPrice.currencyCode : '';
    var mapped   = [];

    for (var i = 0; i < items.length; i++) {
        var li      = items[i];
        var variant = li.variant || {};
        var price   = li.price && li.price.value ? li.price.value : null;
        var unit    = price ? moneyToDecimal(price) : 0;
        var qty     = li.quantity || 1;
        // Paid amounts; the line total (totalPrice), never the unit price, when there is no taxedPrice
        var paid    = li.taxedPrice
            ? { net: moneyToDecimal(li.taxedPrice.totalNet), gross: moneyToDecimal(li.taxedPrice.totalGross) }
            : null;
        if (!paid) {
            var total = li.totalPrice ? moneyToDecimal(li.totalPrice) : unit * qty;
            paid = { net: total, gross: total };
        }
        var priced  = withDiscounts(paid, li.taxRate, !!li.taxedPrice, lineDiscounts(li));
        var attrs   = customFieldsToAttrs(li.custom);
        pushAttr(attrs, 'supplyChannel', refKey(li.supplyChannel));
        pushAttr(attrs, 'distributionChannel', refKey(li.distributionChannel));
        if (li.lineItemMode && li.lineItemMode !== 'Standard') pushAttr(attrs, 'lineItemMode', li.lineItemMode);

        mapped.push({
            id:         li.id || String(i + 1),
            sku:        variant.sku || li.productId || '',
            // source product reference; productIdResolver turns it into the SFCC product ID
            sourceProductId:  li.productId || '',
            sourceProductKey: li.productKey || '',
            sourceVariantId:  variant.id != null ? variant.id : null,
            name:       lineItemName(li, variant),
            quantity:   qty,
            unitPrice:  unit,
            taxAmount:  priced.tax,
            grossPrice: priced.gross,
            netPrice:   priced.net,
            taxRate:    li.taxRate && typeof li.taxRate.amount === 'number' ? li.taxRate.amount : undefined,
            priceAdjustments: priced.adjustments,
            customAttributes: attrs,
            currency:   currency
        });
    }
    return mapped;
}

/**
 * Discount per cart discount on a line item, in price terms (positive).
 * @param {Object} li - commercetools line item
 * @returns {Object[]} [{ promotionId, amount }]
 */
function lineDiscounts(li) {
    var byId = {};
    var order = [];
    var dpq = li.discountedPricePerQuantity || [];
    for (var q = 0; q < dpq.length; q++) {
        var included = (dpq[q].discountedPrice && dpq[q].discountedPrice.includedDiscounts) || [];
        for (var d = 0; d < included.length; d++) {
            var id = refKey(included[d].discount) || 'discount';
            if (!byId[id]) { byId[id] = 0; order.push(id); }
            byId[id] += moneyToDecimal(included[d].discountedAmount) * (dpq[q].quantity || 0);
        }
    }
    return order.map(function (id) { return { promotionId: id, amount: round2(byId[id]) }; });
}

/**
 * SFCC line amounts are before price adjustments: rebuild the pre-discount amounts from the
 * paid ones and return one adjustment per discount, so amounts + adjustments = paid exactly.
 * @param {Object} paid - { net, gross } after discounts
 * @param {Object} taxRate - commercetools TaxRate (amount, includedInPrice) or null
 * @param {boolean} taxed - paid amounts come from taxedPrice
 * @param {Object[]} discounts - [{ promotionId, amount }] in price terms
 * @returns {Object} { net, tax, gross, adjustments }
 */
function withDiscounts(paid, taxRate, taxed, discounts) {
    var paidTax = round2(paid.gross - paid.net);
    var totalDisc = 0;
    for (var i = 0; i < discounts.length; i++) totalDisc += discounts[i].amount;
    totalDisc = round2(totalDisc);
    if (!totalDisc) return { net: paid.net, tax: paidTax, gross: paid.gross, adjustments: [] };

    var rate = taxRate && typeof taxRate.amount === 'number' ? taxRate.amount : 0;
    var net0;
    var gross0;
    if (taxed && taxRate && taxRate.includedInPrice) {
        gross0 = round2(paid.gross + totalDisc);
        net0 = round2(gross0 / (1 + rate));
    } else if (taxed) {
        net0 = round2(paid.net + totalDisc);
        gross0 = round2(net0 * (1 + rate));
    } else {
        net0 = round2(paid.net + totalDisc);
        gross0 = round2(paid.gross + totalDisc);
    }
    var tax0 = round2(gross0 - net0);
    var left = { net: round2(paid.net - net0), tax: round2(paidTax - tax0), gross: round2(paid.gross - gross0) };
    var adjustments = [];
    for (i = 0; i < discounts.length; i++) {
        var last = i === discounts.length - 1;
        var share = discounts[i].amount / totalDisc;
        var adj = last ? left : {
            net: round2((paid.net - net0) * share), tax: round2((paidTax - tax0) * share), gross: round2((paid.gross - gross0) * share)
        };
        if (!last) left = { net: round2(left.net - adj.net), tax: round2(left.tax - adj.tax), gross: round2(left.gross - adj.gross) };
        adjustments.push({
            promotionId:  discounts[i].promotionId,
            lineitemText: 'Discount ' + discounts[i].promotionId,
            netPrice:     adj.net,
            taxAmount:    adj.tax,
            grossPrice:   adj.gross,
            basePrice:    taxRate && taxRate.includedInPrice ? adj.gross : adj.net,
            taxBasis:     adj.net
        });
    }
    return { net: net0, tax: tax0, gross: gross0, adjustments: adjustments };
}

/**
 * Custom line items by order.xsd element: shipping charges → shipping-lineitem, credits
 * (negative) → order price-adjustment, everything else (gift card, services) → product-lineitem.
 * @param {Object} ctOrder
 * @returns {Object} { products, adjustments, shipping }
 */
function mapCustomLineItems(ctOrder) {
    var out = { products: [], adjustments: [], shipping: [] };
    var items = ctOrder.customLineItems || [];
    var currency = ctOrder.totalPrice && ctOrder.totalPrice.currencyCode ? ctOrder.totalPrice.currencyCode : '';
    for (var i = 0; i < items.length; i++) {
        var c = items[i];
        var net = c.taxedPrice ? moneyToDecimal(c.taxedPrice.totalNet) : moneyToDecimal(c.totalPrice);
        var gross = c.taxedPrice ? moneyToDecimal(c.taxedPrice.totalGross) : moneyToDecimal(c.totalPrice);
        var rate = c.taxRate && typeof c.taxRate.amount === 'number' ? c.taxRate.amount : undefined;
        var name = localizedString(c.name, c.slug || '');
        var slug = c.slug || c.id || 'custom-line-item';
        var attrs = customFieldsToAttrs(c.custom);
        var base = { netPrice: net, taxAmount: round2(gross - net), grossPrice: gross, taxRate: rate, customAttributes: attrs };
        if (/shipping/i.test(slug)) {
            base.itemId = slug;
            base.lineitemText = name;
            base.basePrice = net;
            out.shipping.push(base);
        } else if (gross < 0) {
            base.promotionId = slug;
            base.lineitemText = name;
            base.basePrice = gross;
            base.taxBasis = net;
            out.adjustments.push(base);
        } else {
            base.id = c.id || slug;
            base.sku = slug;
            base.name = name;
            base.quantity = c.quantity || 1;
            base.unitPrice = c.money ? moneyToDecimal(c.money) : gross;
            base.currency = currency;
            out.products.push(base);
        }
    }
    return out;
}

/**
 * External tax orders can carry the tax only on the order (taxedPrice) and none on the lines.
 * SFCC totals come from the lines, so spread that tax over the product lines by net amount.
 * @param {Object} order - canonical order (lineItems, shippingLineItems changed in place)
 * @param {Object} ctOrder
 */
function spreadOrderLevelTax(order, ctOrder) {
    var orderTax = ctOrder.taxedPrice && ctOrder.taxedPrice.totalTax ? moneyToDecimal(ctOrder.taxedPrice.totalTax) : 0;
    if (!orderTax) return;
    var lines = order.lineItems;
    var i;
    var lineTax = 0;
    var base = 0;
    for (i = 0; i < lines.length; i++) {
        lineTax += lines[i].taxAmount || 0;
        if (lines[i].netPrice > 0) base += lines[i].netPrice;
    }
    for (i = 0; i < (order.shippingLineItems || []).length; i++) lineTax += order.shippingLineItems[i].taxAmount || 0;
    if (Math.abs(lineTax) >= 0.005 || base <= 0) return;

    var left = orderTax;
    var last = -1;
    for (i = 0; i < lines.length; i++) if (lines[i].netPrice > 0) last = i;
    for (i = 0; i < lines.length; i++) {
        if (!(lines[i].netPrice > 0)) continue;
        var tax = i === last ? round2(left) : round2(orderTax * lines[i].netPrice / base);
        left = round2(left - tax);
        lines[i].taxAmount = tax;
        lines[i].grossPrice = round2(lines[i].netPrice + tax);
    }
}

/**
 * Discount on the whole order (discountOnTotalPrice) as order price adjustments.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapTotalPriceDiscounts(ctOrder) {
    var d = ctOrder.discountOnTotalPrice;
    if (!d || !d.discountedAmount) return [];
    var total = moneyToDecimal(d.discountedAmount);
    var net = d.discountedNetAmount ? moneyToDecimal(d.discountedNetAmount) : total;
    var gross = d.discountedGrossAmount ? moneyToDecimal(d.discountedGrossAmount) : total;
    var included = d.includedDiscounts && d.includedDiscounts.length
        ? d.includedDiscounts : [{ discount: null, discountedAmount: d.discountedAmount }];
    var left = { net: net, gross: gross };
    return included.map(function (inc, i) {
        var last = i === included.length - 1;
        var share = total ? moneyToDecimal(inc.discountedAmount) / total : 1;
        var a = last ? left : { net: round2(net * share), gross: round2(gross * share) };
        if (!last) left = { net: round2(left.net - a.net), gross: round2(left.gross - a.gross) };
        var id = refKey(inc.discount) || 'order-discount';
        return {
            promotionId: id, lineitemText: 'Discount ' + id,
            netPrice: -a.net, taxAmount: -round2(a.gross - a.net), grossPrice: -a.gross,
            basePrice: -a.gross, taxBasis: -a.net
        };
    });
}

/**
 * Map tax entries from commercetools order.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapTaxes(ctOrder) {
    var taxes  = [];
    var taxed  = ctOrder.taxedPrice;
    if (taxed && taxed.taxPortions) {
        for (var i = 0; i < taxed.taxPortions.length; i++) {
            var tp = taxed.taxPortions[i];
            taxes.push({
                name:   tp.name || 'Tax',
                amount: moneyToDecimal(tp.amount),
                rate:   tp.rate || 0
            });
        }
    }
    return taxes;
}

/**
 * Map discounts from commercetools order.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapDiscounts(ctOrder) {
    var discounts = [];
    var codes     = ctOrder.discountCodes || [];
    for (var i = 0; i < codes.length; i++) {
        var dc = codes[i];
        var discount = dc.discountCode && dc.discountCode.obj ? dc.discountCode.obj : {};
        discounts.push({
            id:          discount.id || dc.discountCode && dc.discountCode.id || '',
            code:        discount.code || '',
            amount:      dc.state === 'MatchesCart' ? 0 : 0,
            description: localizedString(discount.name, '')
        });
    }
    if (ctOrder.discountOnTotalPrice && ctOrder.discountOnTotalPrice.discountedAmount) {
        discounts.push({
            id:          'order-discount',
            code:        'ORDER_DISCOUNT',
            amount:      moneyToDecimal(ctOrder.discountOnTotalPrice.discountedAmount),
            description: 'Order discount'
        });
    }
    return discounts;
}

/**
 * Map shipments from commercetools order.
 * @param {Object} ctOrder
 * @returns {Object[]}
 */
function mapShipments(ctOrder) {
    var shipments = [];
    var shipping  = ctOrder.shippingInfo;
    var shipTaxed = shipping && shipping.taxedPrice ? shipping.taxedPrice : null;
    var shipNet   = shipTaxed && shipTaxed.totalNet
        ? moneyToDecimal(shipTaxed.totalNet)
        : (shipping && shipping.price ? moneyToDecimal(shipping.price) : 0);
    var shipTax   = shipTaxed && shipTaxed.totalTax ? moneyToDecimal(shipTaxed.totalTax) : 0;
    var shipGross = shipTaxed && shipTaxed.totalGross
        ? moneyToDecimal(shipTaxed.totalGross)
        : shipNet + shipTax;

    if (shipping) {
        shipments.push({
            shipmentId:      '000001',
            status:          orderShippingStatus.mapShippingStatus(ctOrder.shipmentState),
            shippingMethod:  shipping.shippingMethodName || 'STANDARD_SHIPPING',
            trackingNumber:  trackingNumbers(shipping),
            shippingAddress: mapAddress(ctOrder.shippingAddress),
            shippingNet:     shipNet,
            shippingTax:     shipTax,
            shippingGross:   shipGross
        });
    } else if (ctOrder.shippingAddress) {
        shipments.push({
            shipmentId:      '000001',
            status:          orderShippingStatus.mapShippingStatus(ctOrder.shipmentState),
            shippingMethod:  'STANDARD_SHIPPING',
            shippingAddress: mapAddress(ctOrder.shippingAddress),
            shippingNet:     0,
            shippingTax:     0,
            shippingGross:   0
        });
    }
    return shipments;
}

/**
 * order.xsd shipment tracking-number: every parcel tracking ID, joined (max 256 chars).
 * @param {Object} shippingInfo
 * @returns {string}
 */
function trackingNumbers(shippingInfo) {
    var ids = [];
    var deliveries = (shippingInfo && shippingInfo.deliveries) || [];
    for (var d = 0; d < deliveries.length; d++) {
        var parcels = deliveries[d].parcels || [];
        for (var p = 0; p < parcels.length; p++) {
            var id = parcels[p].trackingData && parcels[p].trackingData.trackingId;
            if (id && ids.indexOf(String(id)) < 0) ids.push(String(id));
        }
    }
    return ids.join(', ').substring(0, 256);
}

/**
 * Shipping line items: the shipping method (pre-discount amounts, discounts as adjustments,
 * commercetools tax rate) plus shipping custom line items such as surcharges.
 * @param {Object} ctOrder
 * @param {Object[]} extra - shipping custom line items from mapCustomLineItems
 * @returns {Object[]} empty when the order has neither, so the default shipping line applies
 */
function mapShippingLineItems(ctOrder, extra) {
    var items = [];
    var si = ctOrder.shippingInfo;
    if (si) {
        var taxed = !!si.taxedPrice;
        var listed = si.discountedPrice ? si.discountedPrice.value : si.price;
        var paid = taxed
            ? { net: moneyToDecimal(si.taxedPrice.totalNet), gross: moneyToDecimal(si.taxedPrice.totalGross) }
            : { net: moneyToDecimal(listed), gross: moneyToDecimal(listed) };
        var discounts = [];
        var included = (si.discountedPrice && si.discountedPrice.includedDiscounts) || [];
        for (var i = 0; i < included.length; i++) {
            discounts.push({ promotionId: refKey(included[i].discount) || 'discount', amount: moneyToDecimal(included[i].discountedAmount) });
        }
        var priced = withDiscounts(paid, si.taxRate, taxed, discounts);
        items.push({
            netPrice:     priced.net,
            taxAmount:    priced.tax,
            grossPrice:   priced.gross,
            basePrice:    priced.net,
            taxRate:      si.taxRate && typeof si.taxRate.amount === 'number' ? si.taxRate.amount : undefined,
            lineitemText: 'Shipping',
            itemId:       si.shippingMethodName || 'STANDARD_SHIPPING',
            priceAdjustments: priced.adjustments
        });
    }
    return items.concat(extra || []);
}

/**
 * Map commercetools payment state.
 * @param {string} state
 * @returns {string}
 */
function mapPaymentStatus(state) {
    var map = {
        Paid:              'PAID',
        BalanceDue:        'NOT_PAID',
        CreditOwed:        'PAID',
        Failed:            'NOT_PAID',
        Pending:           'NOT_PAID'
    };
    return map[state] || (state || '').toUpperCase();
}

/**
 * Map commercetools order state.
 * @param {string} state
 * @returns {string}
 */
function mapOrderStatus(state) {
    var map = {
        Open:      'NEW',
        Confirmed: 'OPEN',
        Complete:  'COMPLETED',
        Cancelled: 'CANCELLED'
    };
    return map[state] || (state || '').toUpperCase();
}

/**
 * Convert a commercetools order into a CanonicalOrder.
 * @param {Object} ctOrder - raw commercetools order
 * @returns {Object} CanonicalOrder
 */
function mapOrder(ctOrder) {
    var order = canonicalOrder.createEmpty();
    var currency = ctOrder.totalPrice && ctOrder.totalPrice.currencyCode
        ? ctOrder.totalPrice.currencyCode
        : (ctOrder.taxedPrice && ctOrder.taxedPrice.totalGross && ctOrder.taxedPrice.totalGross.currencyCode) || '';

    order.orderNumber     = ctOrder.orderNumber || ctOrder.id || '';
    order.currency        = currency;
    order.createdAt       = ctOrder.createdAt || '';
    order.customerLocale  = mapCustomerLocale(ctOrder.locale);
    order.taxation        = mapTaxation(ctOrder);
    order.customer        = mapCustomer(ctOrder);
    order.billingAddress  = mapAddress(ctOrder.billingAddress);
    order.shippingAddress = mapAddress(ctOrder.shippingAddress);
    var custom            = mapCustomLineItems(ctOrder);
    order.lineItems       = mapLineItems(ctOrder).concat(custom.products);
    order.shippingLineItems = mapShippingLineItems(ctOrder, custom.shipping);
    order.priceAdjustments = custom.adjustments.concat(mapTotalPriceDiscounts(ctOrder));
    spreadOrderLevelTax(order, ctOrder);
    order.taxes           = mapTaxes(ctOrder);
    order.discounts       = mapDiscounts(ctOrder);
    order.shipments       = mapShipments(ctOrder);
    order.payments        = mapPayments(ctOrder);
    order.customAttributes = mapCustomAttributes(ctOrder);
    order.status          = mapOrderStatus(ctOrder.orderState);
    order.paymentStatus   = mapPaymentStatus(ctOrder.paymentState);
    // order.xsd external-order-status: the commercetools workflow state (key when expanded)
    order.externalOrderStatus = refKey(ctOrder.state);

    var merch = ctOrder.taxedPrice && ctOrder.taxedPrice.totalNet
        ? moneyToDecimal(ctOrder.taxedPrice.totalNet)
        : (ctOrder.totalPrice ? moneyToDecimal(ctOrder.totalPrice) : 0);
    var ship  = ctOrder.shippingInfo && ctOrder.shippingInfo.taxedPrice && ctOrder.shippingInfo.taxedPrice.totalGross
        ? moneyToDecimal(ctOrder.shippingInfo.taxedPrice.totalGross)
        : 0;
    var tax   = ctOrder.taxedPrice && ctOrder.taxedPrice.totalTax
        ? moneyToDecimal(ctOrder.taxedPrice.totalTax)
        : 0;
    var total = ctOrder.taxedPrice && ctOrder.taxedPrice.totalGross
        ? moneyToDecimal(ctOrder.taxedPrice.totalGross)
        : (ctOrder.totalPrice ? moneyToDecimal(ctOrder.totalPrice) : merch + ship);

    order.merchandiseTotal = merch;
    order.shippingTotal    = ship;
    order.taxTotal         = tax;
    order.orderTotal       = total;

    return order;
}

/**
 * Map an array of commercetools orders.
 * @param {Object[]} ctOrders
 * @returns {Object[]}
 */
function mapOrders(ctOrders) {
    var mapped = [];
    for (var i = 0; i < ctOrders.length; i++) {
        mapped.push(mapOrder(ctOrders[i]));
    }
    return mapped;
}

module.exports = {
    mapOrder:      mapOrder,
    mapOrders:     mapOrders,
    mapAddress:    mapAddress,
    mapCustomer:   mapCustomer,
    mapLineItems:  mapLineItems,
    lineItemName:  lineItemName,
    moneyToDecimal: moneyToDecimal
};
