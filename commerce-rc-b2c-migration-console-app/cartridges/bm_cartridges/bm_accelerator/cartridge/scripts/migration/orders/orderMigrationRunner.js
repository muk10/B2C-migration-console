'use strict';

var fullMigrationRunner = require('*/cartridge/scripts/migration/orders/fullMigrationRunner');

/**
 * Run the full order migration pipeline (all batches, XML part files).
 * @param {Object} options
 * @param {number|string} options.years - 1, 2, 3, or 0 / 'all'
 * @param {number} [options.maxCount] - optional max orders
 * @param {string} [options.orderState] - commercetools orderState filter
 * @param {string} [options.paymentState] - commercetools paymentState filter
 * @returns {Object} migration report
 */
function run(options) {
    var result = fullMigrationRunner.runChunk(options, null);
    while (result.ok && !result.done) {
        result = fullMigrationRunner.runChunk(options, result.state);
    }
    if (!result.ok) {
        throw new Error(result.error || 'Order migration failed');
    }

    return {
        ordersProcessed:   result.ordersProcessed,
        ordersValidated:   result.ordersValidated,
        ordersFailed:      result.ordersFailed,
        xmlFilesGenerated: result.xmlFilesGenerated,
        runId:             result.runId,
        impexPath:         result.impexPath,
        fileName:          result.fileName
    };
}

module.exports = {
    run: run
};
