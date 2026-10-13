'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var path       = require('path');
var proxyquire = require('proxyquire').noCallThru().noPreserveCache();

var dir = path.join(__dirname, '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/customerMigration');
var customerSystem = require(path.join(dir, 'customerSystemProfile.js'));

var transformer = proxyquire(path.join(dir, 'customerTransformer.js'), {
    '*/cartridge/scripts/migration/customerMigration/customerSystemProfile': customerSystem,
    '*/cartridge/scripts/migration/core/attrIdMapSession': { read: function () { return {}; } }
});

/**
 * Load the writer with a CustomerMgr stub that records createCustomer arguments.
 * @param {Array} calls - receives the argument list of each createCustomer call
 * @returns {Object} sfccCustomerWriter
 */
function loadWriter(calls) {
    var noop = function () {};
    return proxyquire(path.join(dir, 'sfccCustomerWriter.js'), {
        'dw/system/Transaction': { begin: noop, commit: noop, rollback: noop },
        'dw/customer/CustomerMgr': {
            getCustomerList: function () { return { ID: 'sf-payment-demo' }; },
            createCustomer: function () {
                var args = Array.prototype.slice.call(arguments);
                calls.push(args);
                return {
                    getProfile: function () {
                        return {
                            customerNo: args.length > 2 ? args[2] : '00001234',
                            custom: {},
                            setEmail: noop,
                            setFirstName: noop,
                            setLastName: noop
                        };
                    }
                };
            }
        },
        '*/cartridge/scripts/migration/customerMigration/customerSystemProfile': customerSystem
    });
}

describe('customer number for partial migration', function () {
    it('uses the commercetools customerNumber, else the commercetools customer ID (same rule as the XML export and orders)', function () {
        var withNo = transformer.transformCustomer({ id: 'ac866650-0000', email: 'a@example.com', customerNumber: 'C-1001' });
        var withoutNo = transformer.transformCustomer({ id: 'ac866650-0000', email: 'a@example.com' });
        assert.equal(withNo.profile.customer_no, 'C-1001');
        assert.equal(withoutNo.profile.customer_no, 'ac866650-0000');
    });

    it('creates the customer with that number as a string', function () {
        var calls = [];
        var result = loadWriter(calls).createCustomer(null, 'sf-payment-demo', { login: 'a@example.com', customer_no: 'ac866650-0000' }, 'Temp#Pass1');
        assert.isTrue(result.ok);
        assert.deepEqual(calls[0], ['a@example.com', 'Temp#Pass1', 'ac866650-0000']);
        assert.equal(result.customerNo, 'ac866650-0000');
    });

    it('lets SFCC generate the number when the source has none, never passing the customer list as the number', function () {
        var calls = [];
        var result = loadWriter(calls).createCustomer(null, 'sf-payment-demo', { login: 'b@example.com' }, 'Temp#Pass1');
        assert.isTrue(result.ok);
        assert.lengthOf(calls[0], 2);
        assert.equal(result.customerNo, '00001234');
    });
});
