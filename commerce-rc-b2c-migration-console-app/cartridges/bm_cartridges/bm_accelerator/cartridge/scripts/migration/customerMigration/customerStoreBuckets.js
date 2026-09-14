'use strict';

/**
 * Route CT customers to IMPEX file buckets from the live Customer.stores
 * field on the API payload — not from store-catalog count queries.
 */

var UNASSIGNED = '__unassigned__';

function refToken(ref, idToKey) {
    if (ref == null) return '';
    if (typeof ref === 'string') return String(ref);
    var key = ref.key || (ref.obj && ref.obj.key) || '';
    if (key) return String(key);
    var id = ref.id || (ref.obj && ref.obj.id) || '';
    if (id && idToKey && idToKey[id]) return String(idToKey[id]);
    return id ? String(id) : '';
}

/**
 * True when the customer payload assigns at least one store.
 * Empty / missing stores = not store-specific.
 * @param {Object} customer
 * @returns {boolean}
 */
function hasStoreAssignment(customer) {
    var refs = customer && customer.stores;
    if (!refs || !refs.length) return false;
    var i;
    for (i = 0; i < refs.length; i++) {
        if (refToken(refs[i], null)) return true;
    }
    return false;
}

/**
 * File-bucket tokens for one customer. Store-specific customers are copied
 * into every assigned store. No stores → unassigned (shared) bucket.
 * @param {Object} customer
 * @param {Object} [idToKey] - store UUID → key for filenames
 * @returns {string[]}
 */
function bucketTokens(customer, idToKey) {
    var refs = customer && customer.stores;
    if (!refs || !refs.length) return [UNASSIGNED];
    var tokens = [];
    var i;
    for (i = 0; i < refs.length; i++) {
        var token = refToken(refs[i], idToKey);
        if (token && tokens.indexOf(token) === -1) tokens.push(token);
    }
    return tokens.length ? tokens : [UNASSIGNED];
}

/**
 * @param {Array} customers
 * @param {Object} [idToKey]
 * @returns {Object} bucket token → customer array
 */
function groupByBucket(customers, idToKey) {
    var groups = {};
    var list = customers || [];
    var i;
    var t;
    for (i = 0; i < list.length; i++) {
        var customer = list[i];
        if (!customer) continue;
        var tokens = bucketTokens(customer, idToKey);
        for (t = 0; t < tokens.length; t++) {
            var key = tokens[t];
            if (!groups[key]) groups[key] = [];
            groups[key].push(customer);
        }
    }
    return groups;
}

function anyAssigned(customers) {
    var list = customers || [];
    var i;
    for (i = 0; i < list.length; i++) {
        if (hasStoreAssignment(list[i])) return true;
    }
    return false;
}

module.exports = {
    UNASSIGNED:         UNASSIGNED,
    refToken:           refToken,
    hasStoreAssignment: hasStoreAssignment,
    bucketTokens:       bucketTokens,
    groupByBucket:      groupByBucket,
    anyAssigned:        anyAssigned
};
