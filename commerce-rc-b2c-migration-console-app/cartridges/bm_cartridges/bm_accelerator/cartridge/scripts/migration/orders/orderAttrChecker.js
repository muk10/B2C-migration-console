'use strict';

var http        = require('*/cartridge/scripts/migration/core/http');
var cfg         = require('*/cartridge/scripts/migration/configAccessor');
var Encoding    = require('dw/crypto/Encoding');
var Bytes       = require('dw/util/Bytes');
var attrBuilder = require('*/cartridge/scripts/migration/core/attrBuilder');
var runner      = require('*/cartridge/scripts/migration/core/attrPreflightRunner');
var registry    = require('*/cartridge/scripts/migration/core/dataSourceRegistry');

var SFCC_OBJECT_TYPE = 'Order';

// commercetools order fields order.xsd has no element for (written as Order custom attributes)
var ORDER_EXTRA_FIELDS = [
    { name: 'store', label: 'Store', ctpType: 'String' },
    { name: 'completedAt', label: 'Completed At', ctpType: 'DateTime' },
    { name: 'anonymousId', label: 'Anonymous ID', ctpType: 'String' },
    { name: 'customerGroup', label: 'Customer Group', ctpType: 'String' },
    { name: 'country', label: 'Country', ctpType: 'String' },
    { name: 'discountCodes', label: 'Discount Codes', ctpType: 'Set' }
];

// Custom attributes on order parts (order.xsd custom-attributes of product-lineitem, address,
// payment and price-adjustment): commercetools type fields per resource plus standard fields.
var DETAIL_OBJECTS = [
    {
        objectType: 'ProductLineItem',
        label:      'Line item',
        resources:  ['line-item', 'custom-line-item'],
        extra:      [
            { name: 'supplyChannel', label: 'Supply Channel', ctpType: 'String' },
            { name: 'distributionChannel', label: 'Distribution Channel', ctpType: 'String' },
            { name: 'lineItemMode', label: 'Line Item Mode', ctpType: 'String' }
        ]
    },
    {
        objectType: 'OrderAddress',
        label:      'Address',
        resources:  ['address'],
        extra:      [{ name: 'email', label: 'Email', ctpType: 'String' }]
    },
    { objectType: 'OrderPaymentInstrument', label: 'Payment', resources: ['payment'], extra: [] },
    { objectType: 'PriceAdjustment', label: 'Price adjustment', resources: ['custom-line-item'], extra: [] }
];

function toBase64(str) {
    return Encoding.toBase64(new Bytes(str, 'UTF-8'));
}

function getCtpToken() {
    var c    = cfg.ctp;
    var body = 'grant_type=client_credentials';
    var res = http.post(
        c.authUrl + '/oauth/token',
        {
            Authorization:  'Basic ' + toBase64(c.clientId + ':' + c.clientSecret),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    );
    if (res.status !== 200 || !res.data.access_token) {
        throw new Error('CT auth failed (' + res.status + ')');
    }
    return res.data.access_token;
}

/**
 * Field definitions of the commercetools custom types for the given resources.
 * @param {string[]} resourceIds - e.g. ['order'], ['line-item', 'custom-line-item']
 * @returns {Object[]} [{ name, label, ctpType }]
 */
function getCtpTypeFields(resourceIds) {
    var c   = cfg.ctp;
    var tok = getCtpToken();
    var ids = resourceIds.map(function (r) { return '"' + r + '"'; }).join(', ');
    var qs  = '?where=' + encodeURIComponent('resourceTypeIds contains any (' + ids + ')') + '&limit=500';

    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/types' + qs,
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT Types API failed (' + res.status + ')');
    }

    var fields = [];
    var seen   = {};
    var types  = (res.data && res.data.results) ? res.data.results : [];
    var t;
    var f;

    for (t = 0; t < types.length; t++) {
        var fieldDefs = types[t].fieldDefinitions || [];
        for (f = 0; f < fieldDefs.length; f++) {
            var fd = fieldDefs[f];
            if (seen[fd.name]) continue;
            seen[fd.name] = true;
            fields.push({
                name:    fd.name,
                label:   attrBuilder.toLabel(fd.label) || fd.name,
                ctpType: fd.type && fd.type.name ? fd.type.name : 'String'
            });
        }
    }
    return fields;
}

function getCtpOrderFields() {
    return getCtpTypeFields(['order']);
}

/**
 * @param {Object[]} list - check results (changed in place)
 * @param {Object} detail - DETAIL_OBJECTS entry
 * @returns {Object[]} list
 */
function tagDetail(list, detail) {
    for (var i = 0; i < (list || []).length; i++) {
        list[i].objectType = detail.objectType;
        list[i].label = detail.label + ': ' + (list[i].label || list[i].id);
    }
    return list || [];
}

function checkMissingAttributes() {
    var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
    var map = attrIdMapSession.read('order');
    var result = runner.checkMissing(
        SFCC_OBJECT_TYPE,
        getCtpOrderFields,
        function (platformId) { return platformId === 'commercetools' ? ORDER_EXTRA_FIELDS : []; },
        map,
        'order',
        'Order'
    );
    if (registry.getPlatformId() !== 'commercetools' || !result || Array.isArray(result)) return result;

    // Only missing and mapped entries of the order parts are merged; the order check keeps
    // its system-field coverage and AI suggestions.
    for (var d = 0; d < DETAIL_OBJECTS.length; d++) {
        var detail = DETAIL_OBJECTS[d];
        try {
            var part = runner.checkMissing(
                detail.objectType,
                function () { return getCtpTypeFields(detail.resources); },
                function () { return detail.extra; },
                map,
                'order',
                detail.objectType
            );
            result.missing = (result.missing || []).concat(tagDetail(part.missing, detail));
            result.mapped = (result.mapped || []).concat(tagDetail(part.mapped, detail));
        } catch (e) {
            result.aiMessage = (result.aiMessage ? result.aiMessage + ' ' : '')
                + detail.label + ' attributes not checked: ' + (e.message || String(e));
        }
    }
    return result;
}

/**
 * Create attributes, each on its own SFCC object type (Order unless the check tagged it).
 * @param {Array} attrs
 * @returns {Object} merged createAttributes result
 */
function createAttributes(attrs) {
    var allowed = { Order: true };
    DETAIL_OBJECTS.forEach(function (detail) { allowed[detail.objectType] = true; });
    var groups = {};
    var positions = {};
    var order  = [];
    (attrs || []).forEach(function (a, i) {
        var type = a.objectType && allowed[a.objectType] ? a.objectType : SFCC_OBJECT_TYPE;
        if (!groups[type]) { groups[type] = []; positions[type] = []; order.push(type); }
        groups[type].push(a);
        positions[type].push(i);
    });

    var merged = {
        created: 0, failed: 0, alreadyExists: 0, errors: [], createdAttrs: [], mappedAttrs: [], results: []
    };
    order.forEach(function (type) {
        var r = runner.createAttributes(type, groups[type]);
        merged.created += r.created;
        merged.failed += r.failed;
        merged.alreadyExists += r.alreadyExists;
        merged.errors = merged.errors.concat(r.errors || []);
        merged.createdAttrs = merged.createdAttrs.concat(r.createdAttrs || []);
        merged.mappedAttrs = merged.mappedAttrs.concat(r.mappedAttrs || []);
        // one result per attribute, in input order, so the page matches them to its rows
        (r.results || []).forEach(function (res, k) { merged.results[positions[type][k]] = res; });
    });
    return merged;
}

module.exports = {
    checkMissingAttributes: checkMissingAttributes,
    createAttributes:       createAttributes,
    ORDER_EXTRA_FIELDS:     ORDER_EXTRA_FIELDS,
    DETAIL_OBJECTS:         DETAIL_OBJECTS
};
