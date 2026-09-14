'use strict';

/**
 * Detect whether the source scopes customers to multiple sites/stores.
 * CT: Customer.stores is a Set of store references (id and/or key).
 * Shopify / BigCommerce: always shared (one shop).
 */

var splitUtils     = require('*/cartridge/scripts/migration/customerMigration/customerSplitUtils');

var UNASSIGNED_KEY = '__unassigned__';

function escapePredicateValue(val) {
    return String(val || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function storeWhere(storeKey, storeId) {
    var parts = [];
    if (storeId) parts.push('stores(id = "' + escapePredicateValue(storeId) + '")');
    if (storeKey) parts.push('stores(key = "' + escapePredicateValue(storeKey) + '")');
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return '(' + parts.join(' or ') + ')';
}

function storeKeyWhere(storeKey) {
    return storeWhere(storeKey, '');
}

/**
 * Per-site when customers are assigned across 2+ distinct stores.
 * @param {number} populatedStoreCount
 * @param {number} [storeCatalogCount]
 * @param {number} [assignedCount]
 * @returns {'shared'|'perSite'}
 */
function classifyMode(populatedStoreCount, storeCatalogCount, assignedCount) {
    if (populatedStoreCount >= 2) return 'perSite';
    // Per-store counts succeeded and only one store is used.
    if (populatedStoreCount === 1) return 'shared';
    // Assignments exist and the catalog has multiple stores, but per-store
    // counts all came back 0 (typically key-only query against id-only refs).
    if ((storeCatalogCount || 0) >= 2 && (assignedCount || 0) > 0) return 'perSite';
    return 'shared';
}

function emptyResult(platformId, mode) {
    return {
        ok:                   true,
        platformId:           platformId || 'ctp',
        mode:                 mode || 'shared',
        stores:               [],
        storeCatalogCount:    0,
        populatedStoreCount:  0,
        unassignedCount:      0,
        unassignedFilePrefix: splitUtils.filePrefix('', true),
        assignedCount:        0
    };
}

function safeCount(fetcher, where) {
    try {
        return fetcher.getCount(where);
    } catch (e) {
        return -1;
    }
}

function countAssigned(fetcher) {
    var n = safeCount(fetcher, fetcher.ASSIGNED_WHERE || 'stores is not empty');
    if (n >= 0) return n;
    n = safeCount(fetcher, '(stores(id is defined) or stores(key is defined))');
    if (n >= 0) return n;
    n = safeCount(fetcher, 'stores is defined');
    return n > 0 ? n : 0;
}

function countUnassigned(fetcher) {
    var n = safeCount(fetcher, fetcher.UNASSIGNED_WHERE || 'stores is empty');
    if (n >= 0) return n;
    n = safeCount(fetcher, 'stores is not defined');
    return n > 0 ? n : 0;
}

function countForStore(fetcher, key, id) {
    var where = (fetcher.storeWhere || storeWhere)(key, id);
    if (!where) return 0;
    var n = safeCount(fetcher, where);
    return n > 0 ? n : 0;
}

function scopeToken(store) {
    if (store && store.key) return store.key;
    var id = store && store.id ? String(store.id) : '';
    return id ? ('id-' + id.replace(/-/g, '').substring(0, 12)) : '';
}

function detectCtp() {
    var storeFetcher = require('*/cartridge/scripts/migration/storeMigration/ctpStoreFetcher');
    var fetcher      = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher');
    var stores       = storeFetcher.fetchAllCtpStores() || [];
    var assignedCount   = countAssigned(fetcher);
    var unassignedCount = countUnassigned(fetcher);

    var rows = [];
    var i;
    for (i = 0; i < stores.length; i++) {
        var store = stores[i];
        if (!store) continue;
        var key = store.key || '';
        var id  = store.id || '';
        rows.push({
            key:        key,
            id:         id,
            name:       storeFetcher.getLocalized(store.name) || key || id || '',
            count:      countForStore(fetcher, key, id),
            filePrefix: splitUtils.filePrefix(scopeToken(store), false)
        });
    }

    var populatedStoreCount = 0;
    for (i = 0; i < rows.length; i++) {
        if (rows[i].count > 0) populatedStoreCount++;
    }

    return {
        ok:                    true,
        platformId:            'ctp',
        mode:                  classifyMode(populatedStoreCount, stores.length, assignedCount),
        stores:                rows,
        storeCatalogCount:     stores.length,
        populatedStoreCount:   populatedStoreCount,
        unassignedCount:       unassignedCount,
        unassignedFilePrefix:  splitUtils.filePrefix('', true),
        assignedCount:         assignedCount
    };
}

/**
 * @param {string} [platformId]
 * @returns {{ ok: boolean, mode: string, stores: Array, unassignedCount: number, assignedCount: number }}
 */
function detect(platformId) {
    var id = String(platformId || 'ctp').toLowerCase();
    if (id === 'shopify' || id === 'bigcommerce') {
        return emptyResult(id, 'shared');
    }
    return detectCtp();
}

module.exports = {
    UNASSIGNED_KEY:       UNASSIGNED_KEY,
    classifyMode:         classifyMode,
    storeKeyWhere:        storeKeyWhere,
    storeWhere:           storeWhere,
    escapePredicateValue: escapePredicateValue,
    detect:               detect
};
