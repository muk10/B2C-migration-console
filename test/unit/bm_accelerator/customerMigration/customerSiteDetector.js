'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var splitUtils = require('../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerSplitUtils');

function loadDetector(mocks) {
    mocks = mocks || {};
    return proxyquire(
        path.join(
            __dirname,
            '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerSiteDetector.js'
        ),
        {
            '*/cartridge/scripts/migration/customerMigration/customerSplitUtils': splitUtils,
            '*/cartridge/scripts/migration/storeMigration/ctpStoreFetcher': mocks.storeFetcher || {},
            '*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher': mocks.customerFetcher || {}
        }
    );
}

function storeWhere(key, id) {
    var parts = [];
    if (id) parts.push('stores(id = "' + id + '")');
    if (key) parts.push('stores(key = "' + key + '")');
    if (parts.length === 1) return parts[0];
    return '(' + parts.join(' or ') + ')';
}

describe('customerSiteDetector', function () {
    describe('classifyMode', function () {
        var detector = loadDetector();

        it('is shared when fewer than 2 stores have customers', function () {
            assert.equal(detector.classifyMode(0), 'shared');
            assert.equal(detector.classifyMode(1), 'shared');
        });

        it('is perSite when 2+ stores have at least one assigned customer', function () {
            assert.equal(detector.classifyMode(2), 'perSite');
            assert.equal(detector.classifyMode(5), 'perSite');
        });

        it('is perSite when assignments exist but per-store counts all missed', function () {
            assert.equal(detector.classifyMode(0, 3, 40), 'perSite');
        });

        it('stays shared when only one store is populated', function () {
            assert.equal(detector.classifyMode(1, 3, 40), 'shared');
        });
    });

    describe('storeWhere', function () {
        var detector = loadDetector();

        it('matches store id or key so id-only refs still count', function () {
            assert.equal(detector.storeWhere('uk', ''), 'stores(key = "uk")');
            assert.equal(detector.storeWhere('', 'abc-id'), 'stores(id = "abc-id")');
            assert.equal(
                detector.storeWhere('uk', 'abc-id'),
                '(stores(id = "abc-id") or stores(key = "uk"))'
            );
        });
    });

    describe('detect', function () {
        it('returns shared for Shopify and BigCommerce', function () {
            var detector = loadDetector();
            assert.equal(detector.detect('shopify').mode, 'shared');
            assert.equal(detector.detect('bigcommerce').mode, 'shared');
            assert.equal(detector.detect('shopify').stores.length, 0);
        });

        it('returns perSite for CT with multiple stores and assigned customers', function () {
            var detector = loadDetector({
                storeFetcher: {
                    fetchAllCtpStores: function () {
                        return [
                            { key: 'uk', id: '1', name: { en: 'United Kingdom' } },
                            { key: 'de', id: '2', name: { en: 'Germany' } }
                        ];
                    },
                    getLocalized: function (name) { return name && name.en; }
                },
                customerFetcher: {
                    ASSIGNED_WHERE: 'stores is not empty',
                    UNASSIGNED_WHERE: 'stores is empty',
                    storeWhere: storeWhere,
                    getCount: function (where) {
                        if (where === 'stores is not empty') return 20;
                        if (where === 'stores is empty') return 3;
                        if (where.indexOf('stores(id = "1")') !== -1) return 12;
                        if (where.indexOf('stores(id = "2")') !== -1) return 8;
                        return 0;
                    }
                }
            });
            var result = detector.detect('ctp');
            assert.equal(result.mode, 'perSite');
            assert.equal(result.stores.length, 2);
            assert.equal(result.stores[0].count, 12);
            assert.equal(result.stores[1].count, 8);
            assert.equal(result.stores[0].filePrefix, 'customers-uk');
            assert.equal(result.unassignedCount, 3);
            assert.equal(result.assignedCount, 20);
            assert.equal(result.populatedStoreCount, 2);
        });

        it('returns perSite when store refs are id-only (key query would miss)', function () {
            var detector = loadDetector({
                storeFetcher: {
                    fetchAllCtpStores: function () {
                        return [
                            { key: 'uk', id: '111', name: { en: 'UK' } },
                            { key: 'de', id: '222', name: { en: 'DE' } }
                        ];
                    },
                    getLocalized: function (name) { return name && name.en; }
                },
                customerFetcher: {
                    ASSIGNED_WHERE: 'stores is not empty',
                    UNASSIGNED_WHERE: 'stores is empty',
                    storeWhere: storeWhere,
                    getCount: function (where) {
                        if (where === 'stores is not empty') return 50;
                        if (where === 'stores is empty') return 0;
                        if (where.indexOf('stores(id = "111")') !== -1) return 30;
                        if (where.indexOf('stores(id = "222")') !== -1) return 20;
                        if (where.indexOf('stores(key =') !== -1 && where.indexOf('stores(id') === -1) return 0;
                        return 0;
                    }
                }
            });
            var result = detector.detect('ctp');
            assert.equal(result.mode, 'perSite');
            assert.equal(result.stores[0].count, 30);
            assert.equal(result.stores[1].count, 20);
        });

        it('returns shared when many stores exist but only one has customers', function () {
            var detector = loadDetector({
                storeFetcher: {
                    fetchAllCtpStores: function () {
                        return [
                            { key: 'uk', id: '1', name: { en: 'UK' } },
                            { key: 'de', id: '2', name: { en: 'DE' } },
                            { key: 'fr', id: '3', name: { en: 'FR' } }
                        ];
                    },
                    getLocalized: function (name) { return name && name.en; }
                },
                customerFetcher: {
                    ASSIGNED_WHERE: 'stores is not empty',
                    UNASSIGNED_WHERE: 'stores is empty',
                    storeWhere: storeWhere,
                    getCount: function (where) {
                        if (where === 'stores is not empty') return 10;
                        if (where === 'stores is empty') return 0;
                        if (where.indexOf('stores(id = "1")') !== -1) return 10;
                        return 0;
                    }
                }
            });
            var result = detector.detect('ctp');
            assert.equal(result.mode, 'shared');
            assert.equal(result.stores.length, 3);
            assert.equal(result.assignedCount, 10);
            assert.equal(result.populatedStoreCount, 1);
        });

        it('returns shared for CT with one store', function () {
            var detector = loadDetector({
                storeFetcher: {
                    fetchAllCtpStores: function () {
                        return [{ key: 'uk', id: '1', name: { en: 'UK' } }];
                    },
                    getLocalized: function (name) { return name && name.en; }
                },
                customerFetcher: {
                    ASSIGNED_WHERE: 'stores is not empty',
                    UNASSIGNED_WHERE: 'stores is empty',
                    storeWhere: storeWhere,
                    getCount: function () { return 10; }
                }
            });
            assert.equal(detector.detect('ctp').mode, 'shared');
        });
    });
});
