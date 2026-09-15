'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var checkerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration/shopifyCustomerAttrChecker.js'
);

describe('shopifyCustomerAttrChecker', function () {
    it('checks dynamically discovered Profile metafields under the customer mapping session', function () {
        var captured;
        var checker = proxyquire(checkerPath, {
            '*/cartridge/scripts/migration/core/attrPreflightRunner': {
                checkMissing: function () {
                    captured = Array.prototype.slice.call(arguments);
                    return { mapped: [], missing: [] };
                }
            }
        });

        checker.checkMissingAttributes();

        assert.equal(captured[0], 'Profile');
        assert.isNull(captured[1]);
        assert.isNull(captured[2]);
        assert.equal(captured[4], 'customer');
        assert.equal(captured[5], 'Customer');
    });
});
