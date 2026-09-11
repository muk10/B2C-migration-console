'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var fetcherPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/shopifyCustomerFetcher.js'
);

describe('shopifyCustomerFetcher', function () {
    it('batch-fetches metafields and attaches them to matching REST customers', function () {
        var graphqlQuery = '';
        var graphqlVariables;
        var fetcher = proxyquire(fetcherPath, {
            '*/cartridge/scripts/migration/core/http': {},
            '*/cartridge/scripts/migration/connectors/shopify/shopifyConnector': {},
            '*/cartridge/scripts/migration/configAccessor': { shopify: { storeUrl: 'https://example.myshopify.com' } },
            '*/cartridge/scripts/migration/core/shopifyApi': {
                graphql: function (query, variables) {
                    graphqlQuery = query;
                    graphqlVariables = variables;
                    return {
                        nodes: [{
                            id: 'gid://shopify/Customer/123',
                            metafields: {
                                nodes: [{ namespace: 'migration', key: 'loyalty_id', type: 'number_integer', value: '42' }]
                            }
                        }]
                    };
                }
            }
        });
        var customers = [{ id: 123, admin_graphql_api_id: 'gid://shopify/Customer/123' }];

        fetcher.enrichCustomersWithMetafields(customers);

        assert.include(graphqlQuery, '... on Customer');
        assert.include(graphqlQuery, 'metafields(first: 250)');
        assert.deepEqual(graphqlVariables.ids, ['gid://shopify/Customer/123']);
        assert.equal(customers[0].metafields[0].key, 'loyalty_id');
        assert.equal(customers[0].metafields[0].value, '42');
    });

    it('does not call GraphQL when customers have no GraphQL IDs', function () {
        var called = false;
        var fetcher = proxyquire(fetcherPath, {
            '*/cartridge/scripts/migration/core/http': {},
            '*/cartridge/scripts/migration/connectors/shopify/shopifyConnector': {},
            '*/cartridge/scripts/migration/configAccessor': { shopify: {} },
            '*/cartridge/scripts/migration/core/shopifyApi': {
                graphql: function () { called = true; }
            }
        });

        fetcher.enrichCustomersWithMetafields([{ id: 123 }]);

        assert.isFalse(called);
    });
});
