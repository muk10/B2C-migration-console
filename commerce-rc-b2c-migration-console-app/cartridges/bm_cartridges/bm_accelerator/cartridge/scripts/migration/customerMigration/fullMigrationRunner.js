'use strict';

var fetcher      = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher');
var xmlBuilder   = require('*/cartridge/scripts/migration/customerMigration/customerXmlBuilder');
var splitRunner  = require('*/cartridge/scripts/migration/customerMigration/customerSplitMigration');

var FETCH_BATCH_SIZE = 500;

/**
 * One UI poll: fetch a few CT pages via keyset cursor and append to the current
 * 20k-customer XML part. Project size is unlimited — files rotate at 20k.
 *
 * @param {number} offset - 0 starts a new run
 * @param {string} listId
 * @returns {Object}
 */
function runBatch(offset, listId) {
    return splitRunner.runBatch({
        offset:     offset,
        listId:     listId,
        platformId: 'ctp',
        xmlBuilder: xmlBuilder,
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
