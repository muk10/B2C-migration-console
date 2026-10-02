'use strict';

/**
 * Per nativeFieldMap.json: quantityOnStock -> allocation (total stock, available + reserved).
 * @param {Object} entry - CT inventory entry
 * @returns {number}
 */
function getStockOnHand(entry) {
    if (typeof entry.quantityOnStock === 'number') return Math.max(0, entry.quantityOnStock);
    return 0;
}

/**
 * Per nativeFieldMap.json: availableQuantity -> ATS (stock on hand minus reservations).
 * Falls back to stock-on-hand if availableQuantity isn't present.
 * @param {Object} entry - CT inventory entry
 * @returns {number}
 */
function getAvailableToSell(entry) {
    if (typeof entry.availableQuantity === 'number') return Math.max(0, entry.availableQuantity);
    return getStockOnHand(entry);
}

/**
 * @param {Object} entry - CT inventory entry
 * @returns {string} none | preorder | backorder
 */
function getPreorderHandling(entry) {
    var qty = getAvailableToSell(entry);
    if (qty > 0) return 'none';
    if (entry.expectedDelivery) return 'preorder';
    if (entry.restockableInDays != null && entry.restockableInDays > 0) return 'backorder';
    return 'none';
}

/**
 * @param {Object} entry
 * @returns {string}
 */
function getTimestamp(entry) {
    if (entry.lastModifiedAt) return entry.lastModifiedAt;
    return new Date().toISOString();
}

function localizedFallback(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return obj.en || obj['en-US'] || obj['en-GB']
        || (Object.keys(obj).length ? obj[Object.keys(obj)[0]] : '');
}

/**
 * Serialize a raw CT custom-field value for the inventory record's custom attributes.
 * @param {*} val
 * @returns {string}
 */
function formatCustomFieldValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
        var parts = [];
        var ai;
        for (ai = 0; ai < val.length; ai++) {
            var item = formatCustomFieldValue(val[ai]);
            if (item) parts.push(item);
        }
        return parts.join(',');
    }
    if (typeof val === 'object') {
        if (val.centAmount !== undefined && val.currencyCode) {
            var digits = typeof val.fractionDigits === 'number' ? val.fractionDigits : 2;
            return (val.centAmount / Math.pow(10, digits)).toFixed(digits) + ' ' + val.currencyCode;
        }
        if (val.id && (val.typeId || val.type_id)) {
            return String(val.id);
        }
        var localized = localizedFallback(val);
        if (localized) return localized;
        try {
            return JSON.stringify(val);
        } catch (e) {
            return '';
        }
    }
    return String(val);
}

/**
 * Transform a single CT inventory entry into a canonical record.
 * @param {Object} entry
 * @returns {Object|null}
 */
function transformEntry(entry) {
    if (!entry) return null;
    var productId = entry.productId || entry.sku;
    if (!productId) return null;

    var record = {
        sku:                    productId,
        productId:              productId,
        allocation:             getStockOnHand(entry),
        ats:                    getAvailableToSell(entry),
        perpetual:              false,
        preorderBackorder:      getPreorderHandling(entry),
        allocationTimestamp:    getTimestamp(entry),
        onOrder:                0,
        turnover:               0,
        supplyChannelId:        entry.supplyChannel && entry.supplyChannel.id
            ? entry.supplyChannel.id : null
    };

    if (entry.custom && entry.custom.fields) {
        var customAttrs = {};
        var keys = Object.keys(entry.custom.fields);
        var ci;
        for (ci = 0; ci < keys.length; ci++) {
            var formatted = formatCustomFieldValue(entry.custom.fields[keys[ci]]);
            if (formatted !== '') customAttrs[keys[ci]] = formatted;
        }
        if (Object.keys(customAttrs).length) record.customAttributes = customAttrs;
    }

    return record;
}

/**
 * Merge duplicate SKUs in a batch (e.g. multiple supply channels) by summing quantity.
 * @param {Array} entries - raw CT inventory entries
 * @returns {Array}
 */
function aggregateBySku(entries) {
    var map = {};
    var out = [];

    for (var i = 0; i < entries.length; i++) {
        var rec = transformEntry(entries[i]);
        if (!rec) continue;

        if (map[rec.sku]) {
            map[rec.sku].allocation += rec.allocation;
            map[rec.sku].ats        += rec.ats;
            if (rec.allocationTimestamp > map[rec.sku].allocationTimestamp) {
                map[rec.sku].allocationTimestamp = rec.allocationTimestamp;
            }
        } else {
            map[rec.sku] = rec;
            out.push(rec);
        }
    }
    return out;
}

/**
 * @param {Object} target
 * @param {Object} source
 */
function mergeRecords(target, source) {
    target.allocation += source.allocation;
    target.ats        += source.ats;
    if (source.allocationTimestamp > target.allocationTimestamp) {
        target.allocationTimestamp = source.allocationTimestamp;
    }
}

module.exports = {
    transformEntry:         transformEntry,
    aggregateBySku:         aggregateBySku,
    mergeRecords:           mergeRecords,
    getStockOnHand:         getStockOnHand,
    getAvailableToSell:     getAvailableToSell,
    formatCustomFieldValue: formatCustomFieldValue
};
