'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var connectorPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/connectors/shopifyOrderConnector.js'
);

describe('shopifyOrderConnector', function () {
    it('batch-fetches metafields and attaches them to matching REST orders', function () {
        var graphqlQuery = '';
        var graphqlVariables = null;
        var connector = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/shopifyApi': {
                graphql: function (query, variables) {
                    graphqlQuery = query;
                    graphqlVariables = variables;
                    return {
                        nodes: [{
                            id: 'gid://shopify/Order/7258678952247',
                            metafields: {
                                nodes: [{
                                    namespace: 'migration',
                                    key: 'tracking_id',
                                    type: 'number_integer',
                                    value: '12345'
                                }]
                            }
                        }]
                    };
                }
            }
        });
        var orders = [{
            id: 7258678952247,
            admin_graphql_api_id: 'gid://shopify/Order/7258678952247'
        }];

        connector.enrichOrdersWithMetafields(orders);

        assert.include(graphqlQuery, 'metafields(first: 250)');
        assert.deepEqual(graphqlVariables.ids, ['gid://shopify/Order/7258678952247']);
        assert.equal(orders[0].metafields[0].key, 'tracking_id');
        assert.equal(orders[0].metafields[0].value, '12345');
    });

    it('does not call GraphQL when no order has a GraphQL ID', function () {
        var called = false;
        var connector = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/shopifyApi': {
                graphql: function () { called = true; }
            }
        });

        connector.enrichOrdersWithMetafields([{ id: 1 }]);

        assert.isFalse(called);
    });
});
