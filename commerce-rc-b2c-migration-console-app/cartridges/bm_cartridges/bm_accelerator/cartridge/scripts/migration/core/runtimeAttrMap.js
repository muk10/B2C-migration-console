'use strict';

/**
 * Apply visit-scoped Check Attributes maps at XML/write time.
 * Target may be an SFCC OOTB system field or a custom attribute id.
 */

var nativeFieldMap   = require('*/cartridge/scripts/migration/config/nativeFieldMap');
var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');

var MODULE_TASK = {
    product:         'Product',
    customer:        'Customer',
    store:           'Store',
    order:           'Order',
    shippingMethod:  'ShippingMethod',
    inventory:       'ProductInventoryRecord',
    pricebook:       'PriceBook',
    category:        'Category',
    catalog:         'Category',
    tax:             'TaxClass'
};

function taskFor(moduleKey) {
    return MODULE_TASK[moduleKey] || null;
}

function readMap(moduleKey, attrMap) {
    if (attrMap && typeof attrMap === 'object') return attrMap;
    try {
        return attrIdMapSession.read(moduleKey) || {};
    } catch (e) {
        return {};
    }
}

function sourceIdFromKey(key) {
    if (!key) return '';
    var s = String(key);
    if (s.length > 2 && s.charAt(0) === 'c' && s.charAt(1) === '_') return s.slice(2);
    return s;
}

function resolveTarget(sourceId, attrMap) {
    try {
        return attrIdMapSession.resolve(sourceId, attrMap || {});
    } catch (e) {
        if (!sourceId) return '';
        var mapped = attrMap && attrMap[sourceId];
        return mapped && String(mapped).trim() ? String(mapped).trim() : sourceId;
    }
}

function isSystemField(moduleKey, attrId) {
    var task = taskFor(moduleKey) || moduleKey;
    return !!nativeFieldMap.resolveSystemId(task, attrId);
}

/**
 * SFCC IMPEX datetime rejects a trailing Z. Use yyyy-MM-dd'T'HH:mm:ss.SSS+0000.
 * @param {*} val
 * @returns {string}
 */
function formatImpexDateTime(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    var s = String(val);
    var zulu = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z$/);
    if (zulu) {
        var ms = zulu[2] || '.000';
        while (ms.length < 4) ms += '0';
        return zulu[1] + ms + '+0000';
    }
    var offset = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)([+-]\d{2}):?(\d{2})$/);
    if (offset) {
        return offset[1] + offset[2] + offset[3];
    }
    return s;
}

function formatCustomAttrValue(val) {
    if (val === true || val === false) return val ? 'true' : 'false';
    if (Array.isArray(val)) {
        return val.map(function (v) { return formatCustomAttrValue(v); }).join(', ');
    }
    return formatImpexDateTime(val);
}

/**
 * @param {Object} sourceFields - sourceId (or c_sourceId) → value
 * @param {string} moduleKey
 * @param {Object.<string, string>} [attrMap]
 * @returns {{ system: Object, custom: Array<{id: string, value: *}> }}
 */
function apply(sourceFields, moduleKey, attrMap) {
    var map = readMap(moduleKey, attrMap);
    var task = taskFor(moduleKey);
    var system = {};
    var custom = [];
    var seenCustom = {};
    var keys = Object.keys(sourceFields || {});
    var i;
    for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        var sourceId = sourceIdFromKey(key);
        var val = sourceFields[key];
        if (!sourceId || val === null || val === undefined || val === '') continue;
        var targetId = resolveTarget(sourceId, map);
        var sysId = task ? nativeFieldMap.resolveSystemId(task, targetId) : null;
        if (sysId) {
            if (system[sysId] == null || system[sysId] === '') system[sysId] = val;
            continue;
        }
        if (seenCustom[targetId]) continue;
        seenCustom[targetId] = true;
        custom.push({ id: targetId, value: val });
    }
    return { system: system, custom: custom };
}

/**
 * Resolve one source id to a system or custom target.
 * @param {string} sourceId
 * @param {string} moduleKey
 * @param {Object.<string, string>} [attrMap]
 * @returns {{ systemId: string|null, customId: string|null }}
 */
function classifyId(sourceId, moduleKey, attrMap) {
    var fields = {};
    fields['c_' + sourceId] = '1';
    var mapped = apply(fields, moduleKey, attrMap);
    var sysKeys = Object.keys(mapped.system || {});
    if (sysKeys.length) return { systemId: sysKeys[0], customId: null };
    return { systemId: null, customId: (mapped.custom[0] && mapped.custom[0].id) || sourceId };
}

/**
 * @param {Array<{id: string, value: *}>} entries
 * @param {string} moduleKey
 * @param {Object.<string, string>} [attrMap]
 * @returns {{ system: Object, custom: Array<{id: string, value: *}> }}
 */
function applyEntries(entries, moduleKey, attrMap) {
    var fields = {};
    var i;
    for (i = 0; i < (entries || []).length; i++) {
        var e = entries[i];
        if (!e || !e.id) continue;
        fields[e.id] = e.value;
    }
    return apply(fields, moduleKey, attrMap);
}

/**
 * Copy mapped OOTB values onto a record when those keys are still empty.
 * @param {Object} record
 * @param {Object} system - canonical SFCC id → value
 * @param {Object.<string, string>} keyMap - SFCC system id → record key
 * @returns {Object} record
 */
function mergeIfEmpty(record, system, keyMap) {
    record = record || {};
    system = system || {};
    keyMap = keyMap || {};
    var ids = Object.keys(keyMap);
    var i;
    for (i = 0; i < ids.length; i++) {
        var sysId = ids[i];
        var recKey = keyMap[sysId];
        if (!recKey) continue;
        if (system[sysId] == null || system[sysId] === '') continue;
        if (record[recKey] == null || record[recKey] === '') {
            record[recKey] = system[sysId];
        }
    }
    return record;
}

module.exports = {
    MODULE_TASK:           MODULE_TASK,
    taskFor:               taskFor,
    isSystemField:         isSystemField,
    apply:                 apply,
    applyEntries:          applyEntries,
    classifyId:            classifyId,
    mergeIfEmpty:          mergeIfEmpty,
    formatImpexDateTime:   formatImpexDateTime,
    formatCustomAttrValue: formatCustomAttrValue
};
