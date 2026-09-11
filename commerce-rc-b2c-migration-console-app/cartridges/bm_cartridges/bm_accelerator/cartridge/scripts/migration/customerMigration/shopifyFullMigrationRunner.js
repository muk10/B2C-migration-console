'use strict';

var fetcher      = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerFetcher');
var xmlBuilder   = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerXmlBuilder');
var splitRunner  = require('*/cartridge/scripts/migration/customerMigration/customerSplitMigration');

var FETCH_PAGE_SIZE = 250;

/**
 * One UI poll: fetch a few Shopify customer pages and append to the current
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
        platformId: 'shopify',
        xmlBuilder: xmlBuilder,
        getCount:   function () { return fetcher.getCount(); },
        fetchPage: function (cursor) {
            var page = fetcher.fetchPage(cursor || null, FETCH_PAGE_SIZE);
            var results = page.results || [];
            return {
                results:    results,
                total:      0,
                nextCursor: page.nextPageInfo || '',
                hasMore:    !!page.nextPageInfo
            };
        }
    });
}

module.exports = {
    runBatch:         runBatch,
    MAX_PER_FILE:     splitRunner.MAX_PER_FILE,
    FETCH_PAGE_SIZE:  FETCH_PAGE_SIZE
};
