'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var fieldsPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/core/shopifyMetafieldFields.js'
);

describe('shopifyMetafieldFields customer support', function () {
    it('requests CUSTOMER definitions for SFCC Profile and prefixes their IDs', function () {
        var query = '';
        var fields = proxyquire(fieldsPath, {
            '*/cartridge/scripts/migration/core/shopifyApi': {
                getCreds: function () {},
                graphql: function (graphqlQuery) {
                    query = graphqlQuery;
                    return {
                        metafieldDefinitions: {
                            nodes: [{
                                name: 'Loyalty ID',
                                namespace: 'migration',
                                key: 'loyalty_id',
                                type: { name: 'number_integer' }
                            }]
                        }
                    };
                }
            },
            '*/cartridge/scripts/migration/configAccessor': { shopify: {} },
            '*/cartridge/scripts/migration/core/sourceAttrIds': {
                toAttrId: function (id) { return 'spy_' + id; }
            }
        }).fieldsForSfccObject('Profile');

        assert.include(query, 'ownerType: CUSTOMER');
        assert.deepEqual(fields, [{
            sfccId: 'spy_migration__loyalty_id',
            label: 'Loyalty ID',
            sourceType: 'number_integer'
        }]);
    });
});
