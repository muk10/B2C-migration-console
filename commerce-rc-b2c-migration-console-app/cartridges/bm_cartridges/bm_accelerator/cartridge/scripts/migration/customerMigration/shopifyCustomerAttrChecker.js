'use strict';

var runner    = require('*/cartridge/scripts/migration/core/attrPreflightRunner');

var SHOPIFY_ATTR_GROUP_ID   = 'ShopifyMigration';
var SHOPIFY_ATTR_GROUP_NAME = 'Shopify Migration';

/**
 * @returns {{ mapped: Array, missing: Array, coveragePending: Array, skipped: Array }}
 */
function checkMissingAttributes() {
    // Standard customer properties use native mappings. Only live Shopify
    // metafield definitions are offered as custom-attribute candidates.
    return runner.checkMissing('Profile', null, null, null, 'customer', 'Customer');
}

function createAttributes(attrs) {
    return runner.createDefinitions('Profile', SHOPIFY_ATTR_GROUP_ID, SHOPIFY_ATTR_GROUP_NAME, attrs);
}

module.exports = {
    checkMissingAttributes: checkMissingAttributes,
    createAttributes:       createAttributes
};
