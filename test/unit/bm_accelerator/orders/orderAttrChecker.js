'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var path = require('path');
var proxyquire = require('proxyquire').noCallThru();

var checkerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/orderAttrChecker.js'
);

/**
 * Load the checker with a stubbed preflight runner.
 * @param {string} platformId - source platform
 * @param {Object} [runnerStub] - replaces attrPreflightRunner methods
 * @returns {Object} { checker, calls }
 */
function load(platformId, runnerStub) {
    var calls = { check: [], create: [] };
    var runner = {
        checkMissing: function (objectType) {
            calls.check.push(Array.prototype.slice.call(arguments));
            return { mapped: [{ id: objectType + '-mapped', label: 'M' }], missing: [{ id: objectType + '-missing', label: 'X' }] };
        },
        createAttributes: function (objectType, attrs) {
            calls.create.push({ objectType: objectType, ids: attrs.map(function (a) { return a.id; }) });
            return {
                created: attrs.length, failed: 0, alreadyExists: 0, errors: [],
                createdAttrs: [], mappedAttrs: attrs.map(function (a) { return { id: a.id, canonicalId: a.id }; }),
                results: attrs.map(function (a) { return { id: a.id, status: 'created', objectType: objectType }; })
            };
        }
    };
    Object.keys(runnerStub || {}).forEach(function (k) { runner[k] = runnerStub[k]; });
    var checker = proxyquire(checkerPath, {
        '*/cartridge/scripts/migration/core/http': {},
        '*/cartridge/scripts/migration/configAccessor': {},
        'dw/crypto/Encoding': {},
        'dw/util/Bytes': function () {},
        '*/cartridge/scripts/migration/core/attrBuilder': {},
        '*/cartridge/scripts/migration/core/attrPreflightRunner': runner,
        '*/cartridge/scripts/migration/core/dataSourceRegistry': { getPlatformId: function () { return platformId; } },
        '*/cartridge/scripts/migration/core/attrIdMapSession': {
            read: function () { return {}; }
        }
    });
    return { checker: checker, calls: calls };
}

describe('orderAttrChecker', function () {
    it('discovers dynamic fields without adding hard-coded Shopify attributes', function () {
        var env = load('shopify');
        env.checker.checkMissingAttributes();

        assert.lengthOf(env.calls.check, 1);
        var args = env.calls.check[0];
        assert.equal(args[0], 'Order');
        assert.deepEqual(args[2]('shopify'), []);
        assert.deepEqual(args[3], {});
    });

    it('adds the commercetools order fields that order.xsd has no element for', function () {
        var env = load('commercetools');
        env.checker.checkMissingAttributes();
        var names = env.calls.check[0][2]('commercetools').map(function (f) { return f.name; });
        assert.includeMembers(names, ['store', 'completedAt', 'anonymousId', 'customerGroup', 'country', 'discountCodes']);
    });

    it('checks line item, address, payment and price adjustment attributes for commercetools', function () {
        var env = load('commercetools');
        var result = env.checker.checkMissingAttributes();

        assert.deepEqual(env.calls.check.map(function (c) { return c[0]; }),
            ['Order', 'ProductLineItem', 'OrderAddress', 'OrderPaymentInstrument', 'PriceAdjustment']);
        var line = result.missing.filter(function (m) { return m.id === 'ProductLineItem-missing'; })[0];
        assert.equal(line.objectType, 'ProductLineItem');
        assert.equal(line.label, 'Line item: X');
        assert.isUndefined(result.missing[0].objectType);
        assert.lengthOf(result.mapped, 5);
    });

    it('keeps the order result when one order part cannot be checked', function () {
        var env = load('commercetools', {
            checkMissing: function (objectType) {
                if (objectType === 'OrderAddress') throw new Error('403');
                return { mapped: [], missing: [{ id: objectType, label: objectType }] };
            }
        });
        var result = env.checker.checkMissingAttributes();
        assert.lengthOf(result.missing, 4);
        assert.include(result.aiMessage, 'Address attributes not checked: 403');
    });

    it('creates each attribute on its object type and returns results in the order sent', function () {
        var env = load('commercetools');
        var result = env.checker.createAttributes([
            { id: 'a' },
            { id: 'b', objectType: 'ProductLineItem' },
            { id: 'c' },
            { id: 'd', objectType: 'OrderAddress' },
            { id: 'e', objectType: 'NotAllowed' }
        ]);

        assert.deepEqual(env.calls.create, [
            { objectType: 'Order', ids: ['a', 'c', 'e'] },
            { objectType: 'ProductLineItem', ids: ['b'] },
            { objectType: 'OrderAddress', ids: ['d'] }
        ]);
        assert.deepEqual(result.results.map(function (r) { return r.id; }), ['a', 'b', 'c', 'd', 'e']);
        assert.equal(result.created, 5);
        assert.lengthOf(result.mappedAttrs, 5);
    });
});
