'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var checkerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/orderAttrChecker.js'
);

describe('orderAttrChecker', function () {
    it('discovers dynamic fields without adding hard-coded Shopify attributes', function () {
        var args;
        var checker = proxyquire(checkerPath, {
            '*/cartridge/scripts/migration/core/http': {},
            '*/cartridge/scripts/migration/configAccessor': {},
            'dw/crypto/Encoding': {},
            'dw/util/Bytes': function () {},
            '*/cartridge/scripts/migration/core/attrBuilder': {},
            '*/cartridge/scripts/migration/core/attrPreflightRunner': {
                checkMissing: function () {
                    args = Array.prototype.slice.call(arguments);
                    return { mapped: [], missing: [] };
                }
            },
            '*/cartridge/scripts/migration/core/attrIdMapSession': {
                read: function () { return {}; }
            }
        });
        checker.checkMissingAttributes();

        assert.equal(args[0], 'Order');
        assert.isNull(args[2]);
        assert.deepEqual(args[3], {});
    });
});
