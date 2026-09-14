'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var utils = require('../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerSplitUtils');

var fetcher = proxyquire(
    path.join(
        __dirname,
        '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher.js'
    ),
    {
        '*/cartridge/scripts/migration/core/http': { get: function () {}, post: function () {} },
        '*/cartridge/scripts/migration/configAccessor': { ctp: {} },
        'dw/crypto/Encoding': { toBase64: function () { return ''; } },
        'dw/util/Bytes': function Bytes() {}
    }
);

describe('customer split pagination', function () {
    describe('expectedFileCount', function () {
        it('keeps a 20k project in one file', function () {
            assert.equal(utils.expectedFileCount(20000), 1);
        });

        it('splits 103281 customers into 6 files', function () {
            assert.equal(utils.expectedFileCount(103281), 6);
        });

        it('scales to a million customers without a project cap', function () {
            assert.equal(utils.expectedFileCount(1000000), 50);
        });

        it('uses at least one file for an empty project', function () {
            assert.equal(utils.expectedFileCount(0), 1);
        });
    });

    describe('buildPartFileName', function () {
        it('appends a zero-padded part suffix', function () {
            assert.equal(
                utils.buildPartFileName('customer-20260909-v001.xml', 1),
                'customer-20260909-v001-p0001.xml'
            );
            assert.equal(
                utils.buildPartFileName('customer-20260909-v001.xml', 6),
                'customer-20260909-v001-p0006.xml'
            );
        });

        it('supports more than 9999 parts without truncating', function () {
            assert.equal(
                utils.buildPartFileName('customer-20260909-v001.xml', 10000),
                'customer-20260909-v001-p10000.xml'
            );
        });
    });

    describe('filePrefix and sessionScope', function () {
        it('uses customers-{key} so IMPEX names encode the source site', function () {
            assert.equal(utils.filePrefix('uk', false), 'customers-uk');
            assert.equal(utils.filePrefix('', true), 'customers-unassigned');
            assert.equal(utils.filePrefix('', false), '');
        });

        it('isolates session keys per source site', function () {
            assert.equal(utils.sessionScope('ctp'), 'ctp');
            assert.equal(utils.sessionScope('ctp', 'uk', false), 'ctp_customers-uk');
            assert.equal(utils.sessionScope('ctp', '', true), 'ctp_customers-unassigned');
            assert.notEqual(
                utils.sessionScope('ctp', 'uk', false),
                utils.sessionScope('ctp', 'de', false)
            );
        });
    });

    describe('CT keyset query', function () {
        it('never sends offset and pages with id > lastId', function () {
            var first = fetcher.buildKeysetQuery(500, '', true);
            assert.include(first, 'limit=500');
            assert.include(first, 'sort=id+asc');
            assert.include(first, 'withTotal=true');
            assert.notInclude(first, 'offset=');
            assert.notInclude(first, 'where=');

            var next = fetcher.buildKeysetQuery(500, '8bd58511-e17e-4429-acbe-bae8ac8d35f5', false);
            assert.notInclude(next, 'offset=');
            assert.notInclude(next, 'withTotal');
            assert.include(next, 'where=');
            assert.include(decodeURIComponent(next), 'id > "8bd58511-e17e-4429-acbe-bae8ac8d35f5"');
        });

        it('filters by store id or key and combines with keyset cursor', function () {
            var first = fetcher.buildKeysetQuery(500, '', true, fetcher.storeWhere('uk', 'store-uuid'));
            var decoded = decodeURIComponent(first);
            assert.include(decoded, 'stores(id = "store-uuid")');
            assert.include(decoded, 'stores(key = "uk")');
            assert.notInclude(decoded, 'id >');

            var next = fetcher.buildKeysetQuery(
                500,
                '8bd58511-e17e-4429-acbe-bae8ac8d35f5',
                false,
                fetcher.storeWhere('uk', '')
            );
            var where = decodeURIComponent(next);
            assert.include(where, 'stores(key = "uk")');
            assert.include(where, 'id > "8bd58511-e17e-4429-acbe-bae8ac8d35f5"');
            assert.include(where, ' and ');
        });

        it('filters unassigned customers', function () {
            var qs = fetcher.buildKeysetQuery(500, '', true, fetcher.UNASSIGNED_WHERE);
            assert.include(decodeURIComponent(qs), 'stores is empty');
        });

        it('reads the last UUID as the next cursor', function () {
            assert.equal(fetcher.lastIdFromResults([
                { id: 'aaa' },
                { id: 'bbb' }
            ]), 'bbb');
            assert.equal(fetcher.lastIdFromResults([]), '');
        });
    });
});
