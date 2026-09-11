'use strict';

var fetcher      = require('*/cartridge/scripts/migration/customerMigration/bcCustomerFetcher');
var xmlBuilder   = require('*/cartridge/scripts/migration/customerMigration/bcCustomerXmlBuilder');
var splitRunner  = require('*/cartridge/scripts/migration/customerMigration/customerSplitMigration');

var FETCH_PAGE_SIZE = 250;

/**
 * One UI poll: fetch a few BigCommerce customer pages and append to the current
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
        platformId: 'bigcommerce',
        xmlBuilder: xmlBuilder,
        fetchPage: function (cursor) {
            var pageOffset = cursor ? parseInt(cursor, 10) : 0;
            if (isNaN(pageOffset) || pageOffset < 0) pageOffset = 0;
            var page = fetcher.fetchPage(pageOffset, FETCH_PAGE_SIZE);
            var results = page.results || [];
            return {
                results:    results,
                total:      page.total || 0,
                nextCursor: String(page.nextOffset || 0),
                hasMore:    !!page.hasMore
            };
        }
    });
}

module.exports = {
    runBatch:         runBatch,
    MAX_PER_FILE:     splitRunner.MAX_PER_FILE,
    FETCH_PAGE_SIZE:  FETCH_PAGE_SIZE
};
