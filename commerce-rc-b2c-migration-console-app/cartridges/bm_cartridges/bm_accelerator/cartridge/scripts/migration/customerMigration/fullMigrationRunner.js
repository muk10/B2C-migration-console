'use strict';

/* global session */

var fetcher      = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher');
var xmlBuilder   = require('*/cartridge/scripts/migration/customerMigration/customerXmlBuilder');
var splitRunner  = require('*/cartridge/scripts/migration/customerMigration/customerSplitMigration');

var FETCH_BATCH_SIZE = 500;
var IDMAP_KEY = 'migC_ctp_idmap';

function loadIdToKey(reset) {
    if (reset) {
        session.custom[IDMAP_KEY] = '';
    }
    var cached = String(session.custom[IDMAP_KEY] || '');
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
    }
    var map = {};
    try {
        var storeFetcher = require('*/cartridge/scripts/migration/storeMigration/ctpStoreFetcher');
        var stores = storeFetcher.fetchAllCtpStores() || [];
        var i;
        for (i = 0; i < stores.length; i++) {
            if (stores[i] && stores[i].id && stores[i].key) {
                map[String(stores[i].id)] = String(stores[i].key);
            }
        }
    } catch (fe) { /* filenames fall back to store id */ }
    session.custom[IDMAP_KEY] = JSON.stringify(map);
    return map;
}

/**
 * Fetch all CT customers (no store filter). Route each payload into the
 * matching IMPEX series from Customer.stores while writing.
 *
 * @param {number} offset - 0 starts a new run
 * @returns {Object}
 */
function runBatch(offset) {
    var isFirst = !offset;
    var idToKey = loadIdToKey(isFirst);
    return splitRunner.runBatch({
        offset:          offset,
        platformId:      'ctp',
        bucketCustomers: true,
        idToKey:         idToKey,
        xmlBuilder:      xmlBuilder,
        fetchPage: function (cursor) {
            return fetcher.fetchPage({
                limit:     FETCH_BATCH_SIZE,
                lastId:    cursor || '',
                withTotal: !cursor
            });
        }
    });
}

module.exports = {
    runBatch:          runBatch,
    MAX_PER_FILE:      splitRunner.MAX_PER_FILE,
    FETCH_BATCH_SIZE:  FETCH_BATCH_SIZE
};
