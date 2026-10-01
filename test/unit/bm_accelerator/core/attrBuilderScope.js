'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');

var attrBuilder = require(path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/core/attrBuilder.js'
));

describe('attrBuilder attribute scope', function () {
    it('never makes attributes on order objects localizable (SFCC refuses them)', function () {
        ['Order', 'ProductLineItem', 'OrderAddress', 'OrderPaymentInstrument', 'PriceAdjustment'].forEach(function (type) {
            var scope = attrBuilder.resolveAttributeScope('LocalizedString', type);
            assert.isFalse(scope.localizable, type);
            assert.isFalse(attrBuilder.supportsAttributeScope(type), type);
        });
    });

    it('keeps localizable attributes on the product', function () {
        assert.isTrue(attrBuilder.resolveAttributeScope('LocalizedString', 'Product').localizable);
    });
});
