'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var buckets = require('../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/customerStoreBuckets');

describe('customerStoreBuckets', function () {
    it('treats missing or empty stores as shared (unassigned)', function () {
        assert.deepEqual(buckets.bucketTokens({}), [buckets.UNASSIGNED]);
        assert.deepEqual(buckets.bucketTokens({ stores: [] }), [buckets.UNASSIGNED]);
        assert.equal(buckets.hasStoreAssignment({ stores: [] }), false);
    });

    it('buckets a customer by store key on the API payload', function () {
        var customer = { stores: [{ typeId: 'store', key: 'uk' }] };
        assert.equal(buckets.hasStoreAssignment(customer), true);
        assert.deepEqual(buckets.bucketTokens(customer), ['uk']);
    });

    it('resolves store id to key when the payload has no key', function () {
        var customer = { stores: [{ typeId: 'store', id: 'aaa-111' }] };
        assert.deepEqual(buckets.bucketTokens(customer, { 'aaa-111': 'de' }), ['de']);
        assert.deepEqual(buckets.bucketTokens(customer, {}), ['aaa-111']);
    });

    it('copies a multi-store customer into every assigned bucket', function () {
        var customer = {
            stores: [
                { typeId: 'store', key: 'uk' },
                { typeId: 'store', key: 'de' }
            ]
        };
        assert.deepEqual(buckets.bucketTokens(customer), ['uk', 'de']);
    });

    it('groups a page by the stores field on each record', function () {
        var groups = buckets.groupByBucket([
            { id: '1', stores: [{ key: 'uk' }] },
            { id: '2', stores: [] },
            { id: '3', stores: [{ key: 'uk' }, { key: 'de' }] }
        ]);
        assert.equal(groups.uk.length, 2);
        assert.equal(groups.de.length, 1);
        assert.equal(groups[buckets.UNASSIGNED].length, 1);
        assert.equal(groups.uk[0].id, '1');
        assert.equal(groups[buckets.UNASSIGNED][0].id, '2');
    });
});
